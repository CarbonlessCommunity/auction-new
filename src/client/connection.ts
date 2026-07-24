import { AuctionAggregate } from '../shared/aggregate';
import type { AuctionEvent, AuctionMeta, InboundEventInput, ServerMessage, UserView } from '../shared/types';

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export async function api<T extends ApiResult>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({ ok: false, error: 'Bad response.' }))) as T;
  if (!response.ok && body.error === undefined) body.error = `Request failed (${response.status}).`;
  return body;
}

/**
 * Live connection to one auction: holds the locally-folded view of the event
 * log and keeps it current over a WebSocket. Replaces the original's
 * `$eventStream` factory, which re-polled `/events?since=N` every 2 seconds.
 */
export class Connection {
  readonly auctionId: string;
  agg: AuctionAggregate | null = null;
  auction: AuctionMeta | null = null;
  you: UserView | null = null;
  connected = false;

  private socket: WebSocket | null = null;
  private skew = 0;
  private retry = 0;
  private listeners = new Set<() => void>();

  constructor(auctionId: string) {
    this.auctionId = auctionId;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Current time in seconds, corrected towards the server's clock. */
  now(): number {
    return Date.now() / 1000 + this.skew;
  }

  connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const openedAt = Date.now() / 1000;
    const socket = new WebSocket(`${scheme}://${location.host}/ws?auction=${encodeURIComponent(this.auctionId)}`);
    this.socket = socket;

    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data as string) as ServerMessage;
      this.handle(message, openedAt);
      this.emit();
    };

    socket.onopen = () => {
      this.retry = 0;
    };

    socket.onclose = () => {
      this.connected = false;
      this.emit();
      // Back off up to ~10s; the server is usually just restarting in dev.
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), Math.min(500 * 2 ** this.retry, 10_000));
    };

    socket.onerror = () => socket.close();
  }

  private handle(message: ServerMessage, openedAt: number): void {
    switch (message.kind) {
      case 'snapshot': {
        // Estimate clock skew from the handshake mid-point, as the original
        // did with the Date header on each poll.
        const midpoint = (openedAt + Date.now() / 1000) / 2;
        this.skew = message.serverTime - midpoint;

        this.auction = message.auction;
        this.you = message.you;
        this.agg = AuctionAggregate.replay(message.auction.id, message.auction.config, message.events);
        this.connected = true;
        break;
      }

      case 'event':
        this.agg?.apply(message.event);
        break;

      case 'error':
        console.warn('server:', message.message);
        break;
    }
  }

  /**
   * Submits an event over REST and lets the WebSocket echo update local state,
   * so a client can never show a bid the server did not actually accept.
   */
  async submit(input: InboundEventInput): Promise<ApiResult & { event?: AuctionEvent; inviteUrl?: string }> {
    return api(`/api/auctions/${this.auctionId}/events`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}
