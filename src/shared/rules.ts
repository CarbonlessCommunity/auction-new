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
 * Prices here are decimal quantities entered by hand ($/kWh, usually to four or
 * five places), but they travel as IEEE-754 doubles, where the difference of two
 * such decimals is only approximately the decimal difference. Raw subtraction
 * therefore cannot be compared against `minBidStep`: 0.0701 - 0.07 evaluates to
 * 0.00009999999999998899, which is *less* than a 0.0001 step, so a supplier
 * bidding exactly one legal step better would be refused — while 0.0712 -
 * 0.0711 lands just above and is allowed. Same intent, opposite outcome,
 * decided by representation error the bidder cannot see.
 *
 * Rounding the delta to 10 decimal places snaps it back to the decimal value a
 * human would compute. That is far finer than any real bid increment and far
 * coarser than the error being removed (~1e-17 at these magnitudes).
 */
const PRICE_QUANTUM = 1e10;

function decimalDelta(candidate: number, best: number, config: AuctionConfig): number {
  const raw = config.bidDirection === 'reverse' ? best - candidate : candidate - best;
  return Math.round(raw * PRICE_QUANTUM) / PRICE_QUANTUM;
}

/**
 * True when `candidate` beats `best`. A bid must always be a strict
 * improvement (the original rejected equal bids), and must clear `minBidStep`
 * when one is configured.
 */
export function beatsBest(candidate: number, best: number | null, config: AuctionConfig): boolean {
  if (best === null) return true;
  const delta = decimalDelta(candidate, best, config);
  return delta > 0 && delta >= config.minBidStep;
}
