import type { AuctionConfig, Role } from './types';

/**
 * Rule constants that were hardcoded in the original `validation.py` are now
 * per-auction configuration. The defaults are the energy-auction house rules:
 * a five-minute bidding period, "Extended Time" under 1:30, then a 60-second
 * "Last Call" open only to the two leading suppliers per contract term.
 *
 * **Every number here is read off the clock a participant actually sees.**
 * `auctionLengthSec` is the main bidding clock and `extendedTimeThresholdSec`
 * is a mark on that same clock, so 90 means Extended Time starts when the
 * clock shows 1:30 — not 0:30. Last Call runs *after* the main clock reaches
 * zero, so the whole event lasts `auctionLengthSec + lastCallSec`; that total
 * is what {@link totalRunSec} returns and what the aggregate counts down
 * internally.
 */
export const DEFAULT_CONFIG: AuctionConfig = {
  bidDirection: 'reverse',
  auctionLengthSec: 5 * 60,
  extendedTimeThresholdSec: 90,
  lastCallSec: 60,
  lastCallBidders: 2,
  minBidStep: 0,
};

/** The whole event, end to end: the main bidding clock plus Last Call. */
export function totalRunSec(config: AuctionConfig): number {
  return config.auctionLengthSec + config.lastCallSec;
}

/** Product limits from the auction spec: one board, many firms and terms. */
export const MAX_BIDDERS = 12;
export const MAX_LOTS = 5;

/** A, B, … Z, AA, AB, … — spreadsheet-column lettering. */
function letters(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * The public identity a participant is known by. Suppliers are deliberately
 * nondescript and handed out in signup order — "Supplier A", "Supplier B" —
 * because a bidder must never learn *which firm* is behind a price, at any
 * point in the auction. The letter plus the colour assigned alongside it is
 * the whole of what a rival is allowed to know about them.
 *
 * `index` counts participants of that role only, so the suppliers run A, B, C
 * however many observers the auctioneer also invites.
 */
export function participantLabel(role: Role, index: number): string {
  if (role === 'bidder') return `Supplier ${letters(index)}`;
  if (role === 'viewer') return index === 0 ? 'Observer' : `Observer ${index + 1}`;
  return index === 0 ? 'Auctioneer' : `Auctioneer ${index + 1}`;
}

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
