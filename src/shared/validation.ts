import type { AuctionEvent, InboundEventInput } from './types';
import { AuctionAggregate, type Participant, type StoredBid } from './aggregate';
import { beatsBest, MAX_BIDDERS, MAX_LOTS, participantLabel, totalRunSec } from './rules';

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

export function validateInbound(
  agg: AuctionAggregate,
  input: InboundEventInput,
  actor: Participant,
  now: number,
  seq: number,
): InboundResult {
  const event: AuctionEvent = { ...input, seq, time: now };

  switch (input.type) {
    case 'setName':
      return { ok: true, event };

    case 'addUser': {
      const index = agg.countRole(input.role);
      if (input.role === 'bidder' && index >= MAX_BIDDERS) {
        return fail(`An auction can have at most ${MAX_BIDDERS} bidding firms.`);
      }
      // Public keys are sequential, matching the original's `len(self.users)`.
      event.publicKey = String(agg.users.size);

      // The public identity a rival is allowed to see: a nondescript label and
      // a colour, both fixed here in signup order. The real name and email
      // never enter the log at all — they go to `auctions/{id}/identities`,
      // which only the auctioneer, an observer and the participant themselves
      // can read. That is what keeps a supplier from ever attaching a firm to
      // a price, before, during or after the auction.
      event.label = participantLabel(input.role, index);
      event.colorIndex = index;
      delete event.name;
      delete event.email;
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
      // A supplier may withdraw a bid they entered in error, but only their
      // own; the auctioneer may withdraw anyone's, since a mistyped bid the
      // bidder does not notice can distort the whole board.
      if (actor.role !== 'owner' && target.bidder !== actor.publicKey) {
        return fail('You can only remove your own bids.');
      }
      // Named so the fold and the security rules can both tell whose bid this
      // withdraws without following `bidSeq` (see `apply('cancelBid')`).
      event.bidder = target.bidder;
      return { ok: true, event };
    }

    case 'startAuction': {
      if (agg.startTime !== null) return fail('Auction already started!');
      if (agg.lots.size === 0) return fail('Add at least one lot before starting.');
      event.auctionLength = totalRunSec(agg.config);
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
  actor: Participant,
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

  // Extended Time: a leading bid inside the threshold pushes the clock back out
  // to the threshold. Ported from `_inbound_place_bid`, now config-driven — and
  // measured on the main clock the bidder is watching, so a 90s threshold means
  // "under 1:30 showing" rather than 1:30 of total run left.
  const { extendedTimeThresholdSec } = agg.config;
  const mainRemaining = agg.mainRemaining(now);
  if (mainRemaining > 0 && mainRemaining < extendedTimeThresholdSec) {
    event.auctionLength = agg.auctionLength + (extendedTimeThresholdSec - mainRemaining);
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
  viewer: Participant,
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
      // Anonymity is structural now: `validateInbound` keeps names and emails
      // out of the log entirely, so there is normally nothing here to strip.
      // Logs written before that split still carry them, and a bidder must not
      // learn a rival's firm by replaying old history either.
      const out = { ...event };
      if (out.publicKey !== viewer.publicKey && viewer.role === 'bidder') {
        delete out.name;
        delete out.email;
      } else if (!isOwner) {
        delete out.email;
      }
      return out;
    }

    default:
      return { ...event };
  }
}
