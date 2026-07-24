import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { StoredUser } from '../shared/aggregate';
import type { Repository } from './db';
import type { Realtime } from './realtime';
import { configSchema, parseConfig } from './config';
import { parseInboundEvent } from './schemas';
import { randomToken, readSessionCookie, setSessionCookie } from './auth';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: StoredUser;
    auctionId?: string;
  }
}

const createAuctionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().min(1).max(120).default('Administrator'),
  email: z.string().email().max(200).optional(),
  config: configSchema.optional(),
});

function newAuctionId(): string {
  return randomBytes(6).toString('hex');
}

export function createRoutes(repo: Repository, realtime: Realtime): Router {
  const router = Router();

  /** Loads the session cookie and resolves it to a user of the target auction. */
  const requireUser = (req: Request, res: Response, next: NextFunction): void => {
    const token = readSessionCookie(req);
    const session = token ? repo.resolveSession(token) : null;
    const auctionId = req.params.id;

    if (!session || session.auctionId !== auctionId) {
      res.status(401).json({ ok: false, error: 'Not signed in to this auction.' });
      return;
    }

    const user = repo.getUser(auctionId, session.publicKey);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Unknown user.' });
      return;
    }

    req.actor = user;
    req.auctionId = auctionId;
    next();
  };

  const requireOwner = (req: Request, res: Response, next: NextFunction): void => {
    if (req.actor?.role !== 'owner') {
      res.status(403).json({ ok: false, error: 'Owners only.' });
      return;
    }
    next();
  };

  // --- creation & sign-in -------------------------------------------------

  router.post('/auctions', (req, res) => {
    const parsed = createAuctionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
      return;
    }

    const { name, ownerName, email, config } = parsed.data;
    const id = newAuctionId();
    repo.createAuction(id, name, parseConfig(config));

    // Bootstrap events run as a synthetic all-privileges user, exactly as the
    // original `create_auction` did.
    const system: StoredUser = { publicKey: '__system__', role: 'owner', name: 'System' };
    repo.submit(id, { type: 'setName', name }, system);
    const owner = repo.submit(
      id,
      { type: 'addUser', name: ownerName, role: 'owner', ...(email ? { email } : {}) },
      system,
    );

    if (!owner.result.ok) {
      res.status(500).json({ ok: false, error: owner.result.error });
      return;
    }

    const publicKey = owner.result.event.publicKey as string;
    setSessionCookie(res, repo.createSession(id, publicKey));
    res.json({ ok: true, id, publicKey });
  });

  /** Exchanges a one-time invite link for a session cookie. */
  router.get('/invite/:token', (req, res) => {
    const found = repo.findUserByInviteToken(req.params.token);
    if (!found) {
      res.status(404).send('This invitation link is not valid. Ask the organiser for a new one.');
      return;
    }
    setSessionCookie(res, repo.createSession(found.auctionId, found.publicKey));
    res.redirect(`/a/${found.auctionId}`);
  });

  // --- auction state ------------------------------------------------------

  router.get('/auctions/:id/me', requireUser, (req, res) => {
    const auction = repo.getAuction(req.auctionId!)!;
    const agg = repo.aggregate(req.auctionId!)!;
    res.json({
      ok: true,
      you: req.actor,
      auction: { id: auction.id, name: agg.name, config: auction.config },
    });
  });

  router.post('/auctions/:id/events', requireUser, (req, res) => {
    const actor = req.actor!;
    const parsed = parseInboundEvent(req.body, actor.role);
    if (!parsed.ok) {
      res.status(400).json({ ok: false, error: parsed.error });
      return;
    }

    const { result, inviteToken } = repo.submit(req.auctionId!, parsed.input, actor);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }

    realtime.broadcast(req.auctionId!, result.event);

    // Releasing results un-hides Last Call bids, so everyone needs a fresh view.
    if (result.event.type === 'showResults') realtime.resync(req.auctionId!);

    res.json({
      ok: true,
      event: result.event,
      ...(inviteToken ? { inviteUrl: inviteUrl(req, inviteToken) } : {}),
    });
  });

  // --- owner tools --------------------------------------------------------

  router.get('/auctions/:id/users', requireUser, requireOwner, (req, res) => {
    res.json({ ok: true, users: repo.listUsersWithInvites(req.auctionId!) });
  });

  /** Issues a fresh invite link; the previous one stops working. */
  router.post('/auctions/:id/users/:publicKey/invite', requireUser, requireOwner, (req, res) => {
    const user = repo.getUser(req.auctionId!, req.params.publicKey);
    if (!user) {
      res.status(404).json({ ok: false, error: 'No such user.' });
      return;
    }
    const token = randomToken();
    repo.setInviteToken(req.auctionId!, user.publicKey, token);
    res.json({ ok: true, inviteUrl: inviteUrl(req, token) });
  });

  router.patch('/auctions/:id/config', requireUser, requireOwner, (req, res) => {
    const agg = repo.aggregate(req.auctionId!)!;
    if (agg.startTime !== null) {
      res.status(400).json({ ok: false, error: 'Rules cannot change once the auction has started.' });
      return;
    }

    const parsed = configSchema.safeParse({ ...agg.config, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues[0].message });
      return;
    }

    repo.updateConfig(req.auctionId!, parsed.data);
    realtime.resync(req.auctionId!);
    res.json({ ok: true, config: parsed.data });
  });

  // --- exports ------------------------------------------------------------

  router.get('/auctions/:id/results.csv', requireUser, requireOwner, (req, res) => {
    const agg = repo.aggregate(req.auctionId!)!;
    const rows = [['lot', 'winner', 'winning_bid', 'bid_count']];

    for (const { lot, winner, bid, bidCount } of agg.results()) {
      rows.push([lot.name, winner?.name ?? '', bid ? String(bid.value) : '', String(bidCount)]);
    }

    sendCsv(res, `${slug(agg.name)}-results.csv`, rows);
  });

  router.get('/auctions/:id/bids.csv', requireUser, requireOwner, (req, res) => {
    const agg = repo.aggregate(req.auctionId!)!;
    const rows = [['seq', 'lot', 'bidder', 'value', 'seconds_into_auction', 'cancelled']];

    for (const bid of agg.bids) {
      const lot = agg.lots.get(bid.lotId);
      const offset = agg.startTime === null ? '' : (bid.time - agg.startTime).toFixed(1);
      rows.push([
        String(bid.seq),
        lot?.name ?? bid.lotId,
        agg.users.get(bid.bidder)?.name ?? bid.bidder,
        String(bid.value),
        offset,
        agg.cancelledBids.has(bid.seq) ? 'yes' : 'no',
      ]);
    }

    sendCsv(res, `${slug(agg.name)}-bids.csv`, rows);
  });

  return router;
}

function inviteUrl(req: Request, token: string): string {
  const host = req.get('x-forwarded-host') ?? req.get('host');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${host}/api/invite/${token}`;
}

function sendCsv(res: Response, filename: string, rows: string[][]): void {
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'auction';
}
