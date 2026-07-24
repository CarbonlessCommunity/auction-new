import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuctionConfig, AuctionEvent, InboundEventInput, Role } from '../shared/types';
import { AuctionAggregate, type StoredUser } from '../shared/aggregate';
import { parseConfig } from './config';
import { hashToken, randomToken } from './auth';
import { validateInbound, type InboundResult } from './validation';

export interface AuctionRow {
  id: string;
  name: string;
  config: AuctionConfig;
  createdAt: number;
}

export interface SubmitResult {
  result: InboundResult;
  /** Present only for a successful addUser — shown once to the owner. */
  inviteToken?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auctions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  auction_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  time       REAL NOT NULL,
  PRIMARY KEY (auction_id, seq)
);

CREATE TABLE IF NOT EXISTS users (
  auction_id       TEXT NOT NULL,
  public_key       TEXT NOT NULL,
  role             TEXT NOT NULL,
  name             TEXT NOT NULL,
  email            TEXT,
  invite_token_sha TEXT UNIQUE,
  PRIMARY KEY (auction_id, public_key)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_sha  TEXT PRIMARY KEY,
  auction_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  expires_at REAL NOT NULL
);
`;

const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

export function openDatabase(file: string): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/**
 * Persistence plus the write path for the event log. Because better-sqlite3 is
 * synchronous and Node is single-threaded, `submit` runs to completion without
 * interleaving — it replaces the App Engine cross-group transaction the
 * original needed in `db.append_event`.
 */
export class Repository {
  private db: Database.Database;
  private cache = new Map<string, AuctionAggregate>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  // --- auctions ----------------------------------------------------------

  createAuction(id: string, name: string, config: AuctionConfig): void {
    this.db
      .prepare('INSERT INTO auctions (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, JSON.stringify(config), Date.now() / 1000);
  }

  getAuction(id: string): AuctionRow | null {
    const row = this.db.prepare('SELECT * FROM auctions WHERE id = ?').get(id) as
      | { id: string; name: string; config_json: string; created_at: number }
      | undefined;
    if (!row) return null;
    return { id: row.id, name: row.name, config: parseConfig(JSON.parse(row.config_json)), createdAt: row.created_at };
  }

  updateConfig(id: string, config: AuctionConfig): void {
    this.db.prepare('UPDATE auctions SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
    this.cache.delete(id);
  }

  updateName(id: string, name: string): void {
    this.db.prepare('UPDATE auctions SET name = ? WHERE id = ?').run(name, id);
  }

  // --- events ------------------------------------------------------------

  getEvents(auctionId: string, sinceSeq = 0): AuctionEvent[] {
    const rows = this.db
      .prepare('SELECT data_json FROM events WHERE auction_id = ? AND seq >= ? ORDER BY seq')
      .all(auctionId, sinceSeq) as Array<{ data_json: string }>;
    return rows.map((row) => JSON.parse(row.data_json) as AuctionEvent);
  }

  private nextSeq(auctionId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM events WHERE auction_id = ?')
      .get(auctionId) as { next: number };
    return row.next;
  }

  /** Rebuilds (and memoises) the derived state by folding the log. */
  aggregate(auctionId: string): AuctionAggregate | null {
    const cached = this.cache.get(auctionId);
    if (cached) return cached;

    const auction = this.getAuction(auctionId);
    if (!auction) return null;

    const agg = AuctionAggregate.replay(auctionId, auction.config, this.getEvents(auctionId));
    this.cache.set(auctionId, agg);
    return agg;
  }

  /**
   * Validates a submission, appends it to the log, and folds it into the
   * cached aggregate. The only way events enter the system.
   */
  submit(auctionId: string, input: InboundEventInput, actor: StoredUser, now = Date.now() / 1000): SubmitResult {
    const agg = this.aggregate(auctionId);
    if (!agg) return { result: { ok: false, error: 'No such auction.' } };

    const seq = this.nextSeq(auctionId);
    const result = validateInbound(agg, input, actor, now, seq);
    if (!result.ok) return { result };

    const event = result.event;
    let inviteToken: string | undefined;

    const persist = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO events (auction_id, seq, type, data_json, time) VALUES (?, ?, ?, ?, ?)')
        .run(auctionId, event.seq, event.type, JSON.stringify(event), event.time);

      if (event.type === 'addUser') {
        inviteToken = randomToken();
        this.db
          .prepare(
            `INSERT INTO users (auction_id, public_key, role, name, email, invite_token_sha)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            auctionId,
            event.publicKey as string,
            event.role as string,
            event.name as string,
            (event.email as string | undefined) ?? null,
            hashToken(inviteToken),
          );
      }

      if (event.type === 'setName') this.updateName(auctionId, event.name as string);
    });

    persist();
    agg.apply(event);

    return { result: { ok: true, event }, inviteToken };
  }

  // --- users & sessions --------------------------------------------------

  getUser(auctionId: string, publicKey: string): StoredUser | null {
    const row = this.db
      .prepare('SELECT public_key, role, name, email FROM users WHERE auction_id = ? AND public_key = ?')
      .get(auctionId, publicKey) as
      | { public_key: string; role: string; name: string; email: string | null }
      | undefined;
    if (!row) return null;
    return {
      publicKey: row.public_key,
      role: row.role as Role,
      name: row.name,
      ...(row.email ? { email: row.email } : {}),
    };
  }

  listUsersWithInvites(auctionId: string): Array<StoredUser & { hasInvite: boolean }> {
    const rows = this.db
      .prepare('SELECT public_key, role, name, email, invite_token_sha FROM users WHERE auction_id = ? ORDER BY CAST(public_key AS INTEGER)')
      .all(auctionId) as Array<{ public_key: string; role: string; name: string; email: string | null; invite_token_sha: string | null }>;
    return rows.map((row) => ({
      publicKey: row.public_key,
      role: row.role as Role,
      name: row.name,
      ...(row.email ? { email: row.email } : {}),
      hasInvite: row.invite_token_sha !== null,
    }));
  }

  /** Looks up (and consumes nothing — links stay reusable) an invite token. */
  findUserByInviteToken(token: string): { auctionId: string; publicKey: string } | null {
    const row = this.db
      .prepare('SELECT auction_id, public_key FROM users WHERE invite_token_sha = ?')
      .get(hashToken(token)) as { auction_id: string; public_key: string } | undefined;
    return row ? { auctionId: row.auction_id, publicKey: row.public_key } : null;
  }

  setInviteToken(auctionId: string, publicKey: string, token: string): void {
    this.db
      .prepare('UPDATE users SET invite_token_sha = ? WHERE auction_id = ? AND public_key = ?')
      .run(hashToken(token), auctionId, publicKey);
  }

  createSession(auctionId: string, publicKey: string, now = Date.now() / 1000): string {
    const token = randomToken();
    this.db
      .prepare('INSERT INTO sessions (token_sha, auction_id, public_key, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), auctionId, publicKey, now + SESSION_TTL_SEC);
    return token;
  }

  resolveSession(token: string, now = Date.now() / 1000): { auctionId: string; publicKey: string } | null {
    const row = this.db
      .prepare('SELECT auction_id, public_key, expires_at FROM sessions WHERE token_sha = ?')
      .get(hashToken(token)) as { auction_id: string; public_key: string; expires_at: number } | undefined;
    if (!row || row.expires_at < now) return null;
    return { auctionId: row.auction_id, publicKey: row.public_key };
  }
}
