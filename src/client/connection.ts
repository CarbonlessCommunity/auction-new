import { deleteDoc, getDoc, getDocFromServer, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { normalizeEmail, reloadUser } from './auth';
import { isAdminEmail } from '../shared/admins';
import { AuctionAggregate, type Participant } from '../shared/aggregate';
import { configSchema } from '../shared/config';
import { totalRunSec } from '../shared/rules';
import { parseInboundEvent } from '../shared/schemas';
import { filterOutbound, validateInbound } from '../shared/validation';
import type { AuctionConfig, AuctionEvent, AuctionMeta, InboundEventInput, Role, UserView } from '../shared/types';
import {
  type ApiResult,
  type AuctionDocData,
  type IdentityDocData,
  type PresenceDocData,
  type SeatDocData,
  type UserDocData,
  auctionRef,
  eventRef,
  eventsCol,
  identitiesCol,
  identityRef,
  mirrorUpdate,
  NotSignedInError,
  ONLINE_WINDOW_SEC,
  HEARTBEAT_SEC,
  presenceCol,
  presenceRef,
  requireUser,
  seatRef,
  userRef,
} from './store';

export { HEARTBEAT_SEC, ONLINE_WINDOW_SEC } from './store';

/** Force one ID-token refresh per session, so a fresh verification click reaches the rules. */
let adminTokenRefreshed = false;

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
    const agg = this.foldFor(this.rawEvents);
    if (agg) this.agg = agg;
  }

  /** `refold`, over any log — `submit` uses it on the log as it stands mid-transaction. */
  private foldFor(events: AuctionEvent[]): AuctionAggregate | null {
    const config = this.auctionData?.config ?? this.auction?.config;
    if (!config || !this.you) return null;

    const truth = AuctionAggregate.replay(this.auctionId, config, events);
    const viewer: Participant = { publicKey: this.you.publicKey, role: this.you.role };
    const now = this.now();

    const visible: AuctionEvent[] = [];
    for (const event of events) {
      const filtered = filterOutbound(truth, event, viewer, now);
      if (filtered) visible.push(filtered);
    }

    const agg = AuctionAggregate.replay(this.auctionId, config, visible);
    // The fold only ever produces labels. Real names come from the identity
    // docs Firestore actually let this viewer read, so a supplier's board can
    // never name a rival however the client is tampered with.
    for (const [publicKey, name] of this.identities) agg.revealName(publicKey, name);
    return agg;
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
    /** The event as it actually landed — re-validated inside the transaction if the log had moved. */
    let appended: AuctionEvent | null = null;
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
        let event: AuctionEvent = { ...draft, seq };

        // The check above ran against the board as this browser last saw it.
        // If anything has landed since — the log is gapless, so that is
        // exactly the events numbered from what we hold up to `seq` — read
        // them here, inside the transaction, and judge the bid again against
        // the board as it actually stands. Otherwise two suppliers answering
        // the same price in the same second both pass, and the second to land
        // does not beat the first: legal on every screen, wrong in the audit.
        const isBid = event.type === 'placeBid' || event.type === 'cancelBid';
        if (isBid && seq > this.rawEvents.length) {
          const landed: AuctionEvent[] = [];
          for (let s = this.rawEvents.length; s < seq; s += 1) {
            const doc = await tx.get(eventRef(this.auctionId, s));
            if (doc.exists()) landed.push(doc.data() as AuctionEvent);
          }
          const current = this.foldFor([...this.rawEvents, ...landed]);
          if (current) {
            const again = validateInbound(current, parsed.input, actor, this.now(), seq);
            if (!again.ok) throw new Error(again.error);
            event = again.event;
          }
        }

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

        appended = event;
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Request failed.' };
    }

    return { ok: true, event: appended ?? draft, ...(invitedEmail ? { invitedEmail } : {}) };
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
