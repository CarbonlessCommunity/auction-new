import { z } from 'zod';
import type { AuctionConfig } from '../shared/types';
import { DEFAULT_CONFIG } from '../shared/rules';

export { DEFAULT_CONFIG };

export const configSchema = z
  .object({
    bidDirection: z.enum(['reverse', 'forward']).default(DEFAULT_CONFIG.bidDirection),
    auctionLengthSec: z.number().int().min(10).max(24 * 60 * 60).default(DEFAULT_CONFIG.auctionLengthSec),
    extendedTimeThresholdSec: z.number().int().min(0).max(24 * 60 * 60).default(DEFAULT_CONFIG.extendedTimeThresholdSec),
    lastCallSec: z.number().int().min(0).max(24 * 60 * 60).default(DEFAULT_CONFIG.lastCallSec),
    minBidStep: z.number().min(0).default(DEFAULT_CONFIG.minBidStep),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.lastCallSec > cfg.extendedTimeThresholdSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastCallSec'],
        message: 'lastCallSec must be less than or equal to extendedTimeThresholdSec',
      });
    }
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
