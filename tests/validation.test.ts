import { describe, expect, it } from 'vitest';
import { filterOutbound } from '../src/server/validation';
import { makeAuction, startedAuction, T0 } from './helpers';

describe('bid acceptance', () => {
  it('accepts only improving bids in a reverse auction', () => {
    const { submit, alice, bob, lot } = startedAuction();

    expect(submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1).ok).toBe(true);
    expect(submit({ type: 'placeBid', lotId: lot, value: 100 }, bob, T0 + 2).ok).toBe(false);
    expect(submit({ type: 'placeBid', lotId: lot, value: 120 }, bob, T0 + 3).ok).toBe(false);
    expect(submit({ type: 'placeBid', lotId: lot, value: 90 }, bob, T0 + 4).ok).toBe(true);
  });

  it('inverts the comparison in a forward auction', () => {
    const { submit, alice, bob, lot } = startedAuction({ bidDirection: 'forward' });

    expect(submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1).ok).toBe(true);
    expect(submit({ type: 'placeBid', lotId: lot, value: 90 }, bob, T0 + 2).ok).toBe(false);
    expect(submit({ type: 'placeBid', lotId: lot, value: 110 }, bob, T0 + 3).ok).toBe(true);
  });

  it('enforces the minimum bid step', () => {
    const { submit, alice, bob, lot } = startedAuction({ minBidStep: 10 });

    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1);
    expect(submit({ type: 'placeBid', lotId: lot, value: 95 }, bob, T0 + 2).ok).toBe(false);
    expect(submit({ type: 'placeBid', lotId: lot, value: 90 }, bob, T0 + 3).ok).toBe(true);
  });

  it('rejects bids outside the running window', () => {
    const ctx = makeAuction();
    const owner = ctx.addUser('Organiser', 'owner');
    const alice = ctx.addUser('Alice', 'bidder');
    const lot = ctx.addLot('Lane 1');

    expect(ctx.submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0).ok).toBe(false);

    ctx.submit({ type: 'startAuction' }, owner, T0);
    expect(ctx.submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 10).ok).toBe(true);

    // ...and once the clock has run out.
    const late = ctx.submit({ type: 'placeBid', lotId: lot, value: 50 }, alice, T0 + 10_000);
    expect(late.ok).toBe(false);
  });

  it('only lets the owner bid on someone else\'s behalf', () => {
    const { submit, owner, alice, bob, lot } = startedAuction();

    const impersonation = submit(
      { type: 'placeBid', lotId: lot, value: 100, onBehalfOfPublicKey: bob.publicKey },
      alice,
      T0 + 1,
    );
    expect(impersonation.ok).toBe(false);

    // An owner must nominate a bidder rather than bidding as themselves.
    expect(submit({ type: 'placeBid', lotId: lot, value: 100 }, owner, T0 + 2).ok).toBe(false);

    const onBehalf = submit(
      { type: 'placeBid', lotId: lot, value: 100, onBehalfOfPublicKey: bob.publicKey },
      owner,
      T0 + 3,
    );
    expect(onBehalf.ok).toBe(true);
    expect(onBehalf.ok && onBehalf.event.bidder).toBe(bob.publicKey);
  });
});

describe('extended time', () => {
  it('pushes the clock back out to the threshold', () => {
    const { agg, submit, alice, lot } = startedAuction();
    // Default rules: 360s long, extended under 150s, last call 60s.
    const at = T0 + 260; // 100s remaining

    const result = submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, at);
    expect(result.ok).toBe(true);
    expect(agg.auctionLength).toBe(360 + 50);
    expect(agg.remaining(at)).toBe(150);
  });

  it('does not extend once Last Call has begun', () => {
    const { agg, submit, alice, lot } = startedAuction();
    const at = T0 + 330; // 30s remaining — inside last call

    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, at);
    expect(agg.auctionLength).toBe(360);
  });

  it('replays to the same clock from the event log alone', () => {
    const { agg, submit, alice, lot } = startedAuction();
    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 260);
    expect(agg.auctionLength).toBe(410);
  });
});

describe('blind last call', () => {
  const setup = () => {
    const ctx = startedAuction();
    // An early, public bid everyone can see.
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 10);
    // A bid placed inside the blind window (last 60s of the 360s auction).
    const hidden = ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 50 }, ctx.alice, T0 + 330);
    if (!hidden.ok) throw new Error(hidden.error);
    return { ...ctx, hiddenEvent: hidden.event, now: T0 + 340 };
  };

  it('hides a rival\'s Last Call bid but shows it to its owner and the organiser', () => {
    const { agg, hiddenEvent, bob, alice, owner, now } = setup();

    expect(filterOutbound(agg, hiddenEvent, bob, now)).toBeNull();
    expect(filterOutbound(agg, hiddenEvent, alice, now)).not.toBeNull();
    expect(filterOutbound(agg, hiddenEvent, owner, now)).not.toBeNull();
  });

  it('keeps bids placed before Last Call visible', () => {
    const { agg, bob, now } = setup();
    const early = agg.bids.find((bid) => bid.value === 100)!;
    expect(agg.isBidHiddenFrom(early, bob, now)).toBe(false);
  });

  it('does not leak a hidden bid through a rejection', () => {
    const { submit, bob, lot, now } = setup();
    // Alice secretly holds the lead at 50; Bob can only see 100, so 90 must be
    // accepted — rejecting it would tell Bob a lower bid exists.
    expect(submit({ type: 'placeBid', lotId: lot, value: 90 }, bob, now).ok).toBe(true);
  });

  it('reveals everything once results are released', () => {
    const { agg, submit, hiddenEvent, bob, owner, now } = setup();

    expect(submit({ type: 'showResults' }, owner, now).ok).toBe(true);
    expect(filterOutbound(agg, hiddenEvent, bob, now)).not.toBeNull();
  });
});

describe('cancelling bids', () => {
  it('removes the bid and restores the previous leader', () => {
    const { agg, submit, owner, alice, bob, lot } = startedAuction();

    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1);
    const low = submit({ type: 'placeBid', lotId: lot, value: 80 }, bob, T0 + 2);
    if (!low.ok) throw new Error(low.error);

    expect(agg.bestBidFor(lot)?.value).toBe(80);

    expect(submit({ type: 'cancelBid', bidSeq: low.event.seq }, owner, T0 + 3).ok).toBe(true);
    expect(agg.bestBidFor(lot)?.value).toBe(100);
    expect(agg.activeBids()).toHaveLength(1);
  });

  it('refuses to cancel a bid twice or one that does not exist', () => {
    const { submit, owner, alice, lot } = startedAuction();
    const bid = submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1);
    if (!bid.ok) throw new Error(bid.error);

    expect(submit({ type: 'cancelBid', bidSeq: bid.event.seq }, owner, T0 + 2).ok).toBe(true);
    expect(submit({ type: 'cancelBid', bidSeq: bid.event.seq }, owner, T0 + 3).ok).toBe(false);
    expect(submit({ type: 'cancelBid', bidSeq: 999 }, owner, T0 + 4).ok).toBe(false);
  });
});

describe('participant anonymity', () => {
  it('hides other participants\' names from bidders only', () => {
    const ctx = startedAuction();
    const event = ctx.log.find((e) => e.type === 'addUser' && e.publicKey === ctx.bob.publicKey)!;

    const forAlice = filterOutbound(ctx.agg, event, ctx.alice, T0);
    expect(forAlice?.name).toBe(`Bidder ${ctx.bob.publicKey}`);

    const forBob = filterOutbound(ctx.agg, event, ctx.bob, T0);
    expect(forBob?.name).toBe('Bob');

    const forOwner = filterOutbound(ctx.agg, event, ctx.owner, T0);
    expect(forOwner?.name).toBe('Bob');
  });
});
