import type { AuctionConfig, AuctionEvent, AuctionPhase, Role } from './types';
import { beatsBest, participantLabel, totalRunSec } from './rules';

/**
 * The minimum needed to answer "who is acting / who is looking" — all the
 * inbound and outbound rules ever need. Deliberately carries no name: nothing
 * about validation or visibility may depend on a participant's identity.
 */
export interface Participant {
  publicKey: string;
  role: Role;
}

export interface StoredUser extends Participant {
  /** Nondescript public identity ("Supplier B"), assigned at signup. */
  label: string;
  /** Palette slot, assigned in signup order within the role. */
  colorIndex: number;
  /**
   * What the *current viewer* may call this participant. Defaults to `label`;
   * the connection overlays a real name only for the identities this viewer is
   * entitled to read (the auctioneer, an observer, or yourself). Real names are
   * never in the event log, so folding alone can never reveal one.
   */
  name: string;
}

export interface StoredLot {
  id: string;
  name: string;
  insertionOrder: number;
}

export interface StoredBid {
  seq: number;
  lotId: string;
  bidder: string;
  value: number;
  time: number;
}

/**
 * The derived state of an auction, rebuilt by folding its event log. This is
 * the TypeScript descendant of the pickled `Validator` object in the original
 * `validation.py` — but it is a pure fold over events, so it can always be
 * reconstructed from the log rather than trusted as stored state.
 *
 * Both sides run this same class: the server folds the full log, each client
 * folds the outbound-filtered log it was sent. That is deliberate — it is the
 * client's view that must match what the server believes it can see, and
 * sharing the fold removes any chance of the two drifting apart.
 */
export class AuctionAggregate {
  readonly id: string;
  config: AuctionConfig;
  name = 'Untitled Auction';
  users = new Map<string, StoredUser>();
  lots = new Map<string, StoredLot>();
  bids: StoredBid[] = [];
  cancelledBids = new Set<number>();
  startTime: number | null = null;
  /** The whole run in seconds — main clock plus Last Call, extensions included. */
  auctionLength: number;
  /**
   * The instant the auctioneer stopped the clock, or null while it runs. While
   * set, every clock reading is taken *as of this instant* rather than now, so
   * the board holds exactly where it was; a resume adds the pause's length to
   * `auctionLength`, which puts the clock back where it stopped.
   */
  pausedAt: number | null = null;
  showResultsReleased = false;

  constructor(id: string, config: AuctionConfig) {
    this.id = id;
    this.config = config;
    this.auctionLength = totalRunSec(config);
  }

  static replay(id: string, config: AuctionConfig, events: AuctionEvent[]): AuctionAggregate {
    const agg = new AuctionAggregate(id, config);
    for (const event of events) agg.apply(event);
    return agg;
  }

  /** Folds a single canonical (already validated and enriched) event into state. */
  apply(event: AuctionEvent): void {
    switch (event.type) {
      case 'setName':
        this.name = event.name as string;
        break;

      case 'addUser': {
        const role = event.role as Role;
        // Logs written before identities were split out carry the real name and
        // no label; derive one rather than replaying a name into the board.
        const index = this.countRole(role);
        const label = typeof event.label === 'string' ? event.label : participantLabel(role, index);
        const colorIndex = typeof event.colorIndex === 'number' ? event.colorIndex : index;
        this.users.set(event.publicKey as string, {
          publicKey: event.publicKey as string,
          role,
          label,
          colorIndex,
          name: label,
        });
        break;
      }

      case 'addLot':
        this.lots.set(event.lotId as string, {
          id: event.lotId as string,
          name: event.name as string,
          insertionOrder: this.lots.size,
        });
        break;

      case 'renameLot': {
        const lot = this.lots.get(event.lotId as string);
        if (lot) lot.name = event.name as string;
        break;
      }

      case 'placeBid':
        this.bids.push({
          seq: event.seq,
          lotId: event.lotId as string,
          bidder: event.bidder as string,
          value: event.value as number,
          time: event.time,
        });
        // A bid that triggered an Extended Time reset carries the new length,
        // so replaying the log reproduces the clock exactly.
        if (typeof event.auctionLength === 'number') this.auctionLength = event.auctionLength;
        break;

      case 'cancelBid': {
        // A supplier may withdraw a bid of their own, so a cancellation now
        // names the bid's owner. Security rules can only check that a
        // non-owner's cancellation names *themselves* — they cannot follow
        // `bidSeq` to the bid it points at — so the fold does the other half:
        // a cancellation whose named owner is not the target bid's actual
        // bidder is ignored on every screen, which leaves a forged one
        // affecting nothing.
        const seq = event.bidSeq as number;
        const target = this.bids.find((bid) => bid.seq === seq);
        if (target && typeof event.bidder === 'string' && target.bidder !== event.bidder) break;
        this.cancelledBids.add(seq);
        break;
      }

      case 'startAuction':
        this.startTime = event.time;
        this.auctionLength = event.auctionLength as number;
        break;

      case 'pauseAuction':
        this.pausedAt = event.time;
        break;

      case 'resumeAuction':
        this.pausedAt = null;
        // Carries the stretched run, like an Extended Time bid, so a replay
        // reproduces the clock without re-deriving the pause's length.
        if (typeof event.auctionLength === 'number') this.auctionLength = event.auctionLength;
        break;

      case 'showResults':
        this.showResultsReleased = true;
        break;
    }
  }

  /** How many participants of `role` are already on the roster. */
  countRole(role: Role): number {
    let total = 0;
    for (const user of this.users.values()) if (user.role === role) total += 1;
    return total;
  }

  /**
   * Attaches a real name to a participant, for the identities this viewer was
   * allowed to fetch. Everyone else keeps their label, which is all the fold
   * ever produced.
   */
  revealName(publicKey: string, name: string): void {
    const user = this.users.get(publicKey);
    if (user) user.name = name;
  }

  // --- clock -------------------------------------------------------------

  get endTime(): number | null {
    return this.startTime === null ? null : this.startTime + this.auctionLength;
  }

  /**
   * The instant the clock is read at: now, or — while paused — the instant it
   * stopped. Every clock question goes through this, so a pause freezes the
   * phase, the countdown and the blind window alike.
   */
  clockNow(now: number): number {
    return this.pausedAt === null ? now : Math.min(now, this.pausedAt);
  }

  remaining(now: number): number {
    if (this.startTime === null) return this.auctionLength;
    return this.startTime + this.auctionLength - this.clockNow(now);
  }

  /**
   * Seconds left on the *main* clock — the one every participant is watching,
   * which reaches zero as Last Call opens. `extendedTimeThresholdSec` is a mark
   * on this clock, not on the total run: with a 90s threshold, Extended Time
   * begins when the clock reads 1:30. Goes negative inside Last Call.
   */
  mainRemaining(now: number): number {
    return this.remaining(now) - this.config.lastCallSec;
  }

  /**
   * The instant the blind "Last Call" window opens. Extended Time resets can
   * only happen strictly before this point, so once the window is open this
   * value is stable.
   */
  blindStart(): number | null {
    if (this.startTime === null) return null;
    return this.startTime + this.auctionLength - this.config.lastCallSec;
  }

  /**
   * True while bids are blind: from the start of Last Call until the owner
   * releases results. Deliberately stays true after the clock hits zero — the
   * original held results back for "a brief delay" after Last Call too.
   */
  isBlindWindow(now: number): boolean {
    const start = this.blindStart();
    if (start === null || this.showResultsReleased) return false;
    return this.clockNow(now) >= start;
  }

  phase(now: number): AuctionPhase {
    const { lastCallSec, extendedTimeThresholdSec } = this.config;
    const remaining = this.remaining(now);
    const started = this.startTime !== null;
    // Where the clock stands — which stretch of the run it is in — is the same
    // paused or not; only whether it is *moving* differs. So a pause inside
    // Last Call still reads as Last Call (the board stays blind), but nothing
    // that needs a running clock, a bid above all, is allowed through.
    const live = started && remaining > 0;
    const isPaused = live && this.pausedAt !== null;

    return {
      isRunning: live && !isPaused,
      isPaused,
      isInLastCall: live && remaining <= lastCallSec,
      isInExtendedTime: live && remaining > lastCallSec && remaining - lastCallSec <= extendedTimeThresholdSec,
      isCompleted: started && remaining <= 0,
      startTime: this.startTime,
      auctionLength: this.auctionLength,
      remainingSec: started ? remaining : this.auctionLength,
    };
  }

  // --- bids --------------------------------------------------------------

  activeBids(): StoredBid[] {
    return this.bids.filter((bid) => !this.cancelledBids.has(bid.seq));
  }

  bidsForLot(lotId: string): StoredBid[] {
    return this.activeBids().filter((bid) => bid.lotId === lotId);
  }

  /**
   * Each supplier's own best bid on a lot, leader first — one row per bidder,
   * which is how the board ladders them. `before` restricts the fold to bids
   * placed strictly earlier than that instant.
   */
  standings(lotId: string, before?: number): StoredBid[] {
    const best = new Map<string, StoredBid>();
    for (const bid of this.bidsForLot(lotId)) {
      if (before !== undefined && bid.time >= before) continue;
      const current = best.get(bid.bidder);
      if (!current || beatsBest(bid.value, current.value, this.config)) best.set(bid.bidder, bid);
    }
    return [...best.values()].sort((a, b) =>
      this.config.bidDirection === 'reverse' ? a.value - b.value : b.value - a.value,
    );
  }

  /** The true leading bid for a lot, ignoring visibility rules. */
  bestBidFor(lotId: string): StoredBid | null {
    let best: StoredBid | null = null;
    for (const bid of this.bidsForLot(lotId)) {
      if (best === null || beatsBest(bid.value, best.value, this.config)) best = bid;
    }
    return best;
  }

  /**
   * The public keys of the suppliers still allowed to bid on `lotId` during
   * Last Call — the `lastCallBidders` leaders as the standings stood the
   * instant the window opened, so a blind bid placed inside it can never
   * change who is entitled to answer it.
   *
   * Returns null when the restriction does not apply: the rule is switched
   * off, the window has not opened, or too few suppliers had bid on this term
   * to name a leading pair — narrowing to nobody would simply strand a term
   * nobody wanted. Cancelling a bid re-ranks this, which is what lets the
   * auctioneer undo a mistaken bid that pushed the wrong supplier into the
   * final two.
   */
  lastCallEligible(lotId: string): string[] | null {
    const keep = this.config.lastCallBidders;
    const start = this.blindStart();
    if (keep <= 0 || start === null) return null;

    const ranked = this.standings(lotId, start);
    if (ranked.length < keep) return null;
    return ranked.slice(0, keep).map((bid) => bid.bidder);
  }

  /** True when `viewer` is not allowed to see `bid` (blind Last Call rule). */
  isBidHiddenFrom(bid: StoredBid, viewer: Participant, now: number): boolean {
    if (viewer.role === 'owner') return false;
    if (bid.bidder === viewer.publicKey) return false;
    if (!this.isBlindWindow(now)) return false;

    const start = this.blindStart();
    // Only bids placed *during* the blind window are hidden; bids everyone
    // already saw before Last Call stay on the board.
    return start !== null && bid.time >= start;
  }

  /**
   * The best bid a given user is actually allowed to see. Inbound bids are
   * validated against this rather than the true best, so a bidder can never
   * infer a rival's hidden Last Call bid from a rejection.
   */
  visibleBestFor(lotId: string, viewer: Participant, now: number): StoredBid | null {
    let best: StoredBid | null = null;
    for (const bid of this.bidsForLot(lotId)) {
      if (this.isBidHiddenFrom(bid, viewer, now)) continue;
      if (best === null || beatsBest(bid.value, best.value, this.config)) best = bid;
    }
    return best;
  }

  /** Final results per lot, in board order. Used for the owner's CSV export. */
  results(): Array<{ lot: StoredLot; winner: StoredUser | null; bid: StoredBid | null; bidCount: number }> {
    return [...this.lots.values()]
      .sort((a, b) => a.insertionOrder - b.insertionOrder)
      .map((lot) => {
        const bid = this.bestBidFor(lot.id);
        return {
          lot,
          bid,
          winner: bid ? this.users.get(bid.bidder) ?? null : null,
          bidCount: this.bidsForLot(lot.id).length,
        };
      });
  }
}
