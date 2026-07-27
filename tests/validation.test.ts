import { describe, expect, it } from 'vitest';
import { AuctionAggregate } from '../src/shared/aggregate';
import { eventSchemas, inboundRoles, parseInboundEvent } from '../src/shared/schemas';
import { filterOutbound } from '../src/shared/validation';
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

describe('last call is limited to the leading suppliers', () => {
  /**
   * Three suppliers on one term, ranked Bob 80 / Alice 90 / Carol 100 by the
   * time the 60s Last Call window opens at T0+300.
   */
  const threeWay = () => {
    const ctx = startedAuction();
    const carol = ctx.addUser('Carol', 'bidder');

    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, carol, T0 + 10);
    const aliceBid = ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 90 }, ctx.alice, T0 + 20);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 80 }, ctx.bob, T0 + 30);
    if (!aliceBid.ok) throw new Error(aliceBid.error);

    return { ...ctx, carol, aliceBid: aliceBid.event, inLastCall: T0 + 310 };
  };

  it('lets the two leaders keep bidding and turns everyone else away', () => {
    const ctx = threeWay();

    expect(ctx.agg.lastCallEligible(ctx.lot)).toEqual([ctx.bob.publicKey, ctx.alice.publicKey]);

    expect(ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 70 }, ctx.carol, ctx.inLastCall).ok).toBe(false);
    expect(ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 70 }, ctx.alice, ctx.inLastCall).ok).toBe(true);
  });

  it('re-ranks the field when the auctioneer removes a bid', () => {
    const ctx = threeWay();

    // Alice's 90 was placed in error, so Carol inherits second place — and
    // with it the right to answer in Last Call.
    expect(ctx.submit({ type: 'cancelBid', bidSeq: ctx.aliceBid.seq }, ctx.owner, T0 + 40).ok).toBe(true);

    expect(ctx.agg.lastCallEligible(ctx.lot)).toEqual([ctx.bob.publicKey, ctx.carol.publicKey]);
    expect(ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 70 }, ctx.carol, ctx.inLastCall).ok).toBe(true);
  });

  it('judges each contract term on its own standings', () => {
    const ctx = startedAuction({}, ['12 Months', '24 Months']);
    const carol = ctx.addUser('Carol', 'bidder');
    const [twelve, twentyFour] = ctx.lots;

    // Carol trails on the 12-month term but leads the 24-month one.
    ctx.submit({ type: 'placeBid', lotId: twelve, value: 100 }, carol, T0 + 10);
    ctx.submit({ type: 'placeBid', lotId: twelve, value: 90 }, ctx.alice, T0 + 20);
    ctx.submit({ type: 'placeBid', lotId: twelve, value: 80 }, ctx.bob, T0 + 30);
    ctx.submit({ type: 'placeBid', lotId: twentyFour, value: 200 }, ctx.alice, T0 + 40);
    ctx.submit({ type: 'placeBid', lotId: twentyFour, value: 190 }, ctx.bob, T0 + 50);
    ctx.submit({ type: 'placeBid', lotId: twentyFour, value: 180 }, carol, T0 + 60);

    const at = T0 + 310;
    expect(ctx.submit({ type: 'placeBid', lotId: twelve, value: 70 }, carol, at).ok).toBe(false);
    expect(ctx.submit({ type: 'placeBid', lotId: twentyFour, value: 170 }, carol, at).ok).toBe(true);
  });

  it('stays open on a term too few suppliers ever bid on', () => {
    const ctx = startedAuction();
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 10);

    expect(ctx.agg.lastCallEligible(ctx.lot)).toBeNull();
    expect(ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 90 }, ctx.bob, T0 + 310).ok).toBe(true);
  });

  it('is switched off entirely when the rule is set to zero', () => {
    const ctx = startedAuction({ lastCallBidders: 0 });
    const carol = ctx.addUser('Carol', 'bidder');

    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, carol, T0 + 10);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 90 }, ctx.alice, T0 + 20);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 80 }, ctx.bob, T0 + 30);

    expect(ctx.agg.lastCallEligible(ctx.lot)).toBeNull();
    expect(ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 70 }, carol, T0 + 310).ok).toBe(true);
  });
});

describe('standings', () => {
  it('shows one row per supplier — their own best — leader first', () => {
    const ctx = startedAuction();
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 10);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 95 }, ctx.bob, T0 + 20);
    ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 90 }, ctx.alice, T0 + 30);

    const ranked = ctx.agg.standings(ctx.lot);
    expect(ranked.map((bid) => [bid.bidder, bid.value])).toEqual([
      [ctx.alice.publicKey, 90],
      [ctx.bob.publicKey, 95],
    ]);
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

  /**
   * Suppliers mistype bids — sometimes, the auctioneer reckons, on purpose to
   * spoil an auction. Both ends of that can undo it: the supplier straight
   * away, and the auctioneer for the ones nobody notices in time.
   */
  it('lets a supplier withdraw a bid of their own', () => {
    const { agg, submit, alice, lot } = startedAuction();

    submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1);
    const fatFingered = submit({ type: 'placeBid', lotId: lot, value: 10 }, alice, T0 + 2);
    if (!fatFingered.ok) throw new Error(fatFingered.error);

    expect(submit({ type: 'cancelBid', bidSeq: fatFingered.event.seq }, alice, T0 + 3).ok).toBe(true);
    expect(agg.bestBidFor(lot)?.value).toBe(100);
  });

  it('refuses to let a supplier withdraw a rival\'s bid', () => {
    const { agg, submit, alice, bob, lot } = startedAuction();
    const theirs = submit({ type: 'placeBid', lotId: lot, value: 100 }, alice, T0 + 1);
    if (!theirs.ok) throw new Error(theirs.error);

    const stolen = submit({ type: 'cancelBid', bidSeq: theirs.event.seq }, bob, T0 + 2);
    expect(stolen.ok).toBe(false);
    expect(agg.activeBids()).toHaveLength(1);
  });

  /**
   * The security rules can only check that a supplier's cancellation names
   * *themselves* — they cannot follow `bidSeq` to the bid it points at. So a
   * hand-written cancellation naming yourself but pointing at a rival's bid is
   * the one thing that could get past them, and the fold refuses it.
   */
  it('ignores a forged cancellation that names the wrong bidder', () => {
    const ctx = startedAuction();
    const theirs = ctx.submit({ type: 'placeBid', lotId: ctx.lot, value: 100 }, ctx.alice, T0 + 1);
    if (!theirs.ok) throw new Error(theirs.error);

    const forged = { type: 'cancelBid' as const, seq: 99, time: T0 + 2, bidSeq: theirs.event.seq, bidder: ctx.bob.publicKey };
    const agg = AuctionAggregate.replay('forged', ctx.config, [...ctx.log, forged]);

    expect(agg.cancelledBids.size).toBe(0);
    expect(agg.bestBidFor(ctx.lot)?.value).toBe(100);
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

describe('who may control what', () => {
  /**
   * The client on the buying side watches and does nothing else: no bidding,
   * no withdrawing, and none of the auctioneer's tools. The role ACL is the
   * first gate; `firestore.rules` is the one that cannot be bypassed.
   */
  it('gives the watching client no control at all', () => {
    for (const type of Object.keys(eventSchemas)) {
      expect(inboundRoles[type as keyof typeof eventSchemas]).not.toContain('viewer');
    }
    expect(parseInboundEvent({ type: 'placeBid', lotId: 'lot-0', value: 1 }, 'viewer').ok).toBe(false);
    expect(parseInboundEvent({ type: 'cancelBid', bidSeq: 0 }, 'viewer').ok).toBe(false);
  });

  it('lets a supplier bid and withdraw, and nothing else', () => {
    expect(parseInboundEvent({ type: 'placeBid', lotId: 'lot-0', value: 1 }, 'bidder').ok).toBe(true);
    expect(parseInboundEvent({ type: 'cancelBid', bidSeq: 0 }, 'bidder').ok).toBe(true);
    expect(parseInboundEvent({ type: 'showResults' }, 'bidder').ok).toBe(false);
    expect(parseInboundEvent({ type: 'startAuction' }, 'bidder').ok).toBe(false);
    expect(parseInboundEvent({ type: 'addUser', name: 'X', role: 'bidder' }, 'bidder').ok).toBe(false);
  });
});

describe('participant anonymity', () => {
  /**
   * The core promise to a supplier: they learn where their price sits in the
   * market and nothing about whose price it sits against — not before the
   * auction, not during it, not after. That is enforced structurally rather
   * than by the renderer: names never enter the log at all, so no amount of
   * reading it (or tampering with the client that folds it) recovers one.
   */
  it('keeps real names and emails out of the event log entirely', () => {
    const ctx = startedAuction();

    for (const event of ctx.log.filter((e) => e.type === 'addUser')) {
      expect(event.name).toBeUndefined();
      expect(event.email).toBeUndefined();
      expect(typeof event.label).toBe('string');
    }

    const serialised = JSON.stringify(ctx.log);
    expect(serialised).not.toContain('Alice');
    expect(serialised).not.toContain('Bob');
    expect(serialised).not.toContain('Organiser');
  });

  it('assigns suppliers nondescript labels and colours in signup order', () => {
    const ctx = makeAuction();
    ctx.addUser('Organiser', 'owner');
    const first = ctx.addUser('Alice', 'bidder');
    ctx.addUser('A watching client', 'viewer');
    const second = ctx.addUser('Bob', 'bidder');
    const third = ctx.addUser('Carol', 'bidder');

    // Suppliers run A, B, C in signup order regardless of who else was
    // invited in between, and each keeps its own palette slot.
    expect([first.label, second.label, third.label]).toEqual([
      'Supplier A',
      'Supplier B',
      'Supplier C',
    ]);
    expect([first.colorIndex, second.colorIndex, third.colorIndex]).toEqual([0, 1, 2]);

    // Folding the log reproduces exactly that, and nothing more.
    const bidders = [...ctx.agg.users.values()].filter((u) => u.role === 'bidder');
    expect(bidders.map((u) => u.name)).toEqual(['Supplier A', 'Supplier B', 'Supplier C']);
  });

  it('gives every participant the same label whoever is looking', () => {
    const ctx = startedAuction();
    const event = ctx.log.find((e) => e.type === 'addUser' && e.publicKey === ctx.bob.publicKey)!;

    for (const viewer of [ctx.alice, ctx.bob, ctx.owner]) {
      expect(filterOutbound(ctx.agg, event, viewer, T0)?.label).toBe(ctx.bob.label);
    }
  });

  it('still strips names from a log written before identities were split out', () => {
    const ctx = startedAuction();
    // A legacy addUser event, as the old validator would have appended it.
    const legacy = { ...ctx.log.find((e) => e.type === 'addUser')!, name: 'Bob', email: 'bob@example.com' };

    const forAlice = filterOutbound(ctx.agg, legacy, ctx.alice, T0);
    expect(forAlice?.name).toBeUndefined();
    expect(forAlice?.email).toBeUndefined();

    // And even unfiltered, folding one never puts the name on the board.
    const agg = AuctionAggregate.replay('legacy', ctx.config, [
      { type: 'addUser', seq: 0, time: T0, publicKey: '0', role: 'bidder', name: 'Bob' },
    ]);
    expect(agg.users.get('0')?.name).toBe('Supplier A');
  });
});
