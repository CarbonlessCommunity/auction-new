import { describe, expect, it } from 'vitest';
import { beatsBest } from '../src/shared/rules';
import { parseConfig } from '../src/shared/config';
import { startedAuction, T0 } from './helpers';

const reverse = (minBidStep: number) => parseConfig({ bidDirection: 'reverse', minBidStep });
const forward = (minBidStep: number) => parseConfig({ bidDirection: 'forward', minBidStep });

describe('beatsBest', () => {
  it('accepts any bid when there is no standing best', () => {
    expect(beatsBest(0.07, null, reverse(0))).toBe(true);
  });

  it('requires a strict improvement, refusing an equal bid', () => {
    expect(beatsBest(0.07, 0.07, reverse(0))).toBe(false);
    expect(beatsBest(0.07, 0.07, forward(0))).toBe(false);
  });

  it('reads the direction from the config', () => {
    expect(beatsBest(0.069, 0.07, reverse(0))).toBe(true);
    expect(beatsBest(0.071, 0.07, reverse(0))).toBe(false);
    expect(beatsBest(0.071, 0.07, forward(0))).toBe(true);
    expect(beatsBest(0.069, 0.07, forward(0))).toBe(false);
  });

  /**
   * Every case below is exactly one legal step better, so every one must be
   * accepted. Before the delta was quantised, half of them were refused — the
   * raw double subtraction lands just under the step as often as just over it,
   * and which way it falls is invisible to the person typing the number.
   */
  describe('decimal steps a supplier would actually type', () => {
    const oneStepBetter: Array<[string, number, number, number]> = [
      ['$/kWh to 4dp, delta lands low', 0.07, 0.0701, 0.0001],
      ['$/kWh to 4dp, delta lands high', 0.0711, 0.0712, 0.0001],
      ['small magnitudes', 0.0002, 0.0003, 0.0001],
      ['cents off a whole dollar', 29.99, 30.0, 0.01],
      ['a tenth off', 1.1, 1.2, 0.1],
      ['three decimal places', 0.128, 0.129, 0.001],
      ['five decimal places', 0.07124, 0.07125, 0.00001],
    ];

    for (const [label, candidate, best, step] of oneStepBetter) {
      it(`accepts a bid exactly one step better: ${label}`, () => {
        expect(beatsBest(candidate, best, reverse(step))).toBe(true);
      });

      it(`accepts the mirrored forward bid: ${label}`, () => {
        expect(beatsBest(best, candidate, forward(step))).toBe(true);
      });
    }
  });

  it('still refuses an improvement smaller than the step', () => {
    expect(beatsBest(0.07005, 0.0701, reverse(0.0001))).toBe(false);
    expect(beatsBest(29.995, 30.0, reverse(0.01))).toBe(false);
  });

  it('does not let quantisation invent an improvement out of noise', () => {
    // Closer together than the 1e-10 quantum: rounds to zero, not a win.
    expect(beatsBest(0.07 - 1e-12, 0.07, reverse(0))).toBe(false);
  });
});

describe('minBidStep through the inbound validator', () => {
  it('accepts a bid exactly one decimal step better', () => {
    const { submit, alice, bob, lot } = startedAuction({ minBidStep: 0.0001 });

    const first = submit({ type: 'placeBid', lotId: lot, value: 0.0701 }, alice, T0 + 5);
    expect(first.ok).toBe(true);

    const second = submit({ type: 'placeBid', lotId: lot, value: 0.07 }, bob, T0 + 10);
    expect(second.ok).toBe(true);
  });

  it('still rejects a bid that does not clear the step', () => {
    const { submit, alice, bob, lot } = startedAuction({ minBidStep: 0.0001 });

    expect(submit({ type: 'placeBid', lotId: lot, value: 0.0701 }, alice, T0 + 5).ok).toBe(true);

    const tooSmall = submit({ type: 'placeBid', lotId: lot, value: 0.07005 }, bob, T0 + 10);
    expect(tooSmall.ok).toBe(false);
  });
});
