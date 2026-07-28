import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import { currentUser, normalizeEmail, sendSignInLink } from './auth';
import { AuctionAggregate, type Participant } from '../shared/aggregate';
import { configSchema } from '../shared/config';
import { totalRunSec } from '../shared/rules';
import { parseInboundEvent } from '../shared/schemas';
import { filterOutbound, validateInbound } from '../shared/validation';
import type { AddUserInput, AuctionConfig, AuctionEvent, AuctionMeta, InboundEventInput, Role, UserView } from '../shared/types';

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** One row of the auctioneer's roster — see {@link Connection.roster}. */
export interface RosterEntry {
  publicKey: string;
  /** The real firm/person name. Never leaves an auctioneer's or observer's screen. */
  name: string;
  /** What every other supplier sees instead: "Supplier B". */
  label: string;
  role: Role;
  colorIndex: number;
  /** The invited address, or null if the seat has been revoked. */
  email: string | null;
  /** When they first signed in, or null if they never have. */
  signedInAt: number | null;
  isYou: boolean;
}

/**
 * Firestore document shapes. `auctions/{id}` carries a handful of fields
 * *mirrored* off the event log (name, startedAt, auctionLength, showResults)
 * purely so `firestore.rules` — which cannot fold the log — can do coarse
 * enforcement (time windows, owner-only gates) without reading every event.
 * The client itself always derives truth by folding `events` via
 * `AuctionAggregate.replay`, exactly as before.
 */
interface AuctionDocData {
  name: string;
  config: AuctionConfig;
  ownerUid: string;
  nextSeq: number;
  startedAt: number | null;
  auctionLength: number;
  showResults: boolean;
}

/**
 * `auctions/{id}/users/{publicKey}` — the public roster slot. Deliberately
 * holds *no* identifying data: any signed-in client can read it (a viewer
 * resolves their own slot here before anything else is known about them), so a
 * supplier's firm cannot live here. Only the label and colour a rival is
 * allowed to see. Who occupies the slot is a property of the seat, below.
 */
interface UserDocData {
  publicKey: string;
  role: Role;
  label: string;
  colorIndex: number;
}

/**
 * `auctions/{id}/seats/{email}` — the access-control table, keyed by the
 * address the auctioneer invited. A signed-in client's verified email is
 * matched straight against this document id, which is what lets
 * `firestore.rules` decide a caller's role without any secret in a URL.
 *
 * `claimedUid`/`claimedAt` are stamped by the seat holder on their first
 * successful sign-in, purely so the auctioneer's roster can tell "invited"
 * apart from "has actually got in".
 */
interface SeatDocData {
  publicKey: string;
  role: Role;
  invitedAt: number;
  claimedUid?: string;
  claimedAt?: number;
}

/**
 * `auctions/{id}/identities/{publicKey}` — the only place a real name or email
 * exists. `firestore.rules` scopes it to the auctioneer, observers, and the
 * participant themselves, so a supplier cannot read one even by talking to
 * Firestore directly. This, not the render-time filter, is what actually keeps
 * bidders from learning who they are bidding against.
 */
interface IdentityDocData {
  name: string;
  email?: string;
}

const auctionRef = (id: string) => doc(db, 'auctions', id);
const eventsCol = (id: string) => collection(db, 'auctions', id, 'events');
const eventRef = (id: string, seq: number) => doc(db, 'auctions', id, 'events', String(seq).padStart(10, '0'));
const userRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'users', publicKey);
const identitiesCol = (id: string) => collection(db, 'auctions', id, 'identities');
const identityRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'identities', publicKey);
const seatsCol = (id: string) => collection(db, 'auctions', id, 'seats');
const seatRef = (id: string, email: string) => doc(db, 'auctions', id, 'seats', normalizeEmail(email));

/** Random bytes, hex-encoded — used for unguessable auction ids. */
function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The page a sign-in link should return someone to. */
export function auctionUrl(auctionId: string): string {
  return `${location.origin}/a/${auctionId}`;
}

/** Raised when an operation needs a signed-in, email-verified user and has none. */
export class NotSignedInError extends Error {
  constructor() {
    super('Sign in with your email address to continue.');
    this.name = 'NotSignedInError';
  }
}

/**
 * The signed-in user, insisting on a *verified* address. Everything downstream
 * — the seat lookup, every rule in `firestore.rules` — keys off that address,
 * so a session without one cannot be allowed to proceed as if it had a claim
 * to anything.
 */
async function requireVerifiedUser(): Promise<User & { email: string }> {
  const user = await currentUser();
  if (!user || !user.email || !user.emailVerified) throw new NotSignedInError();
  return user as User & { email: string };
}

/** Fields to mirror onto `auctions/{id}` alongside a newly appended event, for rules' benefit. */
function mirrorUpdate(event: AuctionEvent): Record<string, unknown> {
  switch (event.type) {
    case 'setName':
      return { name: event.name };
    case 'startAuction':
      return { startedAt: event.time, auctionLength: event.auctionLength };
    case 'showResults':
      return { showResults: true };
    case 'placeBid':
      // Extended Time pushes the clock out; mirror it so the rules' time-window check stays accurate.
      return event.auctionLength === undefined ? {} : { auctionLength: event.auctionLength };
    default:
      return {};
  }
}

export interface CreateAuctionInput {
  name: string;
  ownerName: string;
  config: AuctionConfig;
  /** Contract terms to open the board with, e.g. ['12 Months', '24 Months']. */
  lots: string[];
}

/**
 * Creates a new auction: the auction doc first (so `ownerUid` exists for
 * `isOwner()` rule checks), then the bootstrap `setName`/`addUser` events and
 * the owner's own user doc and seat.
 *
 * The creator must already be signed in, because the auctioneer is a
 * participant like any other — their seat is what gets them back into their own
 * auction from a second device, and what makes "auctioneer" a role someone
 * holds rather than a browser that happens to remember something.
 */
export async function createAuction(input: CreateAuctionInput): Promise<ApiResult & { id?: string }> {
  try {
    const user = await requireVerifiedUser();
    const id = randomId(6);
    const aRef = auctionRef(id);

    await setDoc(aRef, {
      name: input.name,
      config: input.config,
      ownerUid: user.uid,
      nextSeq: 0,
      startedAt: null,
      auctionLength: totalRunSec(input.config),
      showResults: false,
      createdAt: serverTimestamp(),
    });

    const system: Participant = { publicKey: '__system__', role: 'owner' };
    const agg = new AuctionAggregate(id, input.config);

    // Two sequential transactions, not one: the events rule's `seq ==
    // auction().nextSeq` check reads the auction doc via get(), which reflects
    // the state at the start of the transaction, not a sibling write still
    // pending in that same commit (see claimInvite's comment below for the
    // same gotcha). Bundling both bootstrap events into one transaction means
    // the second event's seq can never match the bumped nextSeq.
    const named = validateInbound(agg, { type: 'setName', name: input.name }, system, Date.now() / 1000, 0);
    if (!named.ok) throw new Error(named.error);
    await runTransaction(db, async (tx) => {
      tx.set(eventRef(id, 0), named.event);
      tx.update(aRef, { nextSeq: 1, name: input.name });
    });
    agg.apply(named.event);

    const ownerInput: AddUserInput = {
      type: 'addUser',
      name: input.ownerName,
      role: 'owner',
      email: user.email,
    };
    const owner = validateInbound(agg, ownerInput, system, Date.now() / 1000, 1);
    if (!owner.ok) throw new Error(owner.error);
    const ownerKey = owner.event.publicKey as string;

    await runTransaction(db, async (tx) => {
      tx.set(eventRef(id, 1), owner.event);
      tx.update(aRef, { nextSeq: 2 });
      tx.set(userRef(id, ownerKey), {
        publicKey: ownerKey,
        role: 'owner',
        label: owner.event.label as string,
        colorIndex: owner.event.colorIndex as number,
      });
      tx.set(identityRef(id, ownerKey), { name: input.ownerName, email: user.email });
      // Seated under the address they are signed in with. The claim stamp lands
      // on the next line of the story — they are about to be redirected onto
      // the auction page, which stamps it like any other arriving participant.
      tx.set(seatRef(id, user.email), {
        publicKey: ownerKey,
        role: 'owner',
        invitedAt: Date.now() / 1000,
      });
    });
    agg.apply(owner.event);

    // One transaction per term, for the same reason as above: each event's
    // `seq` has to match a `nextSeq` that is already committed.
    for (const [index, lotName] of input.lots.entries()) {
      const lot = validateInbound(agg, { type: 'addLot', name: lotName }, system, Date.now() / 1000, 2 + index);
      if (!lot.ok) throw new Error(lot.error);
      await runTransaction(db, async (tx) => {
        tx.set(eventRef(id, lot.event.seq), lot.event);
        tx.update(aRef, { nextSeq: lot.event.seq + 1 });
      });
      agg.apply(lot.event);
    }

    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the auction.' };
  }
}

/**
 * Live connection to one auction, backed by Firestore instead of a WebSocket.
 * Public shape (`agg`, `you`, `onChange`, `submit`, `now()`) is kept stable so
 * the views barely change: `agg` is still folded by the shared
 * `AuctionAggregate`, so client and (would-be) server can never drift.
 *
 * There is no trusted server here — see the security-rules file and the
 * project notes for exactly what that costs (blind-bid secrecy and bidder
 * anonymity become cosmetic; bid validity becomes client-trusted).
 */
export class Connection {
  readonly auctionId: string;
  agg: AuctionAggregate | null = null;
  auction: AuctionMeta | null = null;
  you: UserView | null = null;
  connected = false;
  /** Set when the signed-in address could not be resolved to a seat here. */
  authError: string | null = null;
  /**
   * Set when there is no signed-in user at all, so the view knows to show the
   * sign-in form rather than a refusal. Distinct from `authError`: "we do not
   * know who you are" and "we know, and you are not on the list" are different
   * problems with different remedies, and telling them apart is most of what
   * makes a locked-out supplier fixable in the minute before an auction opens.
   */
  needsSignIn = false;
  /** The address this browser is signed in as, once known. */
  email: string | null = null;

  private uid: string | null = null;
  private auctionData: AuctionDocData | null = null;
  /** The log exactly as stored, before this viewer's outbound filter. */
  private rawEvents: AuctionEvent[] = [];
  /**
   * publicKey → real name, for the identities this viewer is allowed to read.
   * A supplier only ever holds their own entry; the auctioneer and observers
   * hold the whole roster. Everyone else stays "Supplier B".
   */
  private identities = new Map<string, string>();
  private listeners = new Set<() => void>();
  private unsubAuction: (() => void) | null = null;
  private unsubEvents: (() => void) | null = null;
  private unsubIdentities: (() => void) | null = null;

  constructor(auctionId: string) {
    this.auctionId = auctionId;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Current time in seconds. There is no server handshake to measure skew
   * against anymore (see the project notes on the client-trusted model), so
   * this is just the local clock — auctions here are meant for one shared
   * event, not scored precisely across drifting machines.
   */
  now(): number {
    return Date.now() / 1000;
  }

  connect(): void {
    this.init().catch((err) => {
      if (err instanceof NotSignedInError) {
        this.needsSignIn = true;
      } else {
        this.authError = err instanceof Error ? err.message : 'Could not connect.';
      }
      this.emit();
    });
  }

  disconnect(): void {
    this.unsubAuction?.();
    this.unsubEvents?.();
    this.unsubIdentities?.();
  }

  /** True when this viewer is entitled to see real names, not just labels. */
  private seesIdentities(): boolean {
    return this.you?.role === 'owner' || this.you?.role === 'viewer';
  }

  private async init(): Promise<void> {
    const user = await requireVerifiedUser();
    this.uid = user.uid;
    this.email = user.email;

    const you = await this.resolveYou();
    if (!you) {
      this.authError =
        `${user.email} has not been invited to this auction. ` +
        'Ask the auctioneer to invite that address — or sign out and sign in with the one they used.';
      this.emit();
      return;
    }
    this.you = you;
    this.identities.set(you.publicKey, you.name);

    const auctionSnap = await getDoc(auctionRef(this.auctionId));
    if (!auctionSnap.exists()) {
      this.authError = 'No such auction.';
      this.emit();
      return;
    }
    this.auctionData = auctionSnap.data() as AuctionDocData;
    this.auction = { id: this.auctionId, name: this.auctionData.name, config: this.auctionData.config };

    // Paint now, on an empty log, rather than waiting for the events listener's
    // first snapshot. Identity and config are already known, which is all the
    // view needs; if that first snapshot is slow or never lands, the supplier
    // would otherwise sit on "Loading…" forever with no error to explain it.
    this.refold();
    this.emit();

    this.unsubAuction = onSnapshot(auctionRef(this.auctionId), (snap) => {
      if (!snap.exists()) return;
      this.auctionData = snap.data() as AuctionDocData;
      this.auction = { id: this.auctionId, name: this.auctionData.name, config: this.auctionData.config };
      if (this.agg) this.agg.config = this.auctionData.config;
      this.emit();
    });

    this.unsubEvents = onSnapshot(
      query(eventsCol(this.auctionId), orderBy('seq')),
      (snap) => {
        this.rawEvents = snap.docs.map((d) => d.data() as AuctionEvent);
        this.refold();
        this.connected = true;
        this.emit();
      },
      (err) => {
        this.authError = err.message;
        this.emit();
      },
    );

    // Only the auctioneer and observers may enumerate identities — the rules
    // refuse the query outright for a supplier, so we do not even attempt it.
    if (this.seesIdentities()) {
      this.unsubIdentities = onSnapshot(identitiesCol(this.auctionId), (snap) => {
        for (const identity of snap.docs) {
          this.identities.set(identity.id, (identity.data() as IdentityDocData).name);
        }
        this.refold();
        this.emit();
      });
    }
  }

  /**
   * Rebuilds `agg` from the raw log as *this* viewer is entitled to see it.
   *
   * Without a server there is nobody else to run the outbound filter, so the
   * client runs it against itself: fold the full log once to get the truth,
   * pass every event through `filterOutbound`, then fold what survives. That
   * is what anonymises rival suppliers and withholds blind Last Call bids —
   * and, because the trimmed log is what `submit()` validates against, a
   * rejection can never betray a bid this viewer was not shown.
   *
   * Visibility is time-dependent (the blind window opens on the clock, not on
   * an event), so the view calls this again whenever the phase flips.
   */
  refold(): void {
    const config = this.auctionData?.config ?? this.auction?.config;
    if (!config || !this.you) return;

    const truth = AuctionAggregate.replay(this.auctionId, config, this.rawEvents);
    const viewer: Participant = { publicKey: this.you.publicKey, role: this.you.role };
    const now = this.now();

    const visible: AuctionEvent[] = [];
    for (const event of this.rawEvents) {
      const filtered = filterOutbound(truth, event, viewer, now);
      if (filtered) visible.push(filtered);
    }

    const agg = AuctionAggregate.replay(this.auctionId, config, visible);
    // The fold only ever produces labels. Real names come from the identity
    // docs Firestore actually let this viewer read, so a supplier's board can
    // never name a rival however the client is tampered with.
    for (const [publicKey, name] of this.identities) agg.revealName(publicKey, name);
    this.agg = agg;
  }

  /**
   * Resolves the seat held by the address this browser is signed in as.
   *
   * There is no handshake and no capability to redeem: the seat either exists
   * under that address or it does not. That is the whole of the access model,
   * and it is why signing in from a new laptop, or after clearing cookies,
   * simply works — the previous design bound the slot to one browser session
   * and had no way to ever unbind it.
   */
  private async resolveYou(): Promise<UserView | null> {
    const seatSnap = await getDoc(seatRef(this.auctionId, this.email!));
    if (!seatSnap.exists()) return null;
    const seat = seatSnap.data() as SeatDocData;
    const { publicKey, role } = seat;

    const userSnap = await getDoc(userRef(this.auctionId, publicKey));
    if (!userSnap.exists()) return null;
    const { label, colorIndex } = userSnap.data() as UserDocData;

    // Stamp the first arrival, so the auctioneer's roster can show who has
    // actually got in rather than only who was invited. Best-effort: a failure
    // here must never keep a supplier off the board.
    if (!seat.claimedUid) {
      updateDoc(seatRef(this.auctionId, this.email!), {
        claimedUid: this.uid,
        claimedAt: Date.now() / 1000,
      }).catch(() => {});
    }

    // Your own identity doc — the one real name a supplier is allowed to read.
    const identitySnap = await getDoc(identityRef(this.auctionId, publicKey));
    const name = identitySnap.exists() ? (identitySnap.data() as IdentityDocData).name : label;

    return { publicKey, role, label, colorIndex: colorIndex ?? 0, name };
  }

  /**
   * Validates locally (for instant feedback) then atomically allocates the
   * next `seq` and appends the event — the client-side successor to
   * `Repository.submit`. `addUser` also provisions the new participant's user
   * doc and a fresh invite capability, all in the same transaction.
   */
  async submit(input: InboundEventInput): Promise<ApiResult & { event?: AuctionEvent; invitedEmail?: string }> {
    if (!this.agg || !this.you) return { ok: false, error: 'Not connected yet.' };

    const parsed = parseInboundEvent(input, this.you.role);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const actor: Participant = { publicKey: this.you.publicKey, role: this.you.role };
    const validated = validateInbound(this.agg, parsed.input, actor, this.now(), 0);
    if (!validated.ok) return { ok: false, error: validated.error };

    // Carried alongside the event, never inside it: `validateInbound` strips
    // the name so it can only reach the access-controlled identities doc.
    const identity =
      parsed.input.type === 'addUser'
        ? { name: parsed.input.name, email: parsed.input.email }
        : null;

    const draft = validated.event;
    let invitedEmail: string | undefined;

    // A seat is keyed by address, so two participants cannot share one — the
    // second would silently displace the first. Caught here rather than at the
    // write, because the rules cannot express "must not already exist" without
    // making seats world-readable, which is exactly what they must not be.
    if (parsed.input.type === 'addUser') {
      const address = normalizeEmail(parsed.input.email);
      const existing = await getDoc(seatRef(this.auctionId, address));
      if (existing.exists()) {
        return { ok: false, error: `${address} is already taking part in this auction.` };
      }
    }

    try {
      await runTransaction(db, async (tx) => {
        const aRef = auctionRef(this.auctionId);
        const snap = await tx.get(aRef);
        if (!snap.exists()) throw new Error('No such auction.');
        const seq = (snap.data() as AuctionDocData).nextSeq;
        const event: AuctionEvent = { ...draft, seq };

        tx.set(eventRef(this.auctionId, seq), event);
        tx.update(aRef, { nextSeq: seq + 1, ...mirrorUpdate(event) });

        if (event.type === 'addUser') {
          const publicKey = event.publicKey as string;
          const address = normalizeEmail(identity!.email);
          tx.set(userRef(this.auctionId, publicKey), {
            publicKey,
            role: event.role as Role,
            label: event.label as string,
            colorIndex: event.colorIndex as number,
          });
          // Name and address are stripped off the event by `validateInbound`
          // and land here instead, behind the identities rule.
          tx.set(identityRef(this.auctionId, publicKey), { name: identity!.name, email: address });
          // The seat is what actually admits them. Nothing else in this
          // transaction grants access, and no secret leaves the auctioneer's
          // browser — the invitation goes to that inbox or nowhere.
          tx.set(seatRef(this.auctionId, address), {
            publicKey,
            role: event.role as Role,
            invitedAt: Date.now() / 1000,
          });
          invitedEmail = address;
        }

        draft.seq = seq;
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Request failed.' };
    }

    return { ok: true, event: draft, ...(invitedEmail ? { invitedEmail } : {}) };
  }

  // --- roster management (auctioneer only) ---------------------------------

  /**
   * Emails a fresh sign-in link to a participant. Safe to repeat: links are
   * short-lived and single-use, so "resend" is the ordinary remedy for a
   * supplier who lost theirs, let it expire, or is now on a different machine.
   */
  async sendInvite(email: string): Promise<ApiResult> {
    if (this.you?.role !== 'owner') return { ok: false, error: 'Auctioneers only.' };
    const sent = await sendSignInLink(email, auctionUrl(this.auctionId), false);
    return { ok: sent.ok, ...(sent.error ? { error: sent.error } : {}) };
  }

  /**
   * Withdraws someone's access. Deleting the seat is enough on its own — every
   * rule resolves a caller through it — so this takes effect immediately, on
   * whatever device they are already sitting in front of.
   *
   * Their slot, label, colour and any bids they placed stay on the board: the
   * log is append-only, and a term's history would be a lie without them.
   */
  async revokeSeat(email: string): Promise<ApiResult> {
    if (this.you?.role !== 'owner') return { ok: false, error: 'Auctioneers only.' };
    if (normalizeEmail(email) === this.email) {
      return { ok: false, error: 'You cannot remove your own access.' };
    }
    try {
      await deleteDoc(seatRef(this.auctionId, email));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not remove access.' };
    }
  }

  /**
   * Moves a slot to a different address — the fix for a mistyped invitation,
   * or for a supplier who turns out to want a colleague at the keyboard.
   *
   * Deliberately not a rename: the old seat is deleted and a new one created,
   * so anyone signed in under the old address loses access at the same moment
   * the new one gains it.
   */
  async reassignSeat(publicKey: string, oldEmail: string, newEmail: string): Promise<ApiResult> {
    if (this.you?.role !== 'owner') return { ok: false, error: 'Auctioneers only.' };
    const address = normalizeEmail(newEmail);
    if (address === normalizeEmail(oldEmail)) return { ok: true };

    const user = this.agg?.users.get(publicKey);
    if (!user) return { ok: false, error: 'No such participant.' };

    try {
      const clash = await getDoc(seatRef(this.auctionId, address));
      if (clash.exists()) return { ok: false, error: `${address} is already taking part in this auction.` };

      await setDoc(seatRef(this.auctionId, address), {
        publicKey,
        role: user.role,
        invitedAt: Date.now() / 1000,
      });
      await deleteDoc(seatRef(this.auctionId, oldEmail));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not change the address.' };
    }
  }

  /**
   * The auctioneer's roster: every slot, who holds it, and whether they have
   * managed to sign in yet.
   *
   * Two collections have to be joined because they are protected differently —
   * `identities` carries the firm name and `seats` carries the address and the
   * sign-in stamp, and a supplier is allowed to read neither for anyone but
   * themselves. Only an auctioneer can list either, which is why this is the
   * one view where a name, a colour and an address appear together.
   */
  async roster(): Promise<RosterEntry[]> {
    if (this.you?.role !== 'owner' || !this.agg) return [];

    const [seatDocs, identityDocs] = await Promise.all([
      getDocs(seatsCol(this.auctionId)),
      getDocs(identitiesCol(this.auctionId)),
    ]);

    const seatByKey = new Map<string, { email: string; seat: SeatDocData }>();
    for (const snap of seatDocs.docs) {
      seatByKey.set((snap.data() as SeatDocData).publicKey, {
        email: snap.id,
        seat: snap.data() as SeatDocData,
      });
    }
    const nameByKey = new Map<string, string>();
    for (const snap of identityDocs.docs) nameByKey.set(snap.id, (snap.data() as IdentityDocData).name);

    return [...this.agg.users.values()].map((user) => {
      const seated = seatByKey.get(user.publicKey);
      return {
        publicKey: user.publicKey,
        name: nameByKey.get(user.publicKey) ?? user.label,
        label: user.label,
        role: user.role,
        colorIndex: user.colorIndex,
        email: seated?.email ?? null,
        signedInAt: seated?.seat.claimedAt ?? null,
        isYou: seated?.email === this.email,
      };
    });
  }

  /** Owner-only: updates auction rules before the auction has started. */
  async updateConfig(patch: Partial<AuctionConfig>): Promise<ApiResult & { config?: AuctionConfig }> {
    if (this.you?.role !== 'owner') return { ok: false, error: 'Owners only.' };
    if (!this.agg || this.agg.startTime !== null) {
      return { ok: false, error: 'Rules cannot change once the auction has started.' };
    }

    const parsed = configSchema.safeParse({ ...this.agg.config, ...patch });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

    try {
      await updateDoc(auctionRef(this.auctionId), {
        config: parsed.data,
        auctionLength: totalRunSec(parsed.data),
      });
      return { ok: true, config: parsed.data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save rules.' };
    }
  }
}
