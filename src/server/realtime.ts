import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { AuctionEvent, ServerMessage } from '../shared/types';
import type { Repository } from './db';
import { readSessionCookie } from './auth';
import { filterOutbound } from './validation';

interface Client {
  socket: WebSocket;
  auctionId: string;
  publicKey: string;
  alive: boolean;
}

/**
 * One WebSocket room per auction, replacing the original's 2-second polling
 * loop. Every message is passed through `filterOutbound` *per connection*, so
 * two bidders watching the same auction legitimately receive different streams
 * during blind Last Call.
 */
export class Realtime {
  private repo: Repository;
  private wss: WebSocketServer;
  private rooms = new Map<string, Set<Client>>();

  constructor(repo: Repository) {
    this.repo = repo;
    this.wss = new WebSocketServer({ noServer: true });
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const auctionId = url.searchParams.get('auction') ?? '';
      const token = readSessionCookie(req);
      const session = token ? this.repo.resolveSession(token) : null;

      if (!session || session.auctionId !== auctionId || !this.repo.getAuction(auctionId)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.register(ws, auctionId, session.publicKey);
      });
    });

    // Drop connections that stop responding to pings.
    const heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const client of room) {
          if (!client.alive) {
            client.socket.terminate();
            continue;
          }
          client.alive = false;
          client.socket.ping();
        }
      }
    }, 30_000);
    heartbeat.unref();
  }

  private register(socket: WebSocket, auctionId: string, publicKey: string): void {
    const client: Client = { socket, auctionId, publicKey, alive: true };

    let room = this.rooms.get(auctionId);
    if (!room) {
      room = new Set();
      this.rooms.set(auctionId, room);
    }
    room.add(client);

    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      room.delete(client);
      if (room.size === 0) this.rooms.delete(auctionId);
    });
    socket.on('error', () => socket.terminate());

    this.sendSnapshot(client);
  }

  /** Sends the whole visible history — used on connect and on resync. */
  sendSnapshot(client: Client): void {
    const agg = this.repo.aggregate(client.auctionId);
    const auction = this.repo.getAuction(client.auctionId);
    const viewer = this.repo.getUser(client.auctionId, client.publicKey);
    if (!agg || !auction || !viewer) return;

    const now = Date.now() / 1000;
    const events = this.repo
      .getEvents(client.auctionId)
      .map((event) => filterOutbound(agg, event, viewer, now))
      .filter((event): event is AuctionEvent => event !== null);

    send(client.socket, {
      kind: 'snapshot',
      auction: { id: auction.id, name: agg.name, config: auction.config },
      you: { publicKey: viewer.publicKey, role: viewer.role, name: viewer.name },
      events,
      serverTime: now,
    });
  }

  /** Pushes one newly appended event to everyone allowed to see it. */
  broadcast(auctionId: string, event: AuctionEvent): void {
    const room = this.rooms.get(auctionId);
    if (!room) return;

    const agg = this.repo.aggregate(auctionId);
    if (!agg) return;

    const now = Date.now() / 1000;
    for (const client of room) {
      const viewer = this.repo.getUser(auctionId, client.publicKey);
      if (!viewer) continue;

      const visible = filterOutbound(agg, event, viewer, now);
      if (visible) send(client.socket, { kind: 'event', event: visible, serverTime: now });
    }
  }

  /**
   * Re-sends full snapshots to a room. Needed after `showResults`, when bids
   * that were withheld during Last Call become visible retroactively.
   */
  resync(auctionId: string): void {
    const room = this.rooms.get(auctionId);
    if (!room) return;
    for (const client of room) this.sendSnapshot(client);
  }
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
