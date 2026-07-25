import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth';
import { auth, db } from './firebase';
import { AuctionAggregate, type StoredUser } from '../shared/aggregate';
import { configSchema } from '../shared/config';
import { parseInboundEvent } from '../shared/schemas';
import { filterOutbound, validateInbound } from '../shared/validation';
import type { AddUserInput, AuctionConfig, AuctionEvent, AuctionMeta, InboundEventInput, Role, UserView } from '../shared/types';

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
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

interface UserDocData {
  publicKey: string;
  role: Role;
  name: string;
  email?: string;
  /** Firebase anon-auth uid bound to this slot, or null until an invite is claimed. */
  claimUid: string | null;
  claimInviteId: string | null;
}

const auctionRef = (id: string) => doc(db, 'auctions', id);
const eventsCol = (id: string) => collection(db, 'auctions', id, 'events');
const eventRef = (id: string, seq: number) => doc(db, 'auctions', id, 'events', String(seq).padStart(10, '0'));
const userRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'users', publicKey);
const inviteRef = (id: string, inviteId: string) => doc(db, 'auctions', id, 'invites', inviteId);
/**
 * `auctions/{id}/claims/{uid}` mirrors "which slot does this Firebase Auth uid
 * own" — keyed by uid so `firestore.rules` can resolve a writer's role with a
 * single `get()` instead of a query (Firestore rules cannot run
 * `where(claimUid==...)` queries the way `resolveYou` below used to).
 * Create-only, one per uid, so it also enforces first-claim-wins.
 */
const claimRef = (id: string, uid: string) => doc(db, 'auctions', id, 'claims', uid);

/** 128 bits of randomness, hex-encoded — used for both auction ids and invite capabilities. */
function randomId(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function inviteUrl(auctionId: string, inviteId: string): string {
  return `${location.origin}/a/${auctionId}?invite=${inviteId}`;
}

/** Resolves once an anonymous Firebase Auth session exists, signing in if needed. */
function ensureAuth(): Promise<User> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsubscribe();
          resolve(user);
        }
      },
      reject,
    );
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
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
  email?: string;
  config: AuctionConfig;
  /** Contract terms to open the board with, e.g. ['12 Months', '24 Months']. */
  lots: string[];
}

/**
 * Creates a new auction: the auction doc first (so `ownerUid` exists for
 * `isOwner()` rule checks), then the bootstrap `setName`/`addUser` events and
 * the owner's own (already-claimed) user doc, mirroring what the old
 * `POST /api/auctions` route did with a synthetic system actor.
 */
export async function createAuction(input: CreateAuctionInput): Promise<ApiResult & { id?: string }> {
  try {
    const user = await ensureAuth();
    const id = randomId(6);
    const aRef = auctionRef(id);

    await setDoc(aRef, {
      name: input.name,
      config: input.config,
      ownerUid: user.uid,
      nextSeq: 0,
      startedAt: null,
      auctionLength: input.config.auctionLengthSec,
      showResults: false,
      createdAt: serverTimestamp(),
    });

    const system: StoredUser = { publicKey: '__system__', role: 'owner', name: 'System' };
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
      ...(input.email ? { email: input.email } : {}),
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
        name: input.ownerName,
        ...(input.email ? { email: input.email } : {}),
        claimUid: user.uid,
        claimInviteId: null,
      });
      tx.set(claimRef(id, user.uid), { publicKey: ownerKey, role: 'owner' });
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
  /** Set when this browser could not be resolved to a member of this auction. */
  authError: string | null = null;

  private uid: string | null = null;
  private auctionData: AuctionDocData | null = null;
  /** The log exactly as stored, before this viewer's outbound filter. */
  private rawEvents: AuctionEvent[] = [];
  private listeners = new Set<() => void>();
  private unsubAuction: (() => void) | null = null;
  private unsubEvents: (() => void) | null = null;

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
      this.authError = err instanceof Error ? err.message : 'Could not connect.';
      this.emit();
    });
  }

  disconnect(): void {
    this.unsubAuction?.();
    this.unsubEvents?.();
  }

  private async init(): Promise<void> {
    const user = await ensureAuth();
    this.uid = user.uid;

    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) {
      await this.claimInvite(invite);
      history.replaceState(null, '', `/a/${this.auctionId}`);
    }

    const you = await this.resolveYou();
    if (!you) {
      this.authError = 'You do not have access to this auction. Ask the organiser for an invite link.';
      this.emit();
      return;
    }
    this.you = you;

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
    const viewer: StoredUser = { publicKey: this.you.publicKey, role: this.you.role, name: this.you.name };
    const now = this.now();

    const visible: AuctionEvent[] = [];
    for (const event of this.rawEvents) {
      const filtered = filterOutbound(truth, event, viewer, now);
      if (filtered) visible.push(filtered);
    }

    this.agg = AuctionAggregate.replay(this.auctionId, config, visible);
  }

  /**
   * Claims an invited slot by presenting the capability id from the URL.
   * Write-once: the first browser to claim a given slot binds it to that
   * anonymous uid permanently (this replaces the original's per-visit
   * cookie-swap — a link can no longer be reused from a second device).
   */
  private async claimInvite(inviteId: string): Promise<void> {
    const inviteSnap = await getDoc(inviteRef(this.auctionId, inviteId));
    if (!inviteSnap.exists()) return;
    const { publicKey } = inviteSnap.data() as { publicKey: string };

    const uRef = userRef(this.auctionId, publicKey);
    const userSnap = await getDoc(uRef);
    if (!userSnap.exists()) return;
    const { role, claimUid } = userSnap.data() as UserDocData;
    if (claimUid) return;

    // Two sequential writes, not one transaction: the claims-doc rule needs to
    // `get()` this user doc's *committed* claimUid to verify the claim, and a
    // security rule can't see a sibling write still pending in its own transaction.
    await updateDoc(uRef, { claimUid: this.uid, claimInviteId: inviteId });
    await setDoc(claimRef(this.auctionId, this.uid!), { publicKey, role });
  }

  private async resolveYou(): Promise<UserView | null> {
    const claimSnap = await getDoc(claimRef(this.auctionId, this.uid!));
    if (!claimSnap.exists()) return null;
    const { publicKey, role } = claimSnap.data() as { publicKey: string; role: Role };

    const userSnap = await getDoc(userRef(this.auctionId, publicKey));
    if (!userSnap.exists()) return null;
    return { publicKey, role, name: (userSnap.data() as UserDocData).name };
  }

  /**
   * Validates locally (for instant feedback) then atomically allocates the
   * next `seq` and appends the event — the client-side successor to
   * `Repository.submit`. `addUser` also provisions the new participant's user
   * doc and a fresh invite capability, all in the same transaction.
   */
  async submit(input: InboundEventInput): Promise<ApiResult & { event?: AuctionEvent; inviteUrl?: string }> {
    if (!this.agg || !this.you) return { ok: false, error: 'Not connected yet.' };

    const parsed = parseInboundEvent(input, this.you.role);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const actor: StoredUser = { publicKey: this.you.publicKey, role: this.you.role, name: this.you.name };
    const validated = validateInbound(this.agg, parsed.input, actor, this.now(), 0);
    if (!validated.ok) return { ok: false, error: validated.error };

    const draft = validated.event;
    let inviteUrlOut: string | undefined;

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
          tx.set(userRef(this.auctionId, publicKey), {
            publicKey,
            role: event.role as Role,
            name: event.name as string,
            ...(event.email ? { email: event.email as string } : {}),
            claimUid: null,
            claimInviteId: null,
          });
          const inviteId = randomId();
          tx.set(inviteRef(this.auctionId, inviteId), { publicKey });
          inviteUrlOut = inviteUrl(this.auctionId, inviteId);
        }

        draft.seq = seq;
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Request failed.' };
    }

    return { ok: true, event: draft, ...(inviteUrlOut ? { inviteUrl: inviteUrlOut } : {}) };
  }

  /** Owner-only: mints a fresh invite link for an existing participant. */
  async createInvite(publicKey: string): Promise<ApiResult & { inviteUrl?: string }> {
    if (this.you?.role !== 'owner') return { ok: false, error: 'Owners only.' };
    try {
      const inviteId = randomId();
      await setDoc(inviteRef(this.auctionId, inviteId), { publicKey });
      return { ok: true, inviteUrl: inviteUrl(this.auctionId, inviteId) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not create a link.' };
    }
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
        auctionLength: parsed.data.auctionLengthSec,
      });
      return { ok: true, config: parsed.data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save rules.' };
    }
  }
}
