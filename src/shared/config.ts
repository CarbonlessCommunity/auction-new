import { z } from 'zod';
import type { AuctionConfig } from './types';
import { DEFAULT_CONFIG, MAX_BIDDERS } from './rules';

export { DEFAULT_CONFIG };

export const configSchema = z
  .object({
    bidDirection: z.enum(['reverse', 'forward']).default(DEFAULT_CONFIG.bidDirection),
    auctionLengthSec: z.number().int().min(10).max(24 * 60 * 60).default(DEFAULT_CONFIG.auctionLengthSec),
    extendedTimeThresholdSec: z.number().int().min(0).max(24 * 60 * 60).default(DEFAULT_CONFIG.extendedTimeThresholdSec),
    lastCallSec: z.number().int().min(0).max(24 * 60 * 60).default(DEFAULT_CONFIG.lastCallSec),
    lastCallBidders: z.number().int().min(0).max(MAX_BIDDERS).default(DEFAULT_CONFIG.lastCallBidders),
    minBidStep: z.number().min(0).default(DEFAULT_CONFIG.minBidStep),
  })
  .superRefine((cfg, ctx) => {
    // Both are read off the main clock now, so the only relationship that has
    // to hold is that the Extended Time mark falls somewhere on it. Last Call
    // runs after that clock reaches zero and is independent of the threshold.
    if (cfg.extendedTimeThresholdSec > cfg.auctionLengthSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extendedTimeThresholdSec'],
        message: 'extendedTimeThresholdSec must be less than or equal to auctionLengthSec',
      });
    }
  });

export function parseConfig(input: unknown): AuctionConfig {
  return configSchema.parse({ ...DEFAULT_CONFIG, ...(input as object | undefined) });
}
