import type { AuctionEvent, InboundEventInput, Role } from './types';
import { AuctionAggregate, type StoredBid, type StoredUser } from './aggregate';
import { beatsBest, MAX_BIDDERS, MAX_LOTS } from './rules';

/**
 * Bidirectional validation, ported from `validation.py`.
 *
 *   inbound  — may this event be appended to the log at all?
 *   outbound — may this particular viewer see this event, and in what form?
 *
 * Keeping both directions in one place is what makes blind Last Call bidding
 * and participant anonymity work without the UI having to be trusted.
 */

export type InboundResult =
  | { ok: true; event: AuctionEvent }
  | { ok: false; error: string };

const fail = (error: string): InboundResult => ({ ok: false, error });

function countBidders(agg: AuctionAggregate): number {
  let total = 0;
  for (const user of agg.users.values()) if (user.role === 'bidder') total += 1;
  return total;
}

export function validateInbound(
  agg: AuctionAggregate,
  input: InboundEventInput,
  actor: StoredUser,
  now: number,
  seq: number,
): InboundResult {
  const event: AuctionEvent = { ...input, seq, time: now };

  switch (input.type) {
    case 'setName':
      return { ok: true, event };

    case 'addUser': {
      if (input.role === 'bidder' && countBidders(agg) >= MAX_BIDDERS) {
        return fail(`An auction can have at most ${MAX_BIDDERS} bidding firms.`);
      }
      // Public keys are sequential, matching the original's `len(self.users)`.
      event.publicKey = String(agg.users.size);
      return { ok: true, event };
    }

    case 'addLot': {
      // Contract terms are fixed before bidding opens — adding one mid-auction
      // would hand it a clock that is already most of the way through.
      if (agg.startTime !== null) return fail('Contract terms cannot be added once the auction has started.');
      if (agg.lots.size >= MAX_LOTS) return fail(`An auction can run at most ${MAX_LOTS} contract terms at once.`);
      event.lotId = `lot-${agg.lots.size}`;
      return { ok: true, event };
    }

    case 'renameLot':
      if (!agg.lots.has(input.lotId)) return fail('No such lot.');
      return { ok: true, event };

    case 'placeBid':
      return inboundPlaceBid(agg, input, actor, now, event);

    case 'cancelBid': {
      const target = agg.bids.find((bid) => bid.seq === input.bidSeq);
      if (!target) return fail('No such bid.');
      if (agg.cancelledBids.has(input.bidSeq)) return fail('That bid is already cancelled.');
      return { ok: true, event };
    }

    case 'startAuction': {
      if (agg.startTime !== null) return fail('Auction already started!');
      if (agg.lots.size === 0) return fail('Add at least one lot before starting.');
      event.auctionLength = agg.config.auctionLengthSec;
      return { ok: true, event };
    }

    case 'showResults': {
      if (agg.startTime === null) return fail('The auction has not started yet.');
      if (agg.showResultsReleased) return fail('Results have already been released.');
      return { ok: true, event };
    }
  }
}

function inboundPlaceBid(
  agg: AuctionAggregate,
  input: Extract<InboundEventInput, { type: 'placeBid' }>,
  actor: StoredUser,
  now: number,
  event: AuctionEvent,
): InboundResult {
  if (!agg.phase(now).isRunning) return fail('No auction is currently running.');

  const lot = agg.lots.get(input.lotId);
  if (!lot) return fail('No such lot.');

  // Owners may bid on a supplier's behalf (e.g. a phone bid); bidders may not.
  let bidderKey = actor.publicKey;
  if (input.onBehalfOfPublicKey !== undefined) {
    if (actor.role !== 'owner') return fail('Only the owner may bid on behalf of a bidder.');
    bidderKey = input.onBehalfOfPublicKey;
    event.placedBy = actor.publicKey;
  } else if (actor.role === 'owner') {
    return fail('Owners must nominate the bidder they are bidding for.');
  }

  const bidder = agg.users.get(bidderKey);
  if (!bidder || bidder.role !== 'bidder') return fail('Only bidders are allowed to bid.');

  // Last Call narrows each contract term to its leading suppliers. Ranked at
  // the instant the window opened, so nothing a rival does inside the blind
  // window can push someone out of it mid-bid.
  if (agg.phase(now).isInLastCall) {
    const eligible = agg.lastCallEligible(input.lotId);
    if (eligible && !eligible.includes(bidderKey)) {
      const leading = agg.config.bidDirection === 'reverse' ? 'lowest' : 'highest';
      return fail(
        `Last Call on this contract term is open only to its ${agg.config.lastCallBidders} ${leading} bidders.`,
      );
    }
  }

  // Validate against what the actor can see, never the true best — otherwise a
  // rejection would leak the existence of a rival's hidden Last Call bid.
  const best = agg.visibleBestFor(input.lotId, actor, now);
  if (!beatsBest(input.value, best === null ? null : best.value, agg.config)) {
    const direction = agg.config.bidDirection === 'reverse' ? 'lower than' : 'higher than';
    const step = agg.config.minBidStep > 0 ? ` by at least ${agg.config.minBidStep}` : '';
    return fail(`Your bid must be ${direction} the current best bid of ${best!.value}${step}.`);
  }

  event.bidder = bidderKey;
  delete event.onBehalfOfPublicKey;

  // Extended Time: a leading bid inside the threshold pushes the clock back
  // out to the threshold. Ported from `_inbound_place_bid`, now config-driven.
  const { lastCallSec, extendedTimeThresholdSec } = agg.config;
  const remaining = agg.remaining(now);
  if (remaining > lastCallSec && remaining < extendedTimeThresholdSec) {
    event.auctionLength = agg.auctionLength + (extendedTimeThresholdSec - remaining);
  }

  return { ok: true, event };
}

/**
 * Returns the form of `event` that `viewer` may see, or null to withhold it
 * entirely. Ports `_outbound_place_bid` / `_outbound_add_user`.
 */
export function filterOutbound(
  agg: AuctionAggregate,
  event: AuctionEvent,
  viewer: StoredUser,
  now: number,
): AuctionEvent | null {
  const isOwner = viewer.role === 'owner';

  switch (event.type) {
    case 'placeBid': {
      const bid: StoredBid = {
        seq: event.seq,
        lotId: event.lotId as string,
        bidder: event.bidder as string,
        value: event.value as number,
        time: event.time,
      };
      if (agg.isBidHiddenFrom(bid, viewer, now)) return null;

      const out = { ...event };
      if (!isOwner) delete out.placedBy;
      return out;
    }

    case 'cancelBid': {
      // Withhold cancellations of bids this viewer was never shown.
      const target = agg.bids.find((b) => b.seq === (event.bidSeq as number));
      if (target && agg.isBidHiddenFrom(target, viewer, now)) return null;
      return { ...event };
    }

    case 'addUser': {
      const out = { ...event };
      if (!isOwner) delete out.email;

      // Bidders compete anonymously: they see their own name and nobody else's.
      const isSelf = out.publicKey === viewer.publicKey;
      if (viewer.role === 'bidder' && !isSelf) {
        out.name = anonymousLabel(out.role as Role, out.publicKey as string);
        out.anonymised = true;
      }
      return out;
    }

    default:
      return { ...event };
  }
}

function anonymousLabel(role: Role, publicKey: string): string {
  const noun = role === 'bidder' ? 'Bidder' : role === 'viewer' ? 'Observer' : 'Organiser';
  return `${noun} ${publicKey}`;
}
