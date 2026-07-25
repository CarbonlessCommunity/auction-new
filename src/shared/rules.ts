import type { AuctionConfig } from './types';

/**
 * Rule constants that were hardcoded in the original `validation.py` are now
 * per-auction configuration. The defaults are the energy-auction house rules:
 * a five-minute bidding period, "Extended Time" under 1:30, then a 60-second
 * "Last Call" open only to the two leading suppliers per contract term.
 *
 * Note that `auctionLengthSec` spans the *whole* run — the main clock plus
 * Last Call — so 360 shows a 5:00 clock counting down to the Last Call window,
 * and `extendedTimeThresholdSec` of 150 puts the Extended Time mark at 1:30 on
 * that same displayed clock.
 */
export const DEFAULT_CONFIG: AuctionConfig = {
  bidDirection: 'reverse',
  auctionLengthSec: 5 * 60 + 60,
  extendedTimeThresholdSec: 90 + 60,
  lastCallSec: 60,
  lastCallBidders: 2,
  minBidStep: 0,
};

/** Product limits from the auction spec: one board, many firms and terms. */
export const MAX_BIDDERS = 12;
export const MAX_LOTS = 5;

/**
 * True when `candidate` beats `best`. A bid must always be a strict
 * improvement (the original rejected equal bids), and must clear `minBidStep`
 * when one is configured.
 */
export function beatsBest(candidate: number, best: number | null, config: AuctionConfig): boolean {
  if (best === null) return true;
  const delta = config.bidDirection === 'reverse' ? best - candidate : candidate - best;
  return delta > 0 && delta >= config.minBidStep;
}
