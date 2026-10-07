import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
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

/**
 * A signed-in browser. Identity here is the *verified email* on the token, not
 * the uid — that is the whole change these rules are built around, so the
 * fixtures make the distinction explicit and the two are varied independently
 * below (same address on a new uid, same uid with an unverified address).
 */
interface Person {
  uid: string;
  email?: string;
  /** Defaults to true. Set false to model a sign-in method that never proved the address. */
  verified?: boolean;
}

const OWNER: Person = { uid: 'uid-owner', email: 'organiser@example.com' };
/** An admin address (mirrors `isAdmin()` in firestore.rules / src/shared/admins.ts). */
const ADMIN: Person = { uid: 'uid-admin', email: 'jeffreyhuang165@gmail.com' };
/** The same admin address on a token that never proved it. */
const ADMIN_UNVERIFIED: Person = { uid: 'uid-admin-2', email: ADMIN.email, verified: false };
const ALICE: Person = { uid: 'uid-alice', email: 'alice@example.com' };
const BOB: Person = { uid: 'uid-bob', email: 'bob@example.com' };
const DAVE: Person = { uid: 'uid-dave', email: 'dave@example.com' }; // observer, buying side
const CAROL: Person = { uid: 'uid-carol', email: 'carol@example.com' }; // invited, never signed in
const STRANGER: Person = { uid: 'uid-stranger', email: 'nobody@example.com' };

/** Alice from a second laptop: same address, a uid these rules have never seen. */
const ALICE_ELSEWHERE: Person = { uid: 'uid-alice-laptop-2', email: ALICE.email };
/** Alice's address on a token that never proved it. */
const ALICE_UNVERIFIED: Person = { uid: 'uid-alice-fake', email: ALICE.email, verified: false };
/** A session with no address at all — what anonymous sign-in used to produce. */
const ANONYMOUS: Person = { uid: 'uid-anon' };

const ALICE_KEY = 'pk-alice';
const BOB_KEY = 'pk-bob';
const CAROL_KEY = 'pk-carol';
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
 * A started auction with an auctioneer, three seated suppliers (Alice and Bob
 * have signed in, Carol has been invited but never has) and an observer.
 * Written with rules disabled so the fixture itself never depends on the rules
 * under test.
 */
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();

    await setDoc(doc(db, 'auctions', AUCTION), {
      name: 'Rules Fixture',
      config: CONFIG,
      ownerUid: OWNER.uid,
      nextSeq: 10,
      startedAt: nowSec() - 30,
      auctionLength: TOTAL_RUN,
      showResults: false,
      createdAt: nowSec() - 60,
    });

    const people: Array<[string, string, string, string, Person, boolean]> = [
      [OWNER_KEY, 'owner', 'Auctioneer', 'Organiser', OWNER, true],
      [ALICE_KEY, 'bidder', 'Supplier A', 'Alice', ALICE, true],
      [BOB_KEY, 'bidder', 'Supplier B', 'Bob', BOB, true],
      [CAROL_KEY, 'bidder', 'Supplier C', 'Carol', CAROL, false],
      [DAVE_KEY, 'viewer', 'Observer', 'Dave', DAVE, true],
    ];
    for (const [publicKey, role, label, name, person, signedIn] of people) {
      // The public roster slot: nothing identifying, readable by anyone.
      await setDoc(doc(db, 'auctions', AUCTION, 'users', publicKey), {
        publicKey,
        role,
        label,
        colorIndex: 0,
      });
      // Real names live only here — see the anonymity block near the bottom.
      await setDoc(doc(db, 'auctions', AUCTION, 'identities', publicKey), {
        name,
        email: person.email,
      });
      // The seat: what actually admits them, keyed by the invited address.
      await setDoc(doc(db, 'auctions', AUCTION, 'seats', person.email!), {
        publicKey,
        role,
        invitedAt: nowSec() - 120,
        ...(signedIn ? { claimedUid: person.uid, claimedAt: nowSec() - 60 } : {}),
      });
    }

    await setDoc(doc(db, 'auctions', AUCTION, 'events', '9'), {
      seq: 9,
      type: 'startAuction',
      time: nowSec() - 30,
      auctionLength: TOTAL_RUN,
    });
  });
});

/** A Firestore handle acting as `person`, with their address on the token. */
function as(person: Person | null) {
  if (person === null) return env.unauthenticatedContext().firestore();
  const token = person.email
    ? { email: person.email, email_verified: person.verified ?? true }
    : {};
  return env.authenticatedContext(person.uid, token).firestore();
}

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
  const ownerOnly = [
    'setName', 'addUser', 'addLot', 'renameLot', 'startAuction', 'pauseAuction', 'resumeAuction', 'showResults',
  ];

  for (const type of ownerOnly) {
    it(`lets the owner write ${type}`, async () => {
      const db = as(OWNER);
      await assertSucceeds(setDoc(eventRef(db, 10), adminEvent({ type })));
    });

    it(`refuses ${type} from a claimed bidder`, async () => {
      const db = as(ALICE);
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    });

    it(`refuses ${type} from a signed-in stranger`, async () => {
      const db = as(STRANGER);
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    });
  }

  it('refuses an unknown event type even from the owner', async () => {
    const db = as(OWNER);
    await assertFails(setDoc(eventRef(db, 10), adminEvent({ type: 'grantMyselfEverything' })));
  });
});

/**
 * The two admins run every auction. They resolve to the `owner` role straight
 * from their verified address — no seat — and are the only ones who may create
 * an auction, enumerate auctions, or read a participant's stored password.
 */
describe('admins', () => {
  const credentialDoc = (db: ReturnType<typeof as>, key: string) =>
    doc(db, 'auctions', AUCTION, 'credentials', key);

  for (const type of ['setName', 'addUser', 'addLot', 'renameLot', 'startAuction', 'pauseAuction', 'resumeAuction', 'showResults']) {
    it(`lets an admin write ${type} with no seat of their own`, async () => {
      await assertSucceeds(setDoc(eventRef(as(ADMIN), 10), adminEvent({ type })));
    });
  }

  it('lets an admin enumerate auctions; refuses everyone else', async () => {
    await assertSucceeds(getDocs(collection(as(ADMIN), 'auctions')));
    await assertFails(getDocs(collection(as(ALICE), 'auctions')));
    await assertFails(getDocs(collection(as(STRANGER), 'auctions')));
  });

  it('lets an admin create an auction; refuses a non-admin', async () => {
    const fresh = (uid: string) => ({
      name: 'New', config: CONFIG, ownerUid: uid, ownerPublicKey: '0',
      nextSeq: 0, startedAt: null, auctionLength: TOTAL_RUN, showResults: false, createdAt: nowSec(),
    });
    await assertSucceeds(setDoc(doc(as(ADMIN), 'auctions', 'new-a'), fresh(ADMIN.uid)));
    await assertFails(setDoc(doc(as(ALICE), 'auctions', 'new-b'), fresh(ALICE.uid)));
    await assertFails(setDoc(doc(as(STRANGER), 'auctions', 'new-c'), fresh(STRANGER.uid)));
  });

  it('lets only an admin read or write a stored password', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'auctions', AUCTION, 'credentials', ALICE_KEY), {
        email: ALICE.email, password: 'k7m2-q9xh-3rtp-w4nd', preexisting: false, updatedAt: nowSec(),
      });
    });
    await assertSucceeds(getDoc(credentialDoc(as(ADMIN), ALICE_KEY)));
    await assertSucceeds(
      setDoc(credentialDoc(as(ADMIN), BOB_KEY), {
        email: BOB.email, password: 'aaaa-bbbb-cccc-dddd', preexisting: false, updatedAt: nowSec(),
      }),
    );
    // A supplier must never read another's password — nor their own here.
    await assertFails(getDoc(credentialDoc(as(ALICE), ALICE_KEY)));
    await assertFails(getDoc(credentialDoc(as(BOB), ALICE_KEY)));
    await assertFails(getDoc(credentialDoc(as(DAVE), ALICE_KEY)));
    await assertFails(getDoc(credentialDoc(as(STRANGER), ALICE_KEY)));
    await assertFails(getDocs(collection(as(ALICE), 'auctions', AUCTION, 'credentials')));
  });

  it('refuses admin powers to the admin address on an unverified token', async () => {
    await assertFails(setDoc(eventRef(as(ADMIN_UNVERIFIED), 10), adminEvent({ type: 'setName' })));
    await assertFails(getDocs(collection(as(ADMIN_UNVERIFIED), 'auctions')));
    await assertFails(
      getDoc(doc(as(ADMIN_UNVERIFIED), 'auctions', AUCTION, 'credentials', ALICE_KEY)),
    );
  });
});

describe('bidding as yourself', () => {
  it('lets a claimed bidder bid under their own publicKey', async () => {
    const db = as(ALICE);
    await assertSucceeds(setDoc(eventRef(db, 10), bid()));
  });

  /** The core impersonation check: Bob must not be able to bid as Alice. */
  it('refuses a bidder forging a rival publicKey', async () => {
    const db = as(BOB);
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: ALICE_KEY })));
  });

  it('refuses a bid from an unclaimed slot holder', async () => {
    const db = as(STRANGER);
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
    const db = as(ALICE);
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: BOB_KEY, placedBy: OWNER_KEY })));
  });

  it('lets the owner place an on-behalf bid for any supplier', async () => {
    const db = as(OWNER);
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
    await assertSucceeds(setDoc(eventRef(as(ALICE), 10), cancel()));
  });

  it('refuses a supplier withdrawing a bid named as a rival\'s', async () => {
    await assertFails(setDoc(eventRef(as(BOB), 10), cancel({ bidder: ALICE_KEY })));
  });

  it('refuses a cancellation that names nobody', async () => {
    const db = as(ALICE);
    await assertFails(setDoc(eventRef(db, 10), { seq: 10, type: 'cancelBid', bidSeq: 4, time: nowSec() }));
  });

  it('lets the auctioneer withdraw anyone\'s bid', async () => {
    await assertSucceeds(setDoc(eventRef(as(OWNER), 10), cancel({ bidder: BOB_KEY })));
  });

  it('refuses the watching client withdrawing anything', async () => {
    await assertFails(setDoc(eventRef(as(DAVE), 10), cancel({ bidder: DAVE_KEY })));
    await assertFails(setDoc(eventRef(as(DAVE), 10), cancel({ bidder: ALICE_KEY })));
  });

  it('refuses a stranger and an unauthenticated client', async () => {
    await assertFails(setDoc(eventRef(as(STRANGER), 10), cancel()));
    await assertFails(setDoc(eventRef(as(null), 10), cancel()));
  });
});

/** The client on the buying side watches; it never writes. */
describe('the watching client has no control', () => {
  it('refuses every event type from an observer', async () => {
    const db = as(DAVE);
    for (const type of ['setName', 'addUser', 'addLot', 'renameLot', 'startAuction', 'showResults']) {
      await assertFails(setDoc(eventRef(db, 10), adminEvent({ type })));
    }
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: DAVE_KEY })));
    await assertFails(setDoc(eventRef(db, 10), bid({ bidder: ALICE_KEY })));
  });

  it('refuses an observer bumping the shared clock', async () => {
    const db = as(DAVE);
    await assertFails(updateDoc(doc(db, 'auctions', AUCTION), { nextSeq: 11 }));
  });
});

describe('the bidding window', () => {
  it('refuses a bid before the auction has started', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { startedAt: null });
    });
    const db = as(ALICE);
    await assertFails(setDoc(eventRef(db, 10), bid()));
  });

  it('refuses a bid after the clock has run out', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), {
        startedAt: nowSec() - (TOTAL_RUN + 120),
      });
    });
    const db = as(ALICE);
    await assertFails(setDoc(eventRef(db, 10), bid()));
  });

  /**
   * `pausedAt` is mirrored off the pause/resume events, so a paused clock is
   * the one piece of clock arithmetic the rules can hold a hostile bidder to.
   */
  it('refuses a bid while the clock is paused, and takes one again once resumed', async () => {
    const pause = (pausedAt: number | null) =>
      env.withSecurityRulesDisabled(async (ctx) => {
        await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { pausedAt });
      });
    await pause(nowSec() - 5);
    await assertFails(setDoc(eventRef(as(ALICE), 10), bid()));
    await assertFails(setDoc(eventRef(as(OWNER), 10), bid({ bidder: BOB_KEY, placedBy: OWNER_KEY })));
    await pause(null);
    await assertSucceeds(setDoc(eventRef(as(ALICE), 10), bid()));
  });
});

describe('the event log is append-only and gapless', () => {
  it('refuses an event whose seq does not match nextSeq', async () => {
    const db = as(OWNER);
    await assertFails(setDoc(eventRef(db, 11), adminEvent({ seq: 11 })));
    await assertFails(setDoc(eventRef(db, 9), adminEvent({ seq: 9 })));
  });

  it('refuses overwriting an existing event', async () => {
    const db = as(OWNER);
    await assertFails(updateDoc(eventRef(db, 9), { type: 'setName', name: 'rewritten' }));
  });

  it('refuses deleting an event, even by an admin, while the auction is live', async () => {
    await assertFails(deleteDoc(eventRef(as(OWNER), 9)));
    await assertFails(deleteDoc(eventRef(as(ADMIN), 9)));
  });

  it('lets any signed-in member read the log', async () => {
    const db = as(ALICE);
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
    const db = as(ALICE);
    await assertSucceeds(updateDoc(auctionDoc(db), { nextSeq: 11 }));
  });

  it('refuses skipping seq numbers', async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 12 }));
  });

  it('refuses rewinding seq', async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 9 }));
  });

  it('allows an Extended Time clock bump up to threshold - lastCall', async () => {
    const db = as(ALICE);
    await assertSucceeds(
      updateDoc(auctionDoc(db), {
        nextSeq: 11,
        auctionLength: TOTAL_RUN + MAX_CLOCK_BUMP,
      }),
    );
  });

  /** Without this bound a supplier could stall the auction indefinitely. */
  it('refuses a clock bump beyond that bound', async () => {
    const db = as(ALICE);
    await assertFails(
      updateDoc(auctionDoc(db), {
        nextSeq: 11,
        auctionLength: TOTAL_RUN + MAX_CLOCK_BUMP + 1,
      }),
    );
  });

  /** And without this one, a supplier could end the auction for everyone. */
  it('refuses shortening the clock', async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, auctionLength: 0 }));
  });

  it('refuses touching any other field', async () => {
    const db = as(ALICE);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, showResults: true }));
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, ownerUid: ALICE }));
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11, config: { ...CONFIG, lastCallBidders: 12 } }));
  });

  it('refuses the bump from a stranger with no claim', async () => {
    const db = as(STRANGER);
    await assertFails(updateDoc(auctionDoc(db), { nextSeq: 11 }));
  });

  it('refuses the owner rewriting config once the auction has started', async () => {
    const db = as(OWNER);
    await assertFails(
      updateDoc(auctionDoc(db), { config: { ...CONFIG, lastCallBidders: 12 } }),
    );
  });

  it('refuses anyone deleting the auction', async () => {
    await assertFails(deleteDoc(doc(as(OWNER), 'auctions', AUCTION)));
  });
});

describe('a seat is the whole of the access model', () => {
  const seatDoc = (db: ReturnType<typeof as>, email: string) =>
    doc(db, 'auctions', AUCTION, 'seats', email);

  /**
   * The bug this whole change exists to fix. Under the old model a slot was
   * bound to the first browser that opened its invite link, so a supplier who
   * cleared their cookies or reached for a second laptop mid-auction was locked
   * out with no way back in. Their address is their seat now, so they simply
   * sign in again.
   */
  it('lets a supplier bid from a second device under the same address', async () => {
    await assertSucceeds(setDoc(eventRef(as(ALICE_ELSEWHERE), 10), bid()));
  });

  /**
   * A participant's address does NOT have to be verified: their account can
   * only be created by an admin, so the admin is already the authority on which
   * address maps to which seat. (An *admin* address still must be verified —
   * see the `admins` block — because anyone could register one.)
   */
  it('accepts a seated participant on an unverified address', async () => {
    await assertSucceeds(setDoc(eventRef(as(ALICE_UNVERIFIED), 10), bid()));
    await assertSucceeds(
      getDoc(doc(as(ALICE_UNVERIFIED), 'auctions', AUCTION, 'identities', ALICE_KEY)),
    );
  });

  /** Anonymous sessions were the old model's currency; they buy nothing now. */
  it('refuses a signed-in session with no address at all', async () => {
    await assertFails(setDoc(eventRef(as(ANONYMOUS), 10), bid()));
    await assertFails(updateDoc(doc(as(ANONYMOUS), 'auctions', AUCTION), { nextSeq: 11 }));
  });

  /**
   * Revocation has to bite immediately, on whatever device the person is
   * already sitting in front of — an auctioneer removing someone mid-auction
   * cannot wait for a session to expire.
   */
  it('locks someone out the instant their seat is deleted', async () => {
    await assertSucceeds(setDoc(eventRef(as(ALICE), 10), bid()));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'auctions', AUCTION, 'seats', ALICE.email!));
    });
    await assertFails(setDoc(eventRef(as(ALICE), 11), bid({ seq: 11 })));
    await assertFails(getDoc(doc(as(ALICE), 'auctions', AUCTION, 'identities', ALICE_KEY)));
  });

  it('lets only the auctioneer seat and unseat people', async () => {
    const seat = { publicKey: CAROL_KEY, role: 'bidder', invitedAt: nowSec() };
    await assertFails(setDoc(seatDoc(as(ALICE), 'interloper@example.com'), seat));
    await assertFails(setDoc(seatDoc(as(STRANGER), 'interloper@example.com'), seat));
    await assertSucceeds(setDoc(seatDoc(as(OWNER), 'invited@example.com'), seat));

    await assertFails(deleteDoc(seatDoc(as(ALICE), BOB.email!)));
    await assertSucceeds(deleteDoc(seatDoc(as(OWNER), CAROL.email!)));
  });

  /** The escalation to beat: seat yourself, or promote the seat you hold. */
  it('refuses seating yourself, at any role', async () => {
    const db = as(STRANGER);
    for (const role of ['owner', 'bidder', 'viewer']) {
      await assertFails(
        setDoc(seatDoc(db, STRANGER.email!), { publicKey: CAROL_KEY, role, invitedAt: nowSec() }),
      );
    }
  });

  it('refuses a seat carrying an unrecognised role or extra fields', async () => {
    const db = as(OWNER);
    await assertFails(
      setDoc(seatDoc(db, 'x@example.com'), { publicKey: CAROL_KEY, role: 'superuser', invitedAt: nowSec() }),
    );
    await assertFails(
      setDoc(seatDoc(db, 'y@example.com'), {
        publicKey: CAROL_KEY,
        role: 'bidder',
        invitedAt: nowSec(),
        somethingElse: true,
      }),
    );
  });

  /**
   * The seat holder stamps their own arrival so the roster can show who has
   * actually got in — and that is the *only* thing they may write. A supplier
   * who could edit their own seat could promote themselves to auctioneer.
   */
  it('lets a seat holder stamp their sign-in and nothing else', async () => {
    const db = as(CAROL);
    await assertSucceeds(
      updateDoc(seatDoc(db, CAROL.email!), { claimedUid: CAROL.uid, claimedAt: nowSec() }),
    );
    await assertFails(updateDoc(seatDoc(db, CAROL.email!), { role: 'owner' }));
    await assertFails(updateDoc(seatDoc(db, CAROL.email!), { publicKey: OWNER_KEY }));
    await assertFails(
      updateDoc(seatDoc(db, CAROL.email!), { claimedUid: CAROL.uid, claimedAt: nowSec(), role: 'owner' }),
    );
  });

  it('refuses stamping a seat as somebody else\'s uid, or a seat not your own', async () => {
    await assertFails(
      updateDoc(seatDoc(as(CAROL), CAROL.email!), { claimedUid: OWNER.uid, claimedAt: nowSec() }),
    );
    await assertFails(
      updateDoc(seatDoc(as(STRANGER), CAROL.email!), { claimedUid: STRANGER.uid, claimedAt: nowSec() }),
    );
  });

  /**
   * A seat maps an address to a supplier, which is exactly the mapping the
   * auction exists to hide. It is as sensitive as an identity and scoped the
   * same way.
   */
  it('refuses a supplier reading or listing anyone else\'s seat', async () => {
    const db = as(ALICE);
    await assertFails(getDoc(seatDoc(db, BOB.email!)));
    await assertFails(getDocs(collection(db, 'auctions', AUCTION, 'seats')));
    await assertSucceeds(getDoc(seatDoc(db, ALICE.email!)));
  });

  /**
   * Deliberately readable by the address itself rather than by seat holders:
   * someone whose access was revoked still has to be able to establish that
   * fact, rather than seeing an unexplained permission error.
   */
  it('lets a revoked or never-invited address read its own (missing) seat', async () => {
    await assertSucceeds(getDoc(seatDoc(as(STRANGER), STRANGER.email!)));
  });

  it('lets the auctioneer read the whole roster of seats', async () => {
    await assertSucceeds(getDocs(collection(as(OWNER), 'auctions', AUCTION, 'seats')));
  });

  /** A co-auctioneer holds the role through their seat, not through ownerUid. */
  it('treats a seated owner as an auctioneer', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'auctions', AUCTION, 'seats', 'deputy@example.com'), {
        publicKey: OWNER_KEY,
        role: 'owner',
        invitedAt: nowSec(),
      });
    });
    const deputy = as({ uid: 'uid-deputy', email: 'deputy@example.com' });
    await assertSucceeds(setDoc(eventRef(deputy, 10), adminEvent()));
  });
});

describe('the public roster slots', () => {
  const userDoc = (db: ReturnType<typeof as>, key: string) =>
    doc(db, 'auctions', AUCTION, 'users', key);

  it('refuses a non-owner creating a participant slot outright', async () => {
    await assertFails(
      setDoc(userDoc(as(STRANGER), 'pk-selfmade'), {
        publicKey: 'pk-selfmade',
        role: 'bidder',
        label: 'Supplier Z',
        colorIndex: 0,
      }),
    );
  });

  /** Immutable: who occupies a slot is a property of the seat, not of this doc. */
  it('refuses rewriting or deleting a slot, even by the auctioneer', async () => {
    const db = as(OWNER);
    await assertFails(updateDoc(userDoc(db, ALICE_KEY), { role: 'owner' }));
    await assertFails(deleteDoc(userDoc(db, ALICE_KEY)));
  });
});

describe('collections that must never be enumerable', () => {
  it('refuses listing the participant roster to anyone but an admin', async () => {
    await assertFails(getDocs(collection(as(ALICE), 'auctions', AUCTION, 'users')));
    await assertFails(getDocs(collection(as(OWNER), 'auctions', AUCTION, 'users')));
    // An admin dismantling an archived auction has to find every doc.
    await assertSucceeds(getDocs(collection(as(ADMIN), 'auctions', AUCTION, 'users')));
  });

  it('refuses a participant enumerating auctions', async () => {
    const db = as(ALICE);
    await assertFails(getDocs(collection(db, 'auctions')));
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
    const db = as(ALICE);
    await assertFails(getDoc(identityDoc(db, BOB_KEY)));
    await assertFails(getDoc(identityDoc(db, CAROL_KEY)));

    // Releasing results reveals prices, never firms.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { showResults: true });
    });
    await assertFails(getDoc(identityDoc(db, BOB_KEY)));
  });

  it('refuses a supplier enumerating the identities collection', async () => {
    await assertFails(getDocs(collection(as(ALICE), 'auctions', AUCTION, 'identities')));
    await assertFails(getDocs(collection(as(STRANGER), 'auctions', AUCTION, 'identities')));
  });

  it('lets a supplier read their own identity', async () => {
    await assertSucceeds(getDoc(identityDoc(as(ALICE), ALICE_KEY)));
  });

  it('lets the auctioneer and the buying-side observer read every identity', async () => {
    for (const uid of [OWNER, DAVE]) {
      const db = as(uid);
      await assertSucceeds(getDoc(identityDoc(db, ALICE_KEY)));
      await assertSucceeds(getDocs(collection(db, 'auctions', AUCTION, 'identities')));
    }
  });

  it('refuses a stranger with the auction id reading any identity', async () => {
    await assertFails(getDoc(identityDoc(as(STRANGER), ALICE_KEY)));
    await assertFails(getDoc(identityDoc(as(null), ALICE_KEY)));
  });

  it('refuses anyone but the auctioneer creating an identity, and any rewrite', async () => {
    await assertFails(setDoc(identityDoc(as(ALICE), 'pk-new'), { name: 'Forged' }));
    await assertSucceeds(setDoc(identityDoc(as(OWNER), 'pk-new'), { name: 'Legit' }));
    await assertFails(updateDoc(identityDoc(as(OWNER), ALICE_KEY), { name: 'Renamed' }));
    await assertFails(deleteDoc(identityDoc(as(OWNER), ALICE_KEY)));
  });

  it('leaves no name in the slots a supplier *can* read', async () => {
    const snap = await getDoc(slotDoc(as(ALICE), BOB_KEY));
    expect(snap.data()).toMatchObject({ role: 'bidder', label: 'Supplier B' });
    expect(snap.data()!.name).toBeUndefined();
    expect(snap.data()!.email).toBeUndefined();
  });
});

describe('presence heartbeats', () => {
  const beat = (db: ReturnType<typeof as>, uid: string) => doc(db, 'auctions', AUCTION, 'presence', uid);

  it('lets a seated participant heartbeat as their own slot, on server time', async () => {
    await assertSucceeds(setDoc(beat(as(ALICE), ALICE.uid), { publicKey: ALICE_KEY, at: serverTimestamp() }));
    await assertSucceeds(setDoc(beat(as(DAVE), DAVE.uid), { publicKey: DAVE_KEY, at: serverTimestamp() }));
    // A second device is a second doc, same slot.
    await assertSucceeds(
      setDoc(beat(as(ALICE_ELSEWHERE), ALICE_ELSEWHERE.uid), { publicKey: ALICE_KEY, at: serverTimestamp() }),
    );
  });

  it('lets an admin heartbeat with no seat', async () => {
    await assertSucceeds(setDoc(beat(as(ADMIN), ADMIN.uid), { publicKey: OWNER_KEY, at: serverTimestamp() }));
  });

  /** The stamp is what the clock-skew estimate reads, so it must be the server's. */
  it('refuses a client-chosen timestamp', async () => {
    await assertFails(setDoc(beat(as(ALICE), ALICE.uid), { publicKey: ALICE_KEY, at: new Date() }));
    await assertFails(setDoc(beat(as(ALICE), ALICE.uid), { publicKey: ALICE_KEY, at: nowSec() }));
  });

  it('refuses heartbeating as a rival slot, under another uid, or with extra fields', async () => {
    await assertFails(setDoc(beat(as(ALICE), ALICE.uid), { publicKey: BOB_KEY, at: serverTimestamp() }));
    await assertFails(setDoc(beat(as(ALICE), BOB.uid), { publicKey: ALICE_KEY, at: serverTimestamp() }));
    await assertFails(
      setDoc(beat(as(ALICE), ALICE.uid), { publicKey: ALICE_KEY, at: serverTimestamp(), name: 'Alice' }),
    );
  });

  it('refuses a stranger and an unauthenticated client', async () => {
    await assertFails(setDoc(beat(as(STRANGER), STRANGER.uid), { publicKey: ALICE_KEY, at: serverTimestamp() }));
    await assertFails(setDoc(beat(as(null), 'anyone'), { publicKey: ALICE_KEY, at: serverTimestamp() }));
  });

  /** Who is online is the auctioneer's view; a supplier gets only their own doc. */
  it('lets only the auctioneer list heartbeats', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(beat(ctx.firestore(), ALICE.uid), { publicKey: ALICE_KEY, at: new Date() });
      await setDoc(beat(ctx.firestore(), BOB.uid), { publicKey: BOB_KEY, at: new Date() });
    });
    await assertSucceeds(getDocs(collection(as(OWNER), 'auctions', AUCTION, 'presence')));
    await assertSucceeds(getDocs(collection(as(ADMIN), 'auctions', AUCTION, 'presence')));
    await assertFails(getDocs(collection(as(ALICE), 'auctions', AUCTION, 'presence')));
    await assertFails(getDocs(collection(as(DAVE), 'auctions', AUCTION, 'presence')));
    await assertSucceeds(getDoc(beat(as(ALICE), ALICE.uid)));
    await assertFails(getDoc(beat(as(ALICE), BOB.uid)));
  });

  it('lets a participant clear their own heartbeat and nobody else\'s', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(beat(ctx.firestore(), ALICE.uid), { publicKey: ALICE_KEY, at: new Date() });
      await setDoc(beat(ctx.firestore(), BOB.uid), { publicKey: BOB_KEY, at: new Date() });
    });
    await assertFails(deleteDoc(beat(as(ALICE), BOB.uid)));
    await assertSucceeds(deleteDoc(beat(as(ALICE), ALICE.uid)));
  });
});

/**
 * The one exception to append-only. An auction has to be *archived* first — a
 * flag on its doc — and then an admin may take it apart, subcollection by
 * subcollection, since Firestore has no recursive delete. Nobody else may,
 * and nothing in a live auction may be deleted by anyone.
 */
describe('archiving and deleting an auction', () => {
  const auctionDoc = (db: ReturnType<typeof as>) => doc(db, 'auctions', AUCTION);
  const archive = () =>
    env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'auctions', AUCTION), { archived: true });
    });
  /**
   * One doc from each subcollection that is otherwise immutable. Seats and
   * credentials are not here: an auctioneer deleting a seat is how access is
   * revoked, and credentials are admin-writable by design, so those two need
   * nothing new from the rules to be cleared.
   */
  const pieces = (db: ReturnType<typeof as>) => [
    eventRef(db, 9),
    doc(db, 'auctions', AUCTION, 'users', ALICE_KEY),
    doc(db, 'auctions', AUCTION, 'identities', ALICE_KEY),
    doc(db, 'auctions', AUCTION, 'presence', 'uid-someone-else'),
  ];

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'auctions', AUCTION, 'presence', 'uid-someone-else'), {
        publicKey: BOB_KEY,
        at: serverTimestamp(),
      });
    });
  });

  it('lets an owner archive and restore; refuses a supplier and the client', async () => {
    await assertSucceeds(updateDoc(auctionDoc(as(OWNER)), { archived: true }));
    await assertSucceeds(updateDoc(auctionDoc(as(ADMIN)), { archived: false }));
    await assertFails(updateDoc(auctionDoc(as(ALICE)), { archived: true }));
    await assertFails(updateDoc(auctionDoc(as(DAVE)), { archived: true }));
  });

  it('refuses deleting any part of a live auction, admin included', async () => {
    for (const ref of pieces(as(ADMIN))) await assertFails(deleteDoc(ref));
    await assertFails(deleteDoc(auctionDoc(as(ADMIN))));
  });

  it('lets only an admin dismantle an archived auction', async () => {
    await archive();
    // Still not a seated auctioneer's, a supplier's, or a stranger's to delete.
    for (const who of [OWNER, ALICE, DAVE, STRANGER, ADMIN_UNVERIFIED]) {
      await assertFails(deleteDoc(eventRef(as(who), 9)));
      await assertFails(deleteDoc(auctionDoc(as(who))));
    }
    for (const ref of pieces(as(ADMIN))) await assertSucceeds(deleteDoc(ref));
    await assertSucceeds(deleteDoc(auctionDoc(as(ADMIN))));
  });

  it('still refuses overwriting an archived auction\'s events', async () => {
    await archive();
    await assertFails(updateDoc(eventRef(as(ADMIN), 9), { auctionLength: 1 }));
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
    const db = as(STRANGER);
    const snap = await getDocs(collection(db, 'auctions', AUCTION, 'events'));
    expect(snap.empty).toBe(false);
  });
});
