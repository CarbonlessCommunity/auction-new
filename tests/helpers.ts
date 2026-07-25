import { AuctionAggregate, type StoredUser } from '../src/shared/aggregate';
import type { AuctionConfig, AuctionEvent, InboundEventInput, Role } from '../src/shared/types';
import { parseConfig } from '../src/shared/config';
import { validateInbound, type InboundResult } from '../src/shared/validation';

export const T0 = 1_000_000;

export const SYSTEM: StoredUser = { publicKey: '__system__', role: 'owner', name: 'System' };

/**
 * Drives an aggregate through the real inbound validator with an explicit
 * clock, so tests exercise exactly the path the server uses.
 */
export function makeAuction(config: Partial<AuctionConfig> = {}) {
  const parsed = parseConfig(config);
  const agg = new AuctionAggregate('test', parsed);
  const log: AuctionEvent[] = [];
  let seq = 0;

  function submit(input: InboundEventInput, actor: StoredUser, now = T0): InboundResult {
    const result = validateInbound(agg, input, actor, now, seq);
    if (result.ok) {
      agg.apply(result.event);
      log.push(result.event);
      seq += 1;
    }
    return result;
  }

  function addUser(name: string, role: Role): StoredUser {
    const result = submit({ type: 'addUser', name, role }, SYSTEM);
    if (!result.ok) throw new Error(result.error);
    return { publicKey: result.event.publicKey as string, role, name };
  }

  function addLot(name: string): string {
    const result = submit({ type: 'addLot', name }, SYSTEM);
    if (!result.ok) throw new Error(result.error);
    return result.event.lotId as string;
  }

  return { agg, config: parsed, log, submit, addUser, addLot };
}

/**
 * Owner, two bidders and the given contract terms, started at T0. Terms have
 * to be named up front: the validator refuses to add one once the clock runs.
 */
export function startedAuction(config: Partial<AuctionConfig> = {}, terms: string[] = ['12 Months']) {
  const ctx = makeAuction(config);
  const owner = ctx.addUser('Organiser', 'owner');
  const alice = ctx.addUser('Alice', 'bidder');
  const bob = ctx.addUser('Bob', 'bidder');
  const lots = terms.map((term) => ctx.addLot(term));

  const started = ctx.submit({ type: 'startAuction' }, owner, T0);
  if (!started.ok) throw new Error(started.error);

  return { ...ctx, owner, alice, bob, lots, lot: lots[0] };
}
