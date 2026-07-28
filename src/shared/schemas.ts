import { z } from 'zod';
import type { InboundEventInput, Role } from './types';

/**
 * Replaces the original `schema/*.json` JSON-Schema files. Each event has a
 * shape schema plus the set of roles allowed to submit it — the equivalent of
 * the `inboundRole` enum the old schemas carried.
 */

const name = z.string().trim().min(1).max(120);

export const eventSchemas = {
  setName: z.object({ type: z.literal('setName'), name }),
  addUser: z.object({
    type: z.literal('addUser'),
    name,
    role: z.enum(['owner', 'bidder', 'viewer']),
    // Not optional: without an address there is nothing to key a seat by and
    // no way for the participant to ever sign in.
    email: z.string().trim().toLowerCase().email().max(200),
  }),
  addLot: z.object({ type: z.literal('addLot'), name }),
  renameLot: z.object({ type: z.literal('renameLot'), lotId: z.string().min(1), name }),
  placeBid: z.object({
    type: z.literal('placeBid'),
    lotId: z.string().min(1),
    value: z.number().finite().min(0),
    onBehalfOfPublicKey: z.string().min(1).optional(),
  }),
  cancelBid: z.object({ type: z.literal('cancelBid'), bidSeq: z.number().int().min(0) }),
  startAuction: z.object({ type: z.literal('startAuction') }),
  showResults: z.object({ type: z.literal('showResults') }),
} as const;

/** Which roles may submit each event type (ports the `inboundRole` ACLs). */
export const inboundRoles: Record<keyof typeof eventSchemas, readonly Role[]> = {
  setName: ['owner'],
  addUser: ['owner'],
  addLot: ['owner'],
  renameLot: ['owner'],
  placeBid: ['bidder', 'owner'],
  // A supplier may withdraw a bid of their own — mistyped bids happen, and
  // sometimes on purpose. `validateInbound` is what holds them to their own.
  cancelBid: ['owner', 'bidder'],
  startAuction: ['owner'],
  showResults: ['owner'],
};

export type ParseResult =
  | { ok: true; input: InboundEventInput }
  | { ok: false; error: string };

/** Validates an untrusted submission's shape and the submitter's role. */
export function parseInboundEvent(raw: unknown, role: Role): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Event must be an object.' };
  }

  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string' || !(type in eventSchemas)) {
    return { ok: false, error: `No such event type: ${JSON.stringify(type)}` };
  }

  const key = type as keyof typeof eventSchemas;
  if (!inboundRoles[key].includes(role)) {
    return { ok: false, error: `Your role (${role}) may not submit ${type} events.` };
  }

  const parsed = eventSchemas[key].safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length ? ` at ${issue.path.join('.')}` : '';
    return { ok: false, error: `Invalid ${type}${path}: ${issue.message}` };
  }

  return { ok: true, input: parsed.data as InboundEventInput };
}
