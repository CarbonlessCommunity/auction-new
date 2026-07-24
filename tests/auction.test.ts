import { describe, expect, it } from 'vitest';
import { AuctionAggregate } from '../src/shared/aggregate';
import { parseConfig } from '../src/server/config';
import { makeAuction, startedAuction, T0 } from './helpers';

describe('phases', () => {
  it('walks from not-started through extended time and last call to complete', () => {
    const ctx = makeAuction();
    const owner = ctx.addUser('Organiser', 'owner');
    ctx.addLot('Lane 1');

    expect(ctx.agg.phase(T0).isRunning).toBe(false);

    ctx.submit({ type: 'startAuction' }, owner, T0);
    const at = (offset: number) => ctx.agg.phase(T0 + offset);

    expect(at(10).isRunning).toBe(true);
    expect(at(10).isInExtendedTime).toBe(false);

    expect(at(250).isInExtendedTime).toBe(true); // 110s left, under the 150 threshold
    expect(at(250).isInLastCall).toBe(false);

    expect(at(330).isInLastCall).toBe(true); // 30s left
    expect(at(330).isInExtendedTime).toBe(false);

    expect(at(400).isRunning).toBe(false);
    expect(at(400).isCompleted).toBe(true);
  });

  it('keeps bids blind after the clock stops, until results are released', () => {
    const { agg, submit, owner } = startedAuction();
    const afterEnd = T0 + 400;

    expect(agg.isBlindWindow(afterEnd)).toBe(true);
    submit({ type: 'showResults' }, owner, afterEnd);
    expect(agg.isBlindWindow(afterEnd)).toBe(false);
  });
});

describe('replay', () => {
  it('reconstructs identical state by folding the event log', () => {
    const ctx = startedAuction();
    const second = ctx.addLot('Lane 2');

    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 10);
    ctx.submit({ type: 'placeBid', lotId: second, value: 900 }, ctx.bob, T0 + 20);
    // Inside the extended-time threshold, so this one rewrites the clock.
    const extending = ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 80 }, ctx.bob, T0 + 260);
    if (!extending.ok) throw new Error(extending.error);
    ctx.submit({ type: 'cancelBid', bidSeq: extending.event.seq }, ctx.owner, T0 + 270);

    const rebuilt = AuctionAggregate.replay('test', ctx.config, ctx.log);

    expect(rebuilt.name).toBe(ctx.agg.name);
    expect(rebuilt.startTime).toBe(ctx.agg.startTime);
    // The extension survives even though the bid that caused it was cancelled.
    expect(rebuilt.auctionLength).toBe(410);
    expect(rebuilt.auctionLength).toBe(ctx.agg.auctionLength);
    expect(rebuilt.activeBids()).toEqual(ctx.agg.activeBids());
    expect(rebuilt.results()).toEqual(ctx.agg.results());
  });
});

describe('results', () => {
  it('picks the winner per lot and counts bids', () => {
    const ctx = startedAuction();
    const second = ctx.addLot('Lane 2');

    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 1);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 80 }, ctx.bob, T0 + 2);
    ctx.submit({ type: 'placeBid', lotId: second, value: 500 }, ctx.alice, T0 + 3);

    const results = ctx.agg.results();
    expect(results).toHaveLength(2);

    expect(results[0].lot.name).toBe('Lane 1');
    expect(results[0].winner?.name).toBe('Bob');
    expect(results[0].bid?.value).toBe(80);
    expect(results[0].bidCount).toBe(2);

    expect(results[1].winner?.name).toBe('Alice');
    expect(results[1].bidCount).toBe(1);
  });

  it('reports no winner for a lot nobody bid on', () => {
    const ctx = startedAuction();
    expect(ctx.agg.results()[0]).toMatchObject({ winner: null, bid: null, bidCount: 0 });
  });
});

describe('config', () => {
  it('rejects a last call longer than the extended-time threshold', () => {
    expect(() => parseConfig({ lastCallSec: 200, extendedTimeThresholdSec: 100 })).toThrow();
  });

  it('rejects a threshold longer than the auction itself', () => {
    expect(() => parseConfig({ auctionLengthSec: 60, extendedTimeThresholdSec: 120, lastCallSec: 30 })).toThrow();
  });
});
