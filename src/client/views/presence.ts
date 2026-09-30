import type { Connection, RosterEntry } from '../connection';
import { formatAgo } from '../format';

/**
 * The status pill on a roster row: is this person here *now*? Heartbeats
 * answer that; the seat's sign-in stamp only says they got in at some point,
 * which is the fallback when no heartbeat has been seen this session.
 */
export function presenceStatus(connection: Connection, entry: RosterEntry): string {
  if (connection.isOnline(entry.publicKey)) return '<span class="status is-online">online now</span>';

  const seen = connection.lastSeen(entry.publicKey);
  if (seen !== null) {
    return `<span class="status is-in">left ${formatAgo(connection.now() - seen)}</span>`;
  }
  if (entry.signedInAt !== null) return '<span class="status is-in">signed in before</span>';
  return '<span class="status is-waiting">not signed in yet</span>';
}
