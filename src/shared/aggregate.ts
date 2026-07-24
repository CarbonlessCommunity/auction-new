import type { AuctionConfig, AuctionEvent, AuctionPhase, Role } from './types';
import { beatsBest } from './rules';

export interface StoredUser {
  publicKey: string;
  role: Role;
  name: string;
  email?: string;
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
  auctionLength: number;
  showResultsReleased = false;

  constructor(id: string, config: AuctionConfig) {
    this.id = id;
    this.config = config;
    this.auctionLength = config.auctionLengthSec;
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
        const user: StoredUser = {
          publicKey: event.publicKey as string,
          role: event.role as Role,
          name: event.name as string,
        };
        if (typeof event.email === 'string') user.email = event.email;
        this.users.set(user.publicKey, user);
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

      case 'cancelBid':
        this.cancelledBids.add(event.bidSeq as number);
        break;

      case 'startAuction':
        this.startTime = event.time;
        this.auctionLength = event.auctionLength as number;
        break;

      case 'showResults':
        this.showResultsReleased = true;
        break;
    }
  }

  // --- clock -------------------------------------------------------------

  get endTime(): number | null {
    return this.startTime === null ? null : this.startTime + this.auctionLength;
  }

  remaining(now: number): number {
    if (this.startTime === null) return this.auctionLength;
    return this.startTime + this.auctionLength - now;
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
    return now >= start;
  }

  phase(now: number): AuctionPhase {
    const { lastCallSec, extendedTimeThresholdSec } = this.config;
    const remaining = this.remaining(now);
    const started = this.startTime !== null;
    const isRunning = started && remaining > 0;

    return {
      isRunning,
      isInLastCall: isRunning && remaining <= lastCallSec,
      isInExtendedTime: isRunning && remaining <= extendedTimeThresholdSec && remaining > lastCallSec,
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

  /** The true leading bid for a lot, ignoring visibility rules. */
  bestBidFor(lotId: string): StoredBid | null {
    let best: StoredBid | null = null;
    for (const bid of this.bidsForLot(lotId)) {
      if (best === null || beatsBest(bid.value, best.value, this.config)) best = bid;
    }
    return best;
  }

  /** True when `viewer` is not allowed to see `bid` (blind Last Call rule). */
  isBidHiddenFrom(bid: StoredBid, viewer: StoredUser, now: number): boolean {
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
  visibleBestFor(lotId: string, viewer: StoredUser, now: number): StoredBid | null {
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
