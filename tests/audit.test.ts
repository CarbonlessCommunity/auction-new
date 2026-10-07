import { describe, expect, it } from 'vitest';
import { auditLog } from '../src/shared/audit';
import type { AuctionEvent } from '../src/shared/types';
import { startedAuction, T0 } from './helpers';

/**
 * The audit replays a stored log and asks whether the validator would have
 * accepted each event. A log built *through* the validator must pass clean;
 * a log with a hand-crafted write in it must name that write and nothing else.
 */

/** A genuine, busy log: two suppliers trading the lead into Extended Time. */
function genuine() {
  const ctx = startedAuction({ minBidStep: 0.0001 }, ['12 Months', '24 Months']);
  const { submit, alice, bob, lots, owner } = ctx;
  submit({ type: 'placeBid', lotId: lots[0], value: 0.07 }, alice, T0 + 10);
  submit({ type: 'placeBid', lotId: lots[0], value: 0.069 }, bob, T0 + 20);
  submit({ type: 'placeBid', lotId: lots[1], value: 0.08 }, bob, T0 + 25);
  submit({ type: 'placeBid', lotId: lots[0], value: 0.0689 }, alice, T0 + 30);
  // A mistyped bid, withdrawn by its owner.
  submit({ type: 'placeBid', lotId: lots[1], value: 0.0079 }, alice, T0 + 40);
  submit({ type: 'cancelBid', bidSeq: ctx.log.length - 1 }, alice, T0 + 45);
  // An auctioneer's phone bid.
  submit({ type: 'placeBid', lotId: lots[1], value: 0.079, onBehalfOfPublicKey: bob.publicKey }, owner, T0 + 50);
  // Into Extended Time: this one pushes the clock.
  submit({ type: 'placeBid', lotId: lots[0], value: 0.0688 }, bob, T0 + 250);
  return ctx;
}

describe('auditLog', () => {
  it('passes a log that was built through the validator', () => {
    const ctx = genuine();
    const report = auditLog('test', ctx.config, ctx.log);
    expect(report.events).toBe(ctx.log.length);
    expect(report.findings).toEqual([]);
  });

  it('flags a bid that did not beat the best it could see', () => {
    const ctx = genuine();
    const forged: AuctionEvent = {
      type: 'placeBid',
      seq: ctx.log.length,
      time: T0 + 260,
      lotId: ctx.lots[0],
      bidder: ctx.alice.publicKey,
      value: 0.09, // far above the 0.0688 leader in a reverse auction
    };
    const report = auditLog('test', ctx.config, [...ctx.log, forged]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ seq: forged.seq, type: 'placeBid', severity: 'error' });
    expect(report.findings[0].message).toMatch(/lower than the current best/);
  });

  it('flags a bid placed after the clock ran out', () => {
    const ctx = genuine();
    const late: AuctionEvent = {
      type: 'placeBid',
      seq: ctx.log.length,
      time: T0 + 10_000,
      lotId: ctx.lots[0],
      bidder: ctx.alice.publicKey,
      value: 0.01,
    };
    const report = auditLog('test', ctx.config, [...ctx.log, late]);
    expect(report.findings.map((f) => f.message)).toEqual(['No auction is currently running.']);
  });

  it('flags a bid whose Extended Time push does not match the arithmetic', () => {
    const ctx = genuine();
    const last = ctx.log[ctx.log.length - 1];
    expect(typeof last.auctionLength).toBe('number');
    const tampered = { ...last, auctionLength: (last.auctionLength as number) + 60 };
    const report = auditLog('test', ctx.config, [...ctx.log.slice(0, -1), tampered]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].message).toMatch(/Pushed the clock out/);
  });

  it('flags a cancellation that names the wrong owner', () => {
    const ctx = genuine();
    const bobsBid = ctx.log.find((e) => e.type === 'placeBid' && e.bidder === ctx.bob.publicKey)!;
    const forged: AuctionEvent = {
      type: 'cancelBid',
      seq: ctx.log.length,
      time: T0 + 260,
      bidSeq: bobsBid.seq,
      bidder: ctx.alice.publicKey,
    };
    const report = auditLog('test', ctx.config, [...ctx.log, forged]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].message).toMatch(/belongs to/);
  });

  it('flags a seq gap and a clock that ran backwards, without failing the events themselves', () => {
    const ctx = genuine();
    const log = ctx.log.map((e) => ({ ...e }));
    // Stamp the last bid ten seconds before the one before it.
    log[log.length - 1].time = log[log.length - 2].time - 10;
    // And open a gap in the numbering.
    log[log.length - 1].seq += 1;
    const report = auditLog('test', ctx.config, log);
    const kinds = report.findings.map((f) => `${f.severity}:${f.message.split(' ')[0]}`);
    expect(kinds).toContain('warning:Stamped');
    expect(kinds).toContain('error:Expected');
  });

  it('judges a Last Call bid against what its bidder could see, not the true best', () => {
    // Alice and Bob both lead into Last Call. Bob bids blind; Alice, who
    // cannot see Bob's bid, then bids a price that beats what *she* saw but
    // not Bob's. The validator accepts that on purpose, so the audit must too.
    const ctx = startedAuction();
    const { submit, alice, bob, lot } = ctx;
    submit({ type: 'placeBid', lotId: lot, value: 0.07 }, alice, T0 + 10);
    submit({ type: 'placeBid', lotId: lot, value: 0.069 }, bob, T0 + 20);
    const inLastCall = T0 + 320;
    expect(ctx.agg.phase(inLastCall).isInLastCall).toBe(true);
    submit({ type: 'placeBid', lotId: lot, value: 0.05 }, bob, inLastCall);
    const alicesBlind = submit({ type: 'placeBid', lotId: lot, value: 0.068 }, alice, inLastCall + 5);
    expect(alicesBlind.ok).toBe(true);

    expect(auditLog('test', ctx.config, ctx.log).findings).toEqual([]);
  });
});

describe('auditLog and a paused clock', () => {
  it('passes a genuine pause and resume, and flags a resume that stretched the run too far', () => {
    const ctx = startedAuction();
    const { submit, owner, alice, lot, log, config } = ctx;
    submit({ type: 'placeBid', lotId: lot, value: 0.07 }, alice, T0 + 10);
    submit({ type: 'pauseAuction' }, owner, T0 + 20);
    submit({ type: 'resumeAuction' }, owner, T0 + 50);
    submit({ type: 'placeBid', lotId: lot, value: 0.069 }, alice, T0 + 60);
    expect(auditLog('test', config, log).findings).toEqual([]);

    const forged = log.map((event) =>
      event.type === 'resumeAuction' ? { ...event, auctionLength: (event.auctionLength as number) + 600 } : event,
    );
    const report = auditLog('test', config, forged);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].type).toBe('resumeAuction');
  });

  it('flags a bid that landed while the clock was paused', () => {
    const { submit, owner, alice, lot, log, config } = startedAuction();
    submit({ type: 'pauseAuction' }, owner, T0 + 20);
    const smuggled: AuctionEvent = {
      type: 'placeBid', seq: log.length, time: T0 + 30, lotId: lot, bidder: alice.publicKey, value: 0.07,
    };
    const report = auditLog('test', config, [...log, smuggled]);
    expect(report.findings.map((f) => f.seq)).toEqual([smuggled.seq]);
  });
});
