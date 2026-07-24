import type { AuctionConfig } from './types';

/**
 * Rule constants that were hardcoded in the original `validation.py`
 * (`6 * 60`, `150`, `60`) are now per-auction configuration. These defaults
 * reproduce the original behaviour exactly.
 */
export const DEFAULT_CONFIG: AuctionConfig = {
  bidDirection: 'reverse',
  auctionLengthSec: 6 * 60,
  extendedTimeThresholdSec: 150,
  lastCallSec: 60,
  minBidStep: 0,
};

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
