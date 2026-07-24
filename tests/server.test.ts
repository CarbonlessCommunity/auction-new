import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp } from '../src/server/app';
import type { ServerMessage } from '../src/shared/types';

let base: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const { server } = createApp(':memory:');
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(() => close());

/** A browser-ish client: one cookie jar, JSON in and out. */
function client() {
  let cookie = '';
  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(base + path, {
      ...init,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return res;
  }

  return {
    call,
    get cookie() {
      return cookie;
    },
    async json(path: string, init?: RequestInit) {
      return (await call(path, init)) .json() as Promise<any>;
    },
    post(path: string, body: unknown) {
      return this.json(path, { method: 'POST', body: JSON.stringify(body) });
    },
  };
}

/** Opens a socket and collects messages until `done` is satisfied. */
function socket(auctionId: string, cookie: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?auction=${auctionId}`, {
    headers: { cookie },
  });
  const messages: ServerMessage[] = [];
  const waiters: Array<() => void> = [];

  ws.on('message', (raw) => {
    messages.push(JSON.parse(String(raw)));
    waiters.splice(0).forEach((resolve) => resolve());
  });

  return {
    ws,
    messages,
    /** Resolves once `predicate` holds, so tests never race the network. */
    async until(predicate: (msgs: ServerMessage[]) => boolean, label = 'message') {
      const deadline = Date.now() + 3000;
      while (!predicate(messages)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
      return messages;
    },
    close: () => ws.close(),
  };
}

describe('http api', () => {
  it('runs a full auction end to end', async () => {
    const owner = client();

    const created = await owner.post('/api/auctions', {
      name: 'Autumn Haulage',
      ownerName: 'Olivia',
      config: { auctionLengthSec: 120, extendedTimeThresholdSec: 60, lastCallSec: 30 },
    });
    expect(created.ok).toBe(true);
    const id = created.id as string;

    const lot = await owner.post(`/api/auctions/${id}/events`, { type: 'addLot', name: 'Route A' });
    expect(lot.ok).toBe(true);
    const lotId = lot.event.lotId as string;

    // Adding a participant hands the owner a one-time invite link.
    const invited = await owner.post(`/api/auctions/${id}/events`, {
      type: 'addUser',
      name: 'Acme Freight',
      role: 'bidder',
    });
    expect(invited.ok).toBe(true);
    expect(invited.inviteUrl).toContain('/api/invite/');

    // The bidder redeems it and gets their own session.
    const bidder = client();
    const redeemed = await bidder.call(new URL(invited.inviteUrl).pathname);
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get('location')).toBe(`/a/${id}`);

    const me = await bidder.json(`/api/auctions/${id}/me`);
    expect(me.you).toMatchObject({ name: 'Acme Freight', role: 'bidder' });

    // Bidding before the start is refused.
    const early = await bidder.post(`/api/auctions/${id}/events`, { type: 'placeBid', lotId, value: 500 });
    expect(early.ok).toBe(false);

    expect((await owner.post(`/api/auctions/${id}/events`, { type: 'startAuction' })).ok).toBe(true);

    expect((await bidder.post(`/api/auctions/${id}/events`, { type: 'placeBid', lotId, value: 500 })).ok).toBe(true);
    const worse = await bidder.post(`/api/auctions/${id}/events`, { type: 'placeBid', lotId, value: 600 });
    expect(worse.ok).toBe(false);
    expect(worse.error).toMatch(/lower than/);

    // Owner-only surfaces are closed to the bidder.
    expect((await bidder.call(`/api/auctions/${id}/users`)).status).toBe(403);
    expect((await bidder.call(`/api/auctions/${id}/results.csv`)).status).toBe(403);

    const csv = await (await owner.call(`/api/auctions/${id}/results.csv`)).text();
    expect(csv.split('\r\n')).toEqual(['lot,winner,winning_bid,bid_count', 'Route A,Acme Freight,500,1']);

    const bids = await (await owner.call(`/api/auctions/${id}/bids.csv`)).text();
    expect(bids).toContain('Route A,Acme Freight,500');
  });

  it('refuses requests without a session', async () => {
    const owner = client();
    const { id } = await owner.post('/api/auctions', { name: 'Locked', ownerName: 'Olivia' });

    const stranger = client();
    expect((await stranger.call(`/api/auctions/${id}/me`)).status).toBe(401);
    expect((await stranger.call('/api/invite/not-a-real-token')).status).toBe(404);
  });

  it('locks the rules once the auction has started', async () => {
    const owner = client();
    const { id } = await owner.post('/api/auctions', { name: 'Fixed Rules', ownerName: 'Olivia' });
    await owner.post(`/api/auctions/${id}/events`, { type: 'addLot', name: 'Route A' });

    const relaxed = await owner.json(`/api/auctions/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ auctionLengthSec: 90, extendedTimeThresholdSec: 45, lastCallSec: 20 }),
    });
    expect(relaxed.config.auctionLengthSec).toBe(90);

    // Nonsensical rules are rejected outright.
    const bad = await owner.json(`/api/auctions/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ lastCallSec: 999 }),
    });
    expect(bad.ok).toBe(false);

    await owner.post(`/api/auctions/${id}/events`, { type: 'startAuction' });
    const late = await owner.json(`/api/auctions/${id}/config`, {
      method: 'PATCH',
      body: JSON.stringify({ auctionLengthSec: 60 }),
    });
    expect(late.ok).toBe(false);
  });
});

describe('realtime', () => {
  it('pushes events live and anonymises rivals per connection', async () => {
    const owner = client();
    const { id } = await owner.post('/api/auctions', { name: 'Live Room', ownerName: 'Olivia' });
    await owner.post(`/api/auctions/${id}/events`, { type: 'addLot', name: 'Route A' });

    const invite = await owner.post(`/api/auctions/${id}/events`, { type: 'addUser', name: 'Acme Freight', role: 'bidder' });
    const bidder = client();
    await bidder.call(new URL(invite.inviteUrl).pathname);

    const ownerSocket = socket(id, owner.cookie);
    const bidderSocket = socket(id, bidder.cookie);

    await ownerSocket.until((m) => m[0]?.kind === 'snapshot', 'owner snapshot');
    const snapshot = (await bidderSocket.until((m) => m[0]?.kind === 'snapshot', 'bidder snapshot'))[0];

    expect(snapshot.kind === 'snapshot' && snapshot.you.name).toBe('Acme Freight');
    // The organiser's real name is masked for a competing bidder.
    const ownerRow =
      snapshot.kind === 'snapshot' && snapshot.events.find((e) => e.type === 'addUser' && e.publicKey === '0');
    expect(ownerRow && ownerRow.name).toBe('Organiser 0');

    await owner.post(`/api/auctions/${id}/events`, { type: 'startAuction' });
    await bidderSocket.until(
      (m) => m.some((msg) => msg.kind === 'event' && msg.event.type === 'startAuction'),
      'startAuction push',
    );

    const lotId = 'lot-0';
    await bidder.post(`/api/auctions/${id}/events`, { type: 'placeBid', lotId, value: 400 });
    const seen = await ownerSocket.until(
      (m) => m.some((msg) => msg.kind === 'event' && msg.event.type === 'placeBid'),
      'bid push',
    );
    const pushed = seen.find((msg) => msg.kind === 'event' && msg.event.type === 'placeBid');
    expect(pushed && pushed.kind === 'event' && pushed.event.value).toBe(400);

    ownerSocket.close();
    bidderSocket.close();
  });

  it('rejects an unauthenticated socket', async () => {
    const owner = client();
    const { id } = await owner.post('/api/auctions', { name: 'Guarded', ownerName: 'Olivia' });

    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?auction=${id}`);
    await expect(
      new Promise((_resolve, reject) => {
        ws.on('error', reject);
        ws.on('open', () => reject(new Error('socket should not have opened')));
      }),
    ).rejects.toThrow(/401/);
  });
});
