import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Tests for `firestore.rules` — the only layer in this app that a participant
 * cannot bypass. `validateInbound` is covered thoroughly elsewhere, but an
 * attacker never calls it: they write to Firestore directly. So everything
 * asserted here is phrased as "what can a hostile client get past the rules",
 * and each block corresponds to a claim the rules file makes in its own header.
 *
 * Requires the Firestore emulator. Run via `npm run test:rules`, which starts
 * and stops one automatically.
 */

const PROJECT_ID = 'carbonless-auction';
const AUCTION = 'a1';

const OWNER_UID = 'uid-owner';
const ALICE_UID = 'uid-alice';
const BOB_UID = 'uid-bob';
const DAVE_UID = 'uid-dave'; // an observer on the buying side
const STRANGER_UID = 'uid-stranger';

const ALICE_KEY = 'pk-alice';
const BOB_KEY = 'pk-bob';
const CAROL_KEY = 'pk-carol'; // invited, never claimed
const DAVE_KEY = 'pk-dave';
const OWNER_KEY = 'pk-owner';
const LOT = 'lot-0';

/** Mirrors DEFAULT_CONFIG. The auctionLength bound in the rules is derived from these. */
const CONFIG = {
  bidDirection: 'reverse',
  auctionLengthSec: 300,
  extendedTimeThresholdSec: 90,
  lastCallSec: 60,
  lastCallBidders: 2,
  minBidStep: 0,
};

/** The whole run the stored clock counts down: bidding clock plus Last Call. */
const TOTAL_RUN = CONFIG.auctionLengthSec + CONFIG.lastCallSec;

/**
 * Extended Time can push the clock out by at most this much, per the rules —
 * the threshold itself, since it is a mark on the main clock.
 */
const MAX_CLOCK_BUMP = CONFIG.extendedTimeThresholdSec;

let env: RulesTestEnvironment;

/** Seconds, as the client stores them — the rules compare request.time against this. */
const nowSec = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

/**
 * A started auction with an owner, two claimed bidders (Alice, Bob) and one
 * invited-but-unclaimed slot (Carol). Written with rules disabled so that the
 * fixture itself never depends on the rules under test.
 */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'auctions', AUCTION), {
      name: 'Rules Fixture',
      config: CONFIG,
      ownerUid: OWNER_UID,
      nextSeq: 10,
      startedAt: nowSec() - 30,
      auctionLength: TOTAL_RUN,
      showResults: false,
      createdAt: nowSec() - 60,
    });

    const people: Array<[string, string, string, string, string | null]> = [
      [OWNER_KEY, 'owner', 'Auctioneer', 'Organiser', OWNER_UID],
      [ALICE_KEY, 'bidder', 'Supplier A', 'Alice', ALICE_UID],
      [BOB_KEY, 'bidder', 'Supplier B', 'Bob', BOB_UID],
      [CAROL_KEY, 'bidder', 'Supplier C', 'Carol', null],
      [DAVE_KEY, 'viewer', 'Observer', 'Dave', DAVE_UID],
    ];
    for (const [publicKey, role, label, name, claimUid] of people) {
      await setDoc(doc(db, 'auctions', AUCTION, 'users', publicKey), {
        publicKey,
        role,
        label,
        colorIndex: 0,
        claimUid,
        claimInviteId: null,
      });
      // Real names live only here — see the anonymity block near the bottom.
      await setDoc(doc(db, 'auctions', AUCTION, 'identities', publicKey), {
        name,
        email: `${name.toLowerCase()}@example.com`,
      });
      if (claimUid) {
        await setDoc(doc(db, 'auctions', AUCTION, 'claims', claimUid), { publicKey, role });
      }
      await setDoc(doc(db, 'auctions', AUCTION, 'invites', 'invite-' + publicKey), { publicKey });
    }

    await setDoc(doc(db, 'auctions', AUCTION, 'events', '9'), {
      seq: 9,
      type: 'startAuction',
      time: nowSec() - 30,
      auctionLength: TOTAL_RUN,
    });
  });
});

const as = (uid: string | null) =>
  (uid === null ? env.unauthenticatedContext() : env.authenticatedContext(uid)).firestore();

const eventRef = (db: ReturnType<typeof as>, seq: number) =>
  doc(db, 'auctions', AUCTION, 'events', String(seq));

const bid = (over: Record<string, unknown> = {}) => ({
  seq: 10,
  type: 'placeBid',
  lotId: LOT,
  bidder: ALICE_KEY,
  value: 0.07,
  time: nowSec(),
  ...over,
});

const adminEvent = (over: Record<string, unknown> = {}) => ({
  seq: 10,
  type: 'showResults',
  time: nowSec(),
  ...over,
});

describe('admin events are owner-only', () => {
  // `cancelBid` is deliberately not here: a supplier may withdraw a bid of
  // their own, which the block below covers on its own terms.
  const ownerOnly = ['setName', 'addUser', 'addLot', 'renameLot', 'startAuction', 'showResults'];

  for (const type of ownerOnly) {
    it(`lets the owner write ${type}`, async () => {
      const db = as(OWNER_UID);
      await assertSucceeds(setDoc(eventRef(db, 10), adminEvent({ type })));
    });

    it(`refuses ${type} from a claimed bidder`, async () => {
      const db = as(ALICE_UID);
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    });

    it(`refuses ${type} from a signed-in stranger`, async () => {
      const db = as(STRANGER_UID);
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    });
  }

  it('refuses an unknown event type even from the owner', async () => {
    const db = as(OWNER_UID);
    await assertFails(setDoc(eventRef(db, 10), adminEvent({ type: 'grantMyselfEverything' })));
  });
});

describe('bidding as yourself', () => {
  it('lets a claimed bidder bid under their own publicKey', async () => {
    const db = as(ALICE_UID);
    await assertSucceeds(setDoc(eventRef(db, 10), bid()));
  });

  /** The core impersonation check: Bob must not be able to bid as Alice. */
  it('refuses a bidder forging a rival publicKey', async () => {
    const db = as(BOB_UID);
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: ALICE_KEY })));
  });

  it('refuses a bid from an unclaimed slot holder', async () => {
    const db = as(STRANGER_UID);
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: CAROL_KEY })));
  });

  it('refuses a bid from an unauthenticated client', async () => {
    const db = as(null);
    await assertFails(setDoc(eventRef(db, 10), bid()));
  });

  /**
   * `placedBy` is what marks a bid as the auctioneer acting for a supplier. A
   * bidder who could set it would bypass the as-self publicKey check entirely.
   */
  it('refuses a bidder who sets placedBy to masquerade as an on-behalf bid', async () => {
    const db = as(ALICE_UID);
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: BOB_KEY, placedBy: OWNER_KEY })));
  });

  it('lets the owner place an on-behalf bid for any supplier', async () => {
    const db = as(OWNER_UID);
    await assertSucceeds(setDoc(eventRef(db, 10), bid({ bidder: BOB_KEY, placedBy: OWNER_KEY })));
  });
});

/**
 * Withdrawing a bid. Suppliers mistype bids and sometimes wreck an auction on
 * purpose, so both the supplier and the auctioneer can take one back — but a
 * supplier only their own. The rules cannot follow `bidSeq` to the bid it
 * points at, so they hold a supplier to cancellations that *name* them; the
 * shared fold then ignores any cancellation whose named bidder is not the
 * target bid's actual bidder (covered in `tests/validation.test.ts`).
 */
describe('withdrawing a bid', () => {
  const cancel = (over: Record<string, unknown> = {}) => ({
    seq: 10,
    type: 'cancelBid',
    bidSeq: 4,
    bidder: ALICE_KEY,
    time: nowSec(),
    ...over,
  });

  it('lets a supplier withdraw a bid of their own', async () => {
    await assertSucceeds(setDoc(eventRef(as(ALICE_UID), 10), cancel()));
  });

  it('refuses a supplier withdrawing a bid named as a rival\'s', async () => {
    await assertFails(setDoc(eventRef(as(BOB_UID), 10), cancel({ bidder: ALICE_KEY })));
  });

  it('refuses a cancellation that names nobody', async () => {
    const db = as(ALICE_UID);
    await assertFails(setDoc(eventRef(db, 10), { seq: 10, type: 'cancelBid', bidSeq: 4, time: nowSec() }));
  });

  it('lets the auctioneer withdraw anyone\'s bid', async () => {
    await assertSucceeds(setDoc(eventRef(as(OWNER_UID), 10), cancel({ bidder: BOB_KEY })));
  });

  it('refuses the watching client withdrawing anything', async () => {
    await assertFails(setDoc(eventRef(as(DAVE_UID), 10), cancel({ bidder: DAVE_KEY })));
    await assertFails(setDoc(eventRef(as(DAVE_UID), 10), cancel({ bidder: ALICE_KEY })));
  });

  it('refuses a stranger and an unauthenticated client', async () => {
    await assertFails(setDoc(eventRef(as(STRANGER_UID), 10), cancel()));
    await assertFails(setDoc(eventRef(as(null), 10), cancel()));
  });
});

/** The client on the buying side watches; it never writes. */
describe('the watching client has no control', () => {
  it('refuses every event type from an observer', async () => {
    const db = as(DAVE_UID);
    for (const type of ['setName', 'addUser', 'addLot', 'renameLot', 'startAuction', 'showResults']) {
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    }
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: DAVE_KEY })));
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: ALICE_KEY })));
  });

  it('refuses an observer bumping the shared clock', async () => {
    const db = as(DAVE_UID);
    await assertFails(updateDoc(doc(db, 'auctions', AUCTION), { nextSeq: 11 }));
  });
});

describe('the bidding window', () => {
  it('refuses a bid before the auction has started', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { startedAt: null });
    });
    const db = as(ALICE_UID);
    await assertFails(setDoc(eventRef(db, 10), bid()));
  });

  it('refuses a bid after the clock has run out', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), {
        startedAt: nowSec() - (TOTAL_RUN + 120),
      });
    });
    const db = as(ALICE_UID);
    await assertFails(setDoc(eventRef(db, 10), bid()));
  });
});

describe('the event log is append-only and gapless', () => {
  it('refuses an event whose seq does not match nextSeq', async () => {
    const db = as(OWNER_UID);
    await assertFails(setDoc(eventRef(db, 11), adminEvent({ seq: 11 })));
    await assertFails(setDoc(eventRef(db, 9), adminEvent({ seq: 9 })));
  });

  it('refuses overwriting an existing event', async () => {
    const db = as(OWNER_UID);
    await assertFails(updateDoc(eventRef(db, 9), { type: 'setName', name: 'rewritten' }));
  });

  it('refuses deleting an event', async () => {
    const db = as(OWNER_UID);
    await assertFails(deleteDoc(eventRef(db, 9)));
  });

  it('lets any signed-in member read the log', async () => {
    const db = as(ALICE_UID);
    await assertSucceeds(getDocs(collection(db, 'auctions', AUCTION, 'events')));
  });
});

/**
 * A bidder's own bid write has to bump the auction doc's `nextSeq` in the same
 * commit, which means the rules must let a bidder write that doc at all. These
 * assertions pin down how far that concession goes.
 */
describe('the auction doc bump a bidder is allowed alongside a bid', () => {
  const auctionDoc = (db: ReturnType<typeof as>) => doc(db, 'auctions', AUCTION);

  it('allows exactly nextSeq + 1', async () => {
    const db = as(ALICE_UID);
    await assertSucceeds(updateDoc(auctionDoc(db), { nextSeq: 11 }));
  });

  it('refuses skipping seq numbers', async () => {
    const db = as(ALICE_UID);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 12 }));
  });

  it('refuses rewinding seq', async () => {
    const db = as(ALICE_UID);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 9 }));
  });

  it('allows an Extended Time clock bump up to threshold - lastCall', async () => {
    const db = as(ALICE_UID);
    await assertSucceeds(
      updateDoc(auctionDoc(db), {
        nextSeq: 11,
        auctionLength: TOTAL_RUN + MAX_CLOCK_BUMP,
      }),
    );
  });

  /** Without this bound a supplier could stall the auction indefinitely. */
  it('refuses a clock bump beyond that bound', async () => {
    const db = as(ALICE_UID);
    await assertFails(
      updateDoc(auctionDoc(db), {
        nextSeq: 11,
        auctionLength: TOTAL_RUN + MAX_CLOCK_BUMP + 1,
      }),
    );
  });

  /** And without this one, a supplier could end the auction for everyone. */
  it('refuses shortening the clock', async () => {
    const db = as(ALICE_UID);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, auctionLength: 0 }));
  });

  it('refuses touching any other field', async () => {
    const db = as(ALICE_UID);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, showResults: true }));
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, ownerUid: ALICE_UID }));
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, config: { ...CONFIG, lastCallBidders: 12 } }));
  });

  it('refuses the bump from a stranger with no claim', async () => {
    const db = as(STRANGER_UID);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11 }));
  });

  it('refuses the owner rewriting config once the auction has started', async () => {
    const db = as(OWNER_UID);
    await assertFails(
      updateDoc(auctionDoc(db), { config: { ...CONFIG, lastCallBidders: 12 } }),
    );
  });

  it('refuses anyone deleting the auction', async () => {
    await assertFails(deleteDoc(doc(as(OWNER_UID), 'auctions', AUCTION)));
  });
});

describe('claiming an invited slot is write-once', () => {
  const userDoc = (db: ReturnType<typeof as>, key: string) =>
    doc(db, 'auctions', AUCTION, 'users', key);

  it('lets a new browser claim the unclaimed slot with a matching invite', async () => {
    const db = as(STRANGER_UID);
    await assertSucceeds(
      updateDoc(userDoc(db, CAROL_KEY), {
        claimUid: STRANGER_UID,
        claimInviteId: 'invite-' + CAROL_KEY,
      }),
    );
  });

  it('refuses claiming a slot that is already bound to someone else', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      updateDoc(userDoc(db, ALICE_KEY), {
        claimUid: STRANGER_UID,
        claimInviteId: 'invite-' + ALICE_KEY,
      }),
    );
  });

  /** An invite is a capability for one specific slot, not a generic key. */
  it('refuses an invite that belongs to a different slot', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      updateDoc(userDoc(db, CAROL_KEY), {
        claimUid: STRANGER_UID,
        claimInviteId: 'invite-' + BOB_KEY,
      }),
    );
  });

  it('refuses a claim with a fabricated invite id', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      updateDoc(userDoc(db, CAROL_KEY), { claimUid: STRANGER_UID, claimInviteId: 'made-up' }),
    );
  });

  it('refuses binding a slot to a uid other than your own', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      updateDoc(userDoc(db, CAROL_KEY), {
        claimUid: BOB_UID,
        claimInviteId: 'invite-' + CAROL_KEY,
      }),
    );
  });

  it('refuses smuggling a role change through the claim', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      updateDoc(userDoc(db, CAROL_KEY), {
        claimUid: STRANGER_UID,
        claimInviteId: 'invite-' + CAROL_KEY,
        role: 'owner',
      }),
    );
  });

  it('refuses a non-owner creating a participant slot outright', async () => {
    const db = as(STRANGER_UID);
    await assertFails(
      setDoc(userDoc(db, 'pk-selfmade'), {
        publicKey: 'pk-selfmade',
        role: 'bidder',
        name: 'Interloper',
        claimUid: null,
        claimInviteId: null,
      }),
    );
  });
});

describe('the uid -> role claims mirror', () => {
  const claimDoc = (db: ReturnType<typeof as>, uid: string) =>
    doc(db, 'auctions', AUCTION, 'claims', uid);

  it('refuses a claim doc whose user doc does not name that uid', async () => {
    const db = as(STRANGER_UID);
    await assertFails(setDoc(claimDoc(db, STRANGER_UID), { publicKey: CAROL_KEY, role: 'bidder' }));
  });

  /** A fresh uid, so this is the uid check failing and not the create-once one. */
  it('refuses writing a claim doc under another uid', async () => {
    const db = as(STRANGER_UID);
    await assertFails(setDoc(claimDoc(db, 'uid-nobody'), { publicKey: CAROL_KEY, role: 'bidder' }));
  });

  /** Role escalation: claim the slot legitimately, then declare yourself owner. */
  it('refuses a role that disagrees with the user doc', async () => {
    const db = as(STRANGER_UID);
    await assertSucceeds(
      updateDoc(doc(db, 'auctions', AUCTION, 'users', CAROL_KEY), {
        claimUid: STRANGER_UID,
        claimInviteId: 'invite-' + CAROL_KEY,
      }),
    );
    await assertFails(setDoc(claimDoc(db, STRANGER_UID), { publicKey: CAROL_KEY, role: 'owner' }));
    await assertSucceeds(setDoc(claimDoc(db, STRANGER_UID), { publicKey: CAROL_KEY, role: 'bidder' }));
  });

  it('refuses overwriting an existing claim', async () => {
    const db = as(ALICE_UID);
    await assertFails(updateDoc(claimDoc(db, ALICE_UID), { role: 'owner' }));
  });

  it('refuses reading someone else\'s claim', async () => {
    const db = as(ALICE_UID);
    await assertFails(getDoc(claimDoc(db, BOB_UID)));
    await assertSucceeds(getDoc(claimDoc(db, ALICE_UID)));
  });
});

describe('collections that must never be enumerable', () => {
  /**
   * Invite ids are bearer secrets, so listing the collection would hand out
   * every slot at once. Same for the auction collection and the roster.
   */
  it('refuses listing invites, while allowing a direct get', async () => {
    const db = as(ALICE_UID);
    await assertFails(getDocs(collection(db, 'auctions', AUCTION, 'invites')));
    await assertSucceeds(getDoc(doc(db, 'auctions', AUCTION, 'invites', 'invite-' + CAROL_KEY)));
  });

  it('refuses listing the participant roster', async () => {
    const db = as(ALICE_UID);
    await assertFails(getDocs(collection(db, 'auctions', AUCTION, 'users')));
  });

  it('refuses enumerating auctions', async () => {
    const db = as(ALICE_UID);
    await assertFails(getDocs(collection(db, 'auctions')));
  });

  it('refuses a non-owner minting an invite', async () => {
    const db = as(ALICE_UID);
    await assertFails(setDoc(doc(db, 'auctions', AUCTION, 'invites', 'forged'), { publicKey: CAROL_KEY }));
  });

  it('refuses rewriting or deleting an existing invite', async () => {
    const db = as(OWNER_UID);
    const ref = doc(db, 'auctions', AUCTION, 'invites', 'invite-' + CAROL_KEY);
    await assertFails(updateDoc(ref, { publicKey: ALICE_KEY }));
    await assertFails(deleteDoc(ref));
  });
});

/**
 * The auction's central promise to a supplier: they may learn where their
 * price stands in the market, and nothing whatever about *whose* prices those
 * are. Unlike the blind Last Call window, this one is not cosmetic — names are
 * kept out of the event log entirely and put behind this rule, so a hostile
 * client reading Firestore directly gets no further than a well-behaved one.
 */
describe('supplier anonymity', () => {
  const identityDoc = (db: ReturnType<typeof as>, publicKey: string) =>
    doc(db, 'auctions', AUCTION, 'identities', publicKey);
  const slotDoc = (db: ReturnType<typeof as>, publicKey: string) =>
    doc(db, 'auctions', AUCTION, 'users', publicKey);

  it('refuses a supplier reading a rival identity, before or after results', async () => {
    const db = as(ALICE_UID);
    await assertFails(getDoc(identityDoc(db, BOB_KEY)));
    await assertFails(getDoc(identityDoc(db, CAROL_KEY)));

    // Releasing results reveals prices, never firms.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { showResults: true });
    });
    await assertFails(getDoc(identityDoc(db, BOB_KEY)));
  });

  it('refuses a supplier enumerating the identities collection', async () => {
    await assertFails(getDocs(collection(as(ALICE_UID), 'auctions', AUCTION, 'identities')));
    await assertFails(getDocs(collection(as(STRANGER_UID), 'auctions', AUCTION, 'identities')));
  });

  it('lets a supplier read their own identity', async () => {
    await assertSucceeds(getDoc(identityDoc(as(ALICE_UID), ALICE_KEY)));
  });

  it('lets the auctioneer and the buying-side observer read every identity', async () => {
    for (const uid of [OWNER_UID, DAVE_UID]) {
      const db = as(uid);
      await assertSucceeds(getDoc(identityDoc(db, ALICE_KEY)));
      await assertSucceeds(getDocs(collection(db, 'auctions', AUCTION, 'identities')));
    }
  });

  it('refuses a stranger with the auction id reading any identity', async () => {
    await assertFails(getDoc(identityDoc(as(STRANGER_UID), ALICE_KEY)));
    await assertFails(getDoc(identityDoc(as(null), ALICE_KEY)));
  });

  it('refuses anyone but the auctioneer creating an identity, and any rewrite', async () => {
    await assertFails(setDoc(identityDoc(as(ALICE_UID), 'pk-new'), { name: 'Forged' }));
    await assertSucceeds(setDoc(identityDoc(as(OWNER_UID), 'pk-new'), { name: 'Legit' }));
    await assertFails(updateDoc(identityDoc(as(OWNER_UID), ALICE_KEY), { name: 'Renamed' }));
    await assertFails(deleteDoc(identityDoc(as(OWNER_UID), ALICE_KEY)));
  });

  it('leaves no name in the slots a supplier *can* read', async () => {
    const snap = await getDoc(slotDoc(as(ALICE_UID), BOB_KEY));
    expect(snap.data()).toMatchObject({ role: 'bidder', label: 'Supplier B' });
    expect(snap.data()!.name).toBeUndefined();
    expect(snap.data()!.email).toBeUndefined();
  });
});

describe('unauthenticated clients', () => {
  it('cannot read or write anything', async () => {
    const db = as(null);
    await assertFails(getDoc(doc(db, 'auctions', AUCTION)));
    await assertFails(getDocs(collection(db, 'auctions', AUCTION, 'events')));
    await assertFails(setDoc(eventRef(db, 10), adminEvent()));
  });
});

/**
 * Not a rule test — a standing reminder of the accepted gap. Any signed-in
 * client holding the auction id can read the whole log, which is what makes
 * the blind Last Call window cosmetic rather than enforced. Anonymity is no
 * longer in that category: the log is readable, but it contains no names to
 * read (see "supplier anonymity" above). If this ever starts failing, the
 * rules gained per-role read scoping and the notes should be updated to match.
 */
describe('known limitation: the log is readable by any signed-in client', () => {
  it('lets a stranger with the auction id read every bid', async () => {
    const db = as(STRANGER_UID);
    const snap = await getDocs(collection(db, 'auctions', AUCTION, 'events'));
    expect(snap.empty).toBe(false);
  });
});
