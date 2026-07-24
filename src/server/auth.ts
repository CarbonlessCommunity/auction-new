import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as cookie from 'cookie';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Session-cookie auth, replacing the original's private-key-in-the-URL scheme
 * (`/<timeline>.<privateKey>`), where anyone with the link — or a referer log,
 * or a shoulder — had the credential forever.
 *
 * Invite links still carry a token, but it is exchanged once for an httpOnly
 * cookie and only its SHA-256 is ever stored.
 */

export const SESSION_COOKIE = 'auction_sid';

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed[SESSION_COOKIE] ?? null;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
      secure: process.env.NODE_ENV === 'production',
    }),
  );
}
