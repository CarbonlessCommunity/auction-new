import { describe, expect, it } from 'vitest';
import { AuctionAggregate } from '../src/shared/aggregate';
import { parseConfig } from '../src/shared/config';
import { makeAuction, startedAuction, SYSTEM, T0 } from './helpers';

describe('phases', () => {
  it('walks from not-started through extended time and last call to complete', () => {
    const ctx = makeAuction();
    const owner = ctx.addUser('Organiser', 'owner');
    ctx.addLot('12 Months');

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

describe('the default house clock', () => {
  it('runs a five-minute bidding period, with Extended Time at 1:30 and a 60s Last Call', () => {
    const { agg, config } = startedAuction();
    // `auctionLength` spans the whole run, so the clock a supplier reads is
    // always the remainder minus the Last Call window that follows it.
    const displayed = (offset: number) => agg.phase(T0 + offset).remainingSec - config.lastCallSec;

    expect(displayed(0)).toBe(5 * 60);
    expect(agg.phase(T0 + 209).isInExtendedTime).toBe(false);

    expect(agg.phase(T0 + 210).isInExtendedTime).toBe(true);
    expect(displayed(210)).toBe(90);

    expect(agg.phase(T0 + 300).isInLastCall).toBe(true);
    expect(agg.phase(T0 + 300).remainingSec).toBe(60);
  });

  /**
   * Every rule is read off the clock on screen, which is what an auctioneer
   * setting them is looking at. The threshold used to be measured against the
   * whole run, so a threshold of 90 put the Extended Time mark at 0:30 — the
   * clock said one thing and the setting meant another.
   */
  it('puts the Extended Time mark where the clock says, whatever the rules are set to', () => {
    const { agg, config } = startedAuction({ auctionLengthSec: 90, extendedTimeThresholdSec: 90 });
    const displayed = (offset: number) => agg.phase(T0 + offset).remainingSec - config.lastCallSec;

    expect(displayed(0)).toBe(90);
    // The mark is the whole clock here, so Extended Time is live from the off.
    expect(agg.phase(T0 + 1).isInExtendedTime).toBe(true);
    expect(agg.phase(T0 + 95).isInLastCall).toBe(true);
    expect(agg.phase(T0 + 160).isCompleted).toBe(true);
  });

  it('counts Last Call on top of the bidding clock, not out of it', () => {
    const { agg } = startedAuction({ auctionLengthSec: 120, lastCallSec: 30 });
    expect(agg.auctionLength).toBe(150);
    expect(agg.phase(T0 + 119).isInLastCall).toBe(false);
    expect(agg.phase(T0 + 121).isInLastCall).toBe(true);
  });
});

describe('limits', () => {
  it('caps the bidding firms and the contract terms', () => {
    const ctx = makeAuction();
    ctx.addUser('Organiser', 'owner');
    for (let i = 0; i < 12; i += 1) ctx.addUser(`Supplier ${i}`, 'bidder');

    expect(
      ctx.submit({ type: 'addUser', name: 'One too many', role: 'bidder', email: 'late@example.com' }, SYSTEM).ok,
    ).toBe(false);
    // The cap is on bidding firms, not on observers.
    expect(
      ctx.submit({ type: 'addUser', name: 'The client', role: 'viewer', email: 'client@example.com' }, SYSTEM).ok,
    ).toBe(true);

    for (let i = 0; i < 5; i += 1) ctx.addLot(`${(i + 1) * 12} Months`);
    expect(ctx.submit({ type: 'addLot', name: '72 Months' }, SYSTEM).ok).toBe(false);
  });

  it('refuses a new contract term once bidding has started', () => {
    const ctx = startedAuction();
    expect(ctx.submit({ type: 'addLot', name: '48 Months' }, ctx.owner, T0 + 10).ok).toBe(false);
  });
});

describe('replay', () => {
  it('reconstructs identical state by folding the event log', () => {
    const ctx = startedAuction({}, ['12 Months', '24 Months']);
    const second = ctx.lots[1];

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
    const ctx = startedAuction({}, ['12 Months', '24 Months']);
    const second = ctx.lots[1];

    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 1);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 80 }, ctx.bob, T0 + 2);
    ctx.submit({ type: 'placeBid', lotId: second, value: 500 }, ctx.alice, T0 + 3);

    const results = ctx.agg.results();
    expect(results).toHaveLength(2);

    expect(results[0].lot.name).toBe('12 Months');
    // Folding alone yields labels — real names are not in the log to be found.
    expect(results[0].winner?.label).toBe(ctx.bob.label);
    expect(results[0].winner?.name).toBe(ctx.bob.label);
    expect(results[0].bid?.value).toBe(80);
    expect(results[0].bidCount).toBe(2);

    expect(results[1].winner?.label).toBe(ctx.alice.label);
    expect(results[1].bidCount).toBe(1);

    // The auctioneer's client overlays the identity docs it was allowed to
    // read, which is the only route by which a name reaches a result row.
    ctx.agg.revealName(ctx.bob.publicKey, 'Bob');
    expect(ctx.agg.results()[0].winner?.name).toBe('Bob');
  });

  it('reports no winner for a lot nobody bid on', () => {
    const ctx = startedAuction();
    expect(ctx.agg.results()[0]).toMatchObject({ winner: null, bid: null, bidCount: 0 });
  });
});

describe('config', () => {
  it('rejects an Extended Time mark that falls off the end of the clock', () => {
    expect(() => parseConfig({ auctionLengthSec: 60, extendedTimeThresholdSec: 120, lastCallSec: 30 })).toThrow();
  });

  // Last Call runs after the clock reaches zero, so its length is independent
  // of where the Extended Time mark sits — a long Last Call is legal.
  it('allows a Last Call longer than the Extended Time mark', () => {
    const config = parseConfig({ auctionLengthSec: 300, extendedTimeThresholdSec: 30, lastCallSec: 120 });
    expect(config.lastCallSec).toBe(120);
  });
});

describe('pausing the clock', () => {
  it('freezes the countdown and refuses bids until resumed', () => {
    const { agg, submit, owner, alice, lot } = startedAuction();
    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 10);

    const paused = submit({ type: 'pauseAuction' }, owner, T0 + 60);
    expect(paused.ok).toBe(true);

    // 240s remain on the clock whenever it is read, however long the pause runs.
    expect(agg.phase(T0 + 61).isPaused).toBe(true);
    expect(agg.phase(T0 + 61).isRunning).toBe(false);
    expect(agg.phase(T0 + 61).remainingSec).toBe(300);
    expect(agg.phase(T0 + 5000).remainingSec).toBe(300);
    expect(agg.phase(T0 + 5000).isCompleted).toBe(false);

    const blocked = submit({ type: 'placeBid', lotId: lot, value: 90 }, alice, T0 + 70);
    expect(blocked.ok).toBe(false);

    // Resumed after a two-minute pause: the run is 120s longer, the clock reads the same.
    const resumed = submit({ type: 'resumeAuction' }, owner, T0 + 180);
    expect(resumed.ok && resumed.event.auctionLength).toBe(360 + 120);
    expect(agg.phase(T0 + 180).isRunning).toBe(true);
    expect(agg.phase(T0 + 180).remainingSec).toBe(300);
    expect(agg.phase(T0 + 181).isPaused).toBe(false);

    expect(submit({ type: 'placeBid', lotId: lot, value: 90 }, alice, T0 + 190).ok).toBe(true);
    // The whole run now ends 120s later than it would have.
    expect(agg.phase(T0 + 479).isRunning).toBe(true);
    expect(agg.phase(T0 + 480).isCompleted).toBe(true);
  });

  it('holds Last Call open, and blind, while paused inside it', () => {
    const { agg, submit, owner, alice, bob, lot } = startedAuction();
    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 10);
    submit({ type: 'placeBid', lotId: lot, value: 90 }, bob, T0 + 20);

    const inLastCall = T0 + 320;
    const blind = submit({ type: 'placeBid', lotId: lot, value: 80 }, alice, inLastCall);
    expect(blind.ok).toBe(true);
    expect(submit({ type: 'pauseAuction' }, owner, inLastCall + 5).ok).toBe(true);

    const phase = agg.phase(inLastCall + 30);
    expect(phase.isPaused).toBe(true);
    expect(phase.isInLastCall).toBe(true);
    expect(phase.remainingSec).toBe(35);
    // Bob still cannot see Alice's blind bid, and the window does not close.
    expect(agg.isBlindWindow(inLastCall + 30)).toBe(true);
    expect(agg.visibleBestFor(lot, bob, inLastCall + 30)?.value).toBe(90);

    submit({ type: 'resumeAuction' }, owner, inLastCall + 65);
    expect(agg.phase(inLastCall + 65).remainingSec).toBe(35);
    expect(agg.phase(inLastCall + 65).isInLastCall).toBe(true);
  });

  it('refuses a pause before the start, after the end, or on top of another', () => {
    const ctx = makeAuction();
    const owner = ctx.addUser('Organiser', 'owner');
    ctx.addLot('12 Months');
    expect(ctx.submit({ type: 'pauseAuction' }, owner, T0).ok).toBe(false);
    expect(ctx.submit({ type: 'resumeAuction' }, owner, T0).ok).toBe(false);

    ctx.submit({ type: 'startAuction' }, owner, T0);
    expect(ctx.submit({ type: 'pauseAuction' }, owner, T0 + 10).ok).toBe(true);
    expect(ctx.submit({ type: 'pauseAuction' }, owner, T0 + 11).ok).toBe(false);
    expect(ctx.submit({ type: 'resumeAuction' }, owner, T0 + 12).ok).toBe(true);
    expect(ctx.submit({ type: 'resumeAuction' }, owner, T0 + 13).ok).toBe(false);

    expect(ctx.submit({ type: 'pauseAuction' }, owner, T0 + 1000).ok).toBe(false);
  });

  it('replays to the same clock', () => {
    const ctx = startedAuction();
    ctx.submit({ type: 'pauseAuction' }, ctx.owner, T0 + 100);
    ctx.submit({ type: 'resumeAuction' }, ctx.owner, T0 + 150);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 160);

    const replayed = AuctionAggregate.replay('test', ctx.config, ctx.log);
    expect(replayed.auctionLength).toBe(ctx.agg.auctionLength);
    expect(replayed.pausedAt).toBeNull();
    expect(replayed.phase(T0 + 200)).toEqual(ctx.agg.phase(T0 + 200));
  });
});
