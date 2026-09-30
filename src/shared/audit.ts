import { AuctionAggregate, type Participant } from './aggregate';
import { parseInboundEvent } from './schemas';
import type { AuctionConfig, AuctionEvent, InboundEventInput, Role } from './types';
import { validateInbound } from './validation';

/**
 * Post-hoc audit of an event log.
 *
 * With no server, `validateInbound` runs only in the browser that submits an
 * event, and `firestore.rules` cannot re-derive bid arithmetic — so a
 * hand-crafted write that breaks a rule *lands*, in the append-only log, on
 * every screen. What the log cannot do is hide it. This replays the log from
 * the start and asks, of each event in turn, whether the shared validator
 * would have accepted it given everything that came before. Anything it
 * would have refused is reported with the validator's own reason.
 *
 * Every event is folded whether or not it passes, because that is what every
 * screen did; the question is not "what should the board show" but "did
 * anything reach the board that the rules say should not have".
 */

export interface AuditFinding {
  seq: number;
  type: string;
  /** `error`: the validator would have refused it. `warning`: worth a look, not a violation. */
  severity: 'error' | 'warning';
  message: string;
}

export interface AuditReport {
  /** How many events were examined. */
  events: number;
  findings: AuditFinding[];
}

const SYSTEM: Participant = { publicKey: '__system__', role: 'owner' };

/** Beyond this, an event stamped earlier than its predecessor is called out. */
const CLOCK_SLACK_SEC = 2;
/** Extended Time lengths are recomputed from the same stamp, so they should match to the millisecond. */
const LENGTH_SLACK_SEC = 0.01;

export function auditLog(id: string, config: AuctionConfig, events: AuctionEvent[]): AuditReport {
  const agg = new AuctionAggregate(id, config);
  const findings: AuditFinding[] = [];
  let previousTime = -Infinity;

  events.forEach((event, index) => {
    const flag = (severity: AuditFinding['severity'], message: string) =>
      findings.push({ seq: event.seq, type: event.type, severity, message });

    if (event.seq !== index) {
      flag('error', `Expected seq ${index} here; the log has a gap or a duplicate.`);
    }
    if (event.time < previousTime - CLOCK_SLACK_SEC) {
      flag(
        'warning',
        `Stamped ${(previousTime - event.time).toFixed(1)}s earlier than the event before it — ` +
          'the submitting machine\'s clock was probably off.',
      );
    }
    previousTime = Math.max(previousTime, event.time);

    const reconstructed = reconstruct(agg, event);
    if (reconstructed === null) {
      flag('error', `Unrecognised event type "${event.type}".`);
    } else {
      const { input, actor } = reconstructed;
      const parsed = parseInboundEvent(input, actor.role);
      if (!parsed.ok) {
        flag('error', parsed.error);
      } else {
        const result = validateInbound(agg, parsed.input, actor, event.time, event.seq);
        if (!result.ok) {
          flag('error', result.error);
        } else {
          for (const message of compare(event, result.event)) flag('error', message);
        }
      }
    }

    agg.apply(event);
  });

  return { events: events.length, findings };
}

/**
 * The submission that would have produced `event`, and who submitted it. The
 * log stores the validator's *output*, so this runs the enrichment backwards:
 * a bid carrying `placedBy` was an owner's on-behalf bid, otherwise the bidder
 * placed it themselves; a cancellation is attributed to the bid's own owner,
 * which is the strictest reading that is still always valid for a genuine one.
 */
function reconstruct(
  agg: AuctionAggregate,
  event: AuctionEvent,
): { input: InboundEventInput; actor: Participant } | null {
  switch (event.type) {
    case 'setName':
      return { input: { type: 'setName', name: String(event.name) }, actor: SYSTEM };

    case 'addUser':
      // Name and address never reach the log; placeholders satisfy the shape.
      return {
        input: { type: 'addUser', name: 'audit', role: event.role as Role, email: 'audit@example.com' },
        actor: SYSTEM,
      };

    case 'addLot':
      return { input: { type: 'addLot', name: String(event.name) }, actor: SYSTEM };

    case 'renameLot':
      return {
        input: { type: 'renameLot', lotId: String(event.lotId), name: String(event.name) },
        actor: SYSTEM,
      };

    case 'placeBid': {
      const bidder = String(event.bidder);
      if (typeof event.placedBy === 'string') {
        return {
          input: { type: 'placeBid', lotId: String(event.lotId), value: event.value as number, onBehalfOfPublicKey: bidder },
          actor: { publicKey: event.placedBy, role: 'owner' },
        };
      }
      return {
        input: { type: 'placeBid', lotId: String(event.lotId), value: event.value as number },
        actor: { publicKey: bidder, role: 'bidder' },
      };
    }

    case 'cancelBid': {
      const target = agg.bids.find((bid) => bid.seq === event.bidSeq);
      const owner = target?.bidder ?? String(event.bidder ?? '');
      return {
        input: { type: 'cancelBid', bidSeq: event.bidSeq as number },
        actor: { publicKey: owner, role: 'bidder' },
      };
    }

    case 'startAuction':
      return { input: { type: 'startAuction' }, actor: SYSTEM };

    case 'showResults':
      return { input: { type: 'showResults' }, actor: SYSTEM };

    default:
      return null;
  }
}

/**
 * The validator accepted the reconstruction — but did it enrich it the same
 * way? A stored value that differs from the recomputed one means the client
 * that wrote it did its own arithmetic.
 */
function compare(stored: AuctionEvent, recomputed: AuctionEvent): string[] {
  const problems: string[] = [];

  switch (stored.type) {
    case 'addUser':
      if (stored.publicKey !== recomputed.publicKey) {
        problems.push(`Slot ${stored.publicKey} was written where ${recomputed.publicKey} was next.`);
      }
      // Logs from before labels were assigned at signup carry none; skip them.
      if (typeof stored.label === 'string' && stored.label !== recomputed.label) {
        problems.push(`Labelled "${stored.label}" where "${recomputed.label}" was next.`);
      }
      if (typeof stored.name === 'string' || typeof stored.email === 'string') {
        problems.push('Carries a name or address, which the validator strips before the log.');
      }
      break;

    case 'addLot':
      if (stored.lotId !== recomputed.lotId) {
        problems.push(`Lot id ${stored.lotId} was written where ${recomputed.lotId} was next.`);
      }
      break;

    case 'placeBid': {
      const storedLength = typeof stored.auctionLength === 'number' ? stored.auctionLength : null;
      const expected = typeof recomputed.auctionLength === 'number' ? recomputed.auctionLength : null;
      if (storedLength === null && expected !== null) {
        problems.push(`Should have pushed the clock out to ${expected.toFixed(1)}s (Extended Time) but did not.`);
      } else if (storedLength !== null && expected === null) {
        problems.push(`Pushed the clock out to ${storedLength.toFixed(1)}s, but Extended Time did not apply.`);
      } else if (storedLength !== null && expected !== null && Math.abs(storedLength - expected) > LENGTH_SLACK_SEC) {
        problems.push(`Pushed the clock out to ${storedLength.toFixed(1)}s where ${expected.toFixed(1)}s was right.`);
      }
      break;
    }

    case 'cancelBid':
      if (typeof stored.bidder === 'string' && stored.bidder !== recomputed.bidder) {
        problems.push(
          `Names slot ${stored.bidder} as the bid's owner, but the bid belongs to ${recomputed.bidder}. ` +
            'Every screen ignores it, so the bid still stands.',
        );
      }
      break;

    case 'startAuction':
      if (stored.auctionLength !== recomputed.auctionLength) {
        problems.push(`Started a ${stored.auctionLength}s run where the rules say ${recomputed.auctionLength}s.`);
      }
      break;
  }

  return problems;
}
