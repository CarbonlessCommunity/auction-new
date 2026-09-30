import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import {
  createParticipantAccount,
  currentUser,
  generatePassword,
  normalizeEmail,
  reloadUser,
  setParticipantPassword,
} from './auth';
import { isAdminEmail } from '../shared/admins';
import { AuctionAggregate, type Participant } from '../shared/aggregate';
import { configSchema } from '../shared/config';
import { MAX_BIDDERS, totalRunSec } from '../shared/rules';
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
  /** The participant's address, or null if the seat has been revoked. */
  email: string | null;
  /** When they first signed in, or null if they never have. */
  signedInAt: number | null;
  isYou: boolean;
  /**
   * Admin panel only: the generated password on file for this account, and
   * whether the account pre-existed (in which case there is no password to
   * show — the participant already has one). `password` also goes null once
   * the participant changes it themselves.
   */
  credential?: { password: string | null; preexisting: boolean } | null;
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
  /** The auctioneer's slot in `users`, so an admin can resolve to it without a seat. */
  ownerPublicKey: string;
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

/**
 * `auctions/{id}/credentials/{publicKey}` — the generated password for a
 * participant's account, kept so either admin can re-read and relay it.
 * `firestore.rules` scopes this to admins alone.
 */
interface CredentialDocData {
  email: string;
  /** null once the participant sets their own password, or if the account pre-existed. */
  password: string | null;
  preexisting: boolean;
  updatedAt: number;
}

/**
 * `auctions/{id}/presence/{uid}` — one heartbeat per open browser, stamped with
 * the *server's* clock. It does two jobs at once. Read back after the write,
 * the server stamp tells this browser how far its own clock is off, which is
 * what keeps every screen's countdown — and so the moment Last Call opens —
 * agreeing (`Connection.now`). Listed by the auctioneer, the stamps say who is
 * actually connected right now, as opposed to who has ever signed in.
 *
 * Carries nothing identifying: only the public slot key. `firestore.rules`
 * lets a participant write their own doc with their own slot and the server's
 * time, and lets only the auctioneer enumerate them.
 */
interface PresenceDocData {
  publicKey: string;
  at: Timestamp;
}

/** Seconds between heartbeats. */
export const HEARTBEAT_SEC = 30;
/**
 * A participant counts as online for this long after their last heartbeat.
 * Wider than two beats: a browser throttles a background tab's timers to once
 * a minute, and a supplier who has the board in a background tab is still
 * here.
 */
export const ONLINE_WINDOW_SEC = 100;

const auctionRef = (id: string) => doc(db, 'auctions', id);
const eventsCol = (id: string) => collection(db, 'auctions', id, 'events');
const eventRef = (id: string, seq: number) => doc(db, 'auctions', id, 'events', String(seq).padStart(10, '0'));
const userRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'users', publicKey);
const identitiesCol = (id: string) => collection(db, 'auctions', id, 'identities');
const identityRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'identities', publicKey);
const seatsCol = (id: string) => collection(db, 'auctions', id, 'seats');
const seatRef = (id: string, email: string) => doc(db, 'auctions', id, 'seats', normalizeEmail(email));
const credentialsCol = (id: string) => collection(db, 'auctions', id, 'credentials');
const credentialRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'credentials', publicKey);
const presenceCol = (id: string) => collection(db, 'auctions', id, 'presence');
const presenceRef = (id: string, uid: string) => doc(db, 'auctions', id, 'presence', uid);

/** Force one ID-token refresh per session, so a fresh verification click reaches the rules. */
let adminTokenRefreshed = false;

/** Random bytes, hex-encoded — used for unguessable auction ids. */
function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The board URL for an auction — what an admin hands a participant. */
export function auctionUrl(auctionId: string): string {
  return `${location.origin}/a/${auctionId}`;
}

/** Every auction, newest first — the admin panel's list. Admins only (by rule). */
export async function listAuctions(): Promise<Array<{ id: string; name: string; createdAt: number | null }>> {
  const snap = await getDocs(collection(db, 'auctions'));
  return snap.docs
    .map((docSnap) => {
      const data = docSnap.data() as { name?: string; createdAt?: { toMillis?: () => number } };
      return {
        id: docSnap.id,
        name: data.name ?? '(untitled)',
        createdAt: data.createdAt?.toMillis?.() ?? null,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Raised when an operation needs a signed-in user and has none. */
export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'NotSignedInError';
  }
}

/**
 * The signed-in user, insisting on an address. Everything downstream — the seat
 * lookup, every rule in `firestore.rules` — keys off that address, so a session
 * without one cannot proceed. Email *verification* is only required of an admin
 * (see `firestore.rules`), and is checked separately in `init()`.
 */
async function requireUser(): Promise<User & { email: string }> {
  const user = await currentUser();
  if (!user || !user.email) throw new NotSignedInError();
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
 * Creates a new auction: the auction doc first (so the rules can see it), then
 * the bootstrap `setName`/`addUser` events and the auctioneer's own user and
 * identity docs.
 *
 * The creator is an admin, already signed in — the admin panel is where this is
 * called from. The auctioneer gets a slot in `users` like any participant but
 * *no seat*: an admin resolves to the `owner` role straight from their token
 * (see `resolveYou`), so it works from any device with no capability to carry.
 */
export async function createAuction(input: CreateAuctionInput): Promise<ApiResult & { id?: string }> {
  try {
    const user = await requireUser();
    const id = randomId(6);
    const aRef = auctionRef(id);

    await setDoc(aRef, {
      name: input.name,
      config: input.config,
      ownerUid: user.uid,
      // The auctioneer is always the first `addUser` (seq 1); `setName` adds no
      // user, so its publicKey is '0'. Kept on the doc so an admin can resolve
      // to that slot without reading the log.
      ownerPublicKey: '0',
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
      tx.update(aRef, { nextSeq: 2, ownerPublicKey: ownerKey });
      tx.set(userRef(id, ownerKey), {
        publicKey: ownerKey,
        role: 'owner',
        label: owner.event.label as string,
        colorIndex: owner.event.colorIndex as number,
      });
      tx.set(identityRef(id, ownerKey), { name: input.ownerName, email: user.email });
      // No seat: an admin resolves to `owner` from their token alone.
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
  private unsubPresence: (() => void) | null = null;
  private heartbeatTimer: number | null = null;
  /**
   * Server clock minus this machine's, in seconds, and the round trip the
   * estimate was taken over. See `heartbeat()`.
   */
  private clockOffset = 0;
  private clockOffsetRtt = Infinity;
  private clockOffsetAt = 0;
  /**
   * publicKey → the server time of that participant's latest heartbeat, for
   * the auctioneer's "who is actually here" view. Empty on every other screen:
   * the rules let only an auctioneer list the collection.
   */
  private presence = new Map<string, number>();

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
   * Current time in seconds, on the *server's* clock. Every countdown, every
   * phase flip and every event's `time` stamp reads this. The local clock is
   * corrected by the offset measured in `heartbeat()`, so a supplier whose
   * laptop is half a minute out still sees Last Call open when everyone else
   * does — and cannot be rejected by a rule whose window is server time.
   * Until the first heartbeat lands the offset is zero, i.e. the old behaviour.
   */
  now(): number {
    return Date.now() / 1000 + this.clockOffset;
  }

  /** How far this machine's clock was found to be off, in seconds; null until measured. */
  get clockSkewSec(): number | null {
    return this.clockOffsetRtt === Infinity ? null : this.clockOffset;
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
    this.unsubPresence?.();
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    // Best-effort: a doc left behind simply ages out of the online window.
    if (this.uid) deleteDoc(presenceRef(this.auctionId, this.uid)).catch(() => {});
  }

  // --- presence + clock ---------------------------------------------------

  /**
   * Writes this browser's heartbeat and, from the server's stamp on it, takes
   * a fresh reading of how far the local clock is off.
   *
   * The server stamps the doc at some instant inside the write's round trip,
   * so the midpoint of that trip is the local time to pair it with, and half
   * the trip is the error bar. NTP-style, the reading taken over the shortest
   * round trip so far is the one kept — a slow write is a noisy one — and a
   * reading older than ten minutes is replaced regardless, in case the machine
   * corrected its own clock meanwhile.
   */
  private async heartbeat(): Promise<void> {
    if (!this.uid || !this.you) return;
    const ref = presenceRef(this.auctionId, this.uid);
    try {
      const sentAt = Date.now();
      await setDoc(ref, { publicKey: this.you.publicKey, at: serverTimestamp() });
      const ackedAt = Date.now();
      const snap = await getDocFromServer(ref);
      const at = (snap.data() as PresenceDocData | undefined)?.at;
      if (!at) return;

      const rtt = ackedAt - sentAt;
      const offset = at.toMillis() / 1000 - (sentAt + ackedAt) / 2000;
      const stale = Date.now() - this.clockOffsetAt > 10 * 60 * 1000;
      // Two readings whose error bars do not overlap cannot both be right,
      // and the newer one is the clock as it is *now* — the machine just
      // corrected itself, or someone set it. Take it, whatever its trip.
      const moved = Math.abs(offset - this.clockOffset) > (rtt + this.clockOffsetRtt) / 2000;
      if (rtt <= this.clockOffsetRtt || stale || moved) {
        const before = this.clockOffset;
        this.clockOffset = offset;
        this.clockOffsetRtt = rtt;
        this.clockOffsetAt = Date.now();
        // A corrected clock can move the phase; let the view repaint.
        if (Math.abs(this.clockOffset - before) > 0.25) this.emit();
      }
    } catch {
      // Offline, or the rules refused us (seat just revoked): nothing to do.
    }
  }

  private startHeartbeat(): void {
    void this.heartbeat();
    this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), HEARTBEAT_SEC * 1000);
    // Leaving the page: try to clear our doc so the auctioneer sees us go.
    window.addEventListener('pagehide', () => {
      if (this.uid) deleteDoc(presenceRef(this.auctionId, this.uid)).catch(() => {});
    });
  }

  /** Server time of `publicKey`'s latest heartbeat, or null if none was seen. */
  lastSeen(publicKey: string): number | null {
    return this.presence.get(publicKey) ?? null;
  }

  /** True if `publicKey` has a browser open on this auction right now. */
  isOnline(publicKey: string): boolean {
    const seen = this.presence.get(publicKey);
    return seen !== undefined && this.now() - seen <= ONLINE_WINDOW_SEC;
  }

  /**
   * Who is online, as one comparable string. Presence changes on the clock as
   * well as on writes — a beat simply ages out — so the view folds this into
   * the key it polls to decide whether a repaint is due.
   */
  onlineKey(): string {
    return [...this.presence.keys()].filter((key) => this.isOnline(key)).sort().join(',');
  }

  /**
   * The log exactly as stored, for the auctioneer's audit. Empty for anyone
   * else: a supplier's fold is the outbound-filtered one, and hidden Last Call
   * bids must not reach them by this route either.
   */
  auditTrail(): AuctionEvent[] {
    return this.you?.role === 'owner' ? [...this.rawEvents] : [];
  }

  /** True when this viewer is entitled to see real names, not just labels. */
  private seesIdentities(): boolean {
    return this.you?.role === 'owner' || this.you?.role === 'viewer';
  }

  private async init(): Promise<void> {
    let user = await requireUser();
    this.uid = user.uid;
    this.email = user.email;

    // An admin's stored session can carry a stale `email_verified` in its ID
    // token right after a verification click. Force one refresh per session so
    // the claim the rules read catches up; only then give up.
    if (isAdminEmail(user.email) && (!adminTokenRefreshed || !user.emailVerified)) {
      await reloadUser();
      adminTokenRefreshed = true;
      user = await requireUser();
    }
    if (isAdminEmail(user.email) && !user.emailVerified) {
      this.authError =
        'Verify your email address first — open the link we emailed when you set your password, then reload.';
      this.emit();
      return;
    }

    const auctionSnap = await getDoc(auctionRef(this.auctionId));
    if (!auctionSnap.exists()) {
      this.authError = 'No such auction.';
      this.emit();
      return;
    }
    this.auctionData = auctionSnap.data() as AuctionDocData;
    this.auction = { id: this.auctionId, name: this.auctionData.name, config: this.auctionData.config };

    const you = await this.resolveYou();
    if (!you) {
      this.authError =
        `${user.email} is not part of this auction. Ask an auctioneer to add that address` +
        ' — or sign out and sign in with the one they used.';
      this.emit();
      return;
    }
    this.you = you;
    this.identities.set(you.publicKey, you.name);

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

    this.startHeartbeat();

    // Only the auctioneer may enumerate heartbeats; nobody else needs to.
    if (this.you.role === 'owner') {
      this.unsubPresence = onSnapshot(presenceCol(this.auctionId), (snap) => {
        const latest = new Map<string, number>();
        for (const beat of snap.docs) {
          const data = beat.data() as Partial<PresenceDocData>;
          // `at` is null on the writer's own screen until the server acks it.
          if (typeof data.publicKey !== 'string' || !data.at) continue;
          const seconds = data.at.toMillis() / 1000;
          // One person can hold several browsers open; the newest beat counts.
          if (seconds > (latest.get(data.publicKey) ?? 0)) latest.set(data.publicKey, seconds);
        }
        // Heartbeats arrive every half minute from every participant, and
        // almost none of them change anything on screen. Repaint only when
        // someone actually comes or goes, so the board is not rebuilt under
        // the auctioneer's cursor for nothing.
        const before = this.onlineKey();
        this.presence = latest;
        if (this.onlineKey() !== before) this.emit();
      });
    }

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
    // An admin holds the `owner` role on every auction, straight from their
    // verified address — no seat, nothing to lose or forward.
    if (isAdminEmail(this.email)) {
      const ownerKey = this.auctionData?.ownerPublicKey ?? '0';
      const userSnap = await getDoc(userRef(this.auctionId, ownerKey));
      const slot = userSnap.exists() ? (userSnap.data() as UserDocData) : null;
      const identitySnap = await getDoc(identityRef(this.auctionId, ownerKey));
      const name = identitySnap.exists()
        ? (identitySnap.data() as IdentityDocData).name
        : 'Auctioneer';
      return {
        publicKey: ownerKey,
        role: 'owner',
        label: slot?.label ?? 'Auctioneer',
        colorIndex: slot?.colorIndex ?? 0,
        name,
      };
    }

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
   * `Repository.submit`. `addUser` also provisions the new participant's roster
   * slot, identity and seat in the same transaction (their email/password
   * account is created separately, in `createParticipant`).
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
          // The seat is what actually admits them, keyed by their address.
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

  // --- participant management (admin only) -------------------------------

  private adminGuard(): ApiResult | null {
    return isAdminEmail(this.email) ? null : { ok: false, error: 'Auctioneers only.' };
  }

  /**
   * Creates a participant: their email/password account (on a throwaway
   * secondary app, so this admin stays signed in), then the `addUser` event +
   * roster slot + identity + seat, then the generated password on file at
   * `credentials/{publicKey}`.
   *
   * Returns the plaintext password once, for the panel to show and the admin to
   * relay out of band. If the address already had an account it is seated as
   * it is and no password comes back — the participant keeps the one they have.
   */
  async createParticipant(input: {
    name: string;
    email: string;
    role: Role;
  }): Promise<ApiResult & { email?: string; password?: string; preexisting?: boolean }> {
    const guard = this.adminGuard();
    if (guard) return guard;

    const address = normalizeEmail(input.email);
    if (input.role === 'bidder' && this.agg && this.agg.countRole('bidder') >= MAX_BIDDERS) {
      return { ok: false, error: `An auction can have at most ${MAX_BIDDERS} bidding firms.` };
    }
    const existing = await getDoc(seatRef(this.auctionId, address));
    if (existing.exists()) {
      return { ok: false, error: `${address} is already taking part in this auction.` };
    }

    const password = generatePassword();
    const account = await createParticipantAccount(address, password);
    if (!account.ok && !account.preexisting) {
      return { ok: false, error: account.error ?? 'Could not create the account.' };
    }
    const preexisting = account.preexisting === true;

    const result = await this.submit({
      type: 'addUser',
      name: input.name,
      role: input.role,
      email: address,
    });
    if (!result.ok || !result.event) {
      return { ok: false, error: result.error ?? 'Could not add the participant.' };
    }
    const publicKey = result.event.publicKey as string;

    await setDoc(credentialRef(this.auctionId, publicKey), {
      email: address,
      password: preexisting ? null : password,
      preexisting,
      updatedAt: Date.now() / 1000,
    } satisfies CredentialDocData);

    return { ok: true, email: address, preexisting, ...(preexisting ? {} : { password }) };
  }

  /**
   * Sets a fresh password on a participant's account and updates the copy on
   * file. Works only while the stored password is still current — if the
   * participant has changed it themselves, remove and re-add them instead.
   */
  async resetParticipantPassword(
    publicKey: string,
    email: string,
  ): Promise<ApiResult & { password?: string }> {
    const guard = this.adminGuard();
    if (guard) return guard;

    const snap = await getDoc(credentialRef(this.auctionId, publicKey));
    const current = snap.exists() ? (snap.data() as CredentialDocData) : null;
    if (!current || current.preexisting || !current.password) {
      return {
        ok: false,
        error: 'No password on file for this account — remove and re-add them to issue a new one.',
      };
    }

    const next = generatePassword();
    const changed = await setParticipantPassword(email, current.password, next);
    if (!changed.ok) {
      return {
        ok: false,
        error:
          changed.error ??
          'Could not set a new password — the participant may have changed it themselves.',
      };
    }

    await updateDoc(credentialRef(this.auctionId, publicKey), {
      password: next,
      updatedAt: Date.now() / 1000,
    });
    return { ok: true, password: next };
  }

  /**
   * Withdraws a participant's access. Deleting the seat is enough on its own —
   * every rule resolves a caller through it — so this bites immediately, on
   * whatever device they are already using. Their slot, colour and any bids
   * stay on the board; the log is append-only.
   */
  async revokeParticipant(email: string, publicKey?: string): Promise<ApiResult> {
    const guard = this.adminGuard();
    if (guard) return guard;
    if (normalizeEmail(email) === this.email) {
      return { ok: false, error: 'You cannot remove your own access.' };
    }
    try {
      await deleteDoc(seatRef(this.auctionId, email));
      if (publicKey) await deleteDoc(credentialRef(this.auctionId, publicKey)).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not remove access.' };
    }
  }

  /**
   * Moves a slot to a different address and issues that address its own
   * account — the fix for a mistyped email. The old seat is deleted, so anyone
   * on the old address loses access the moment the new one gains it; the slot,
   * colour and any bids are kept.
   */
  async changeParticipantEmail(
    publicKey: string,
    oldEmail: string,
    newEmail: string,
  ): Promise<ApiResult & { email?: string; password?: string; preexisting?: boolean }> {
    const guard = this.adminGuard();
    if (guard) return guard;

    const address = normalizeEmail(newEmail);
    if (address === normalizeEmail(oldEmail)) return { ok: true };

    const user = this.agg?.users.get(publicKey);
    if (!user) return { ok: false, error: 'No such participant.' };

    const clash = await getDoc(seatRef(this.auctionId, address));
    if (clash.exists()) {
      return { ok: false, error: `${address} is already taking part in this auction.` };
    }

    const password = generatePassword();
    const account = await createParticipantAccount(address, password);
    if (!account.ok && !account.preexisting) {
      return { ok: false, error: account.error ?? 'Could not create the account.' };
    }
    const preexisting = account.preexisting === true;

    try {
      await setDoc(seatRef(this.auctionId, address), {
        publicKey,
        role: user.role,
        invitedAt: Date.now() / 1000,
      });
      await deleteDoc(seatRef(this.auctionId, oldEmail));
      await setDoc(credentialRef(this.auctionId, publicKey), {
        email: address,
        password: preexisting ? null : password,
        preexisting,
        updatedAt: Date.now() / 1000,
      } satisfies CredentialDocData);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not change the address.' };
    }

    return { ok: true, email: address, preexisting, ...(preexisting ? {} : { password }) };
  }

  /**
   * The auctioneer's roster: every slot, who holds it, whether they have signed
   * in yet, and — for an admin — the password on file for the account.
   *
   * `identities` (firm name), `seats` (address + sign-in stamp) and
   * `credentials` (password) are joined here because they are protected
   * separately and a supplier may read none of them for anyone but themselves.
   * This is the one view where a name, a colour and an address appear together.
   */
  async roster(): Promise<RosterEntry[]> {
    if (this.you?.role !== 'owner' || !this.agg) return [];
    const admin = isAdminEmail(this.email);

    const [seatDocs, identityDocs, credentialDocs] = await Promise.all([
      getDocs(seatsCol(this.auctionId)),
      getDocs(identitiesCol(this.auctionId)),
      admin ? getDocs(credentialsCol(this.auctionId)) : Promise.resolve(null),
    ]);

    const seatByKey = new Map<string, { email: string; seat: SeatDocData }>();
    for (const snap of seatDocs.docs) {
      seatByKey.set((snap.data() as SeatDocData).publicKey, {
        email: snap.id,
        seat: snap.data() as SeatDocData,
      });
    }
    const nameByKey = new Map<string, string>();
    const emailByKey = new Map<string, string>();
    for (const snap of identityDocs.docs) {
      const data = snap.data() as IdentityDocData;
      nameByKey.set(snap.id, data.name);
      if (data.email) emailByKey.set(snap.id, data.email);
    }
    const credByKey = new Map<string, { password: string | null; preexisting: boolean }>();
    for (const snap of credentialDocs?.docs ?? []) {
      const data = snap.data() as CredentialDocData;
      credByKey.set(snap.id, { password: data.password, preexisting: data.preexisting });
    }

    return [...this.agg.users.values()].map((user) => {
      const seated = seatByKey.get(user.publicKey);
      return {
        publicKey: user.publicKey,
        name: nameByKey.get(user.publicKey) ?? user.label,
        label: user.label,
        role: user.role,
        colorIndex: user.colorIndex,
        email: seated?.email ?? emailByKey.get(user.publicKey) ?? null,
        signedInAt: seated?.seat.claimedAt ?? null,
        isYou: user.publicKey === this.you?.publicKey,
        credential: credByKey.get(user.publicKey) ?? null,
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
