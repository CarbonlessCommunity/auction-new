import { collection, doc } from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db } from './firebase';
import { currentUser, normalizeEmail } from './auth';
import type { AuctionConfig, AuctionEvent, Role } from '../shared/types';

/**
 * What lives where in Firestore: the document shapes, the refs to reach them,
 * and the two or three helpers every writer needs. `connection.ts` (the live
 * board) and `management.ts` (the admin panel's provisioning) both build on
 * this and nothing else here talks to the network on its own.
 */

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Firestore document shapes. `auctions/{id}` carries a handful of fields
 * *mirrored* off the event log (name, startedAt, auctionLength, showResults)
 * purely so `firestore.rules` — which cannot fold the log — can do coarse
 * enforcement (time windows, owner-only gates) without reading every event.
 * The client itself always derives truth by folding `events` via
 * `AuctionAggregate.replay`, exactly as before.
 */
export interface AuctionDocData {
  name: string;
  config: AuctionConfig;
  ownerUid: string;
  /** The auctioneer's slot in `users`, so an admin can resolve to it without a seat. */
  ownerPublicKey: string;
  nextSeq: number;
  startedAt: number | null;
  auctionLength: number;
  showResults: boolean;
  /** Server time the auctioneer paused the clock, or null/absent while it runs. */
  pausedAt?: number | null;
  /** Hidden from the admin panel's default list; a precondition for deleting. */
  archived?: boolean;
}

/**
 * `auctions/{id}/users/{publicKey}` — the public roster slot. Deliberately
 * holds *no* identifying data: any signed-in client can read it (a viewer
 * resolves their own slot here before anything else is known about them), so a
 * supplier's firm cannot live here. Only the label and colour a rival is
 * allowed to see. Who occupies the slot is a property of the seat, below.
 */
export interface UserDocData {
  publicKey: string;
  role: Role;
  label: string;
  colorIndex: number;
}

/**
 * `auctions/{id}/seats/{email}` — the access-control table, keyed by the
 * address the auctioneer invited. A signed-in client's verified email is
 * matched straight against this document id, which is what lets
 * `firestore.rules` decide a caller's role without any secret in a URL.
 *
 * `claimedUid`/`claimedAt` are stamped by the seat holder on their first
 * successful sign-in, purely so the auctioneer's roster can tell "invited"
 * apart from "has actually got in".
 */
export interface SeatDocData {
  publicKey: string;
  role: Role;
  invitedAt: number;
  claimedUid?: string;
  claimedAt?: number;
}

/**
 * `auctions/{id}/identities/{publicKey}` — the only place a real name or email
 * exists. `firestore.rules` scopes it to the auctioneer, observers, and the
 * participant themselves, so a supplier cannot read one even by talking to
 * Firestore directly. This, not the render-time filter, is what actually keeps
 * bidders from learning who they are bidding against.
 */
export interface IdentityDocData {
  name: string;
  email?: string;
}

/**
 * `auctions/{id}/credentials/{publicKey}` — the generated password for a
 * participant's account, kept so either admin can re-read and relay it.
 * `firestore.rules` scopes this to admins alone.
 */
export interface CredentialDocData {
  email: string;
  /** null once the participant sets their own password, or if the account pre-existed. */
  password: string | null;
  preexisting: boolean;
  updatedAt: number;
}

/**
 * `auctions/{id}/presence/{uid}` — one heartbeat per open browser, stamped with
 * the *server's* clock. It does two jobs at once. Read back after the write,
 * the server stamp tells this browser how far its own clock is off, which is
 * what keeps every screen's countdown — and so the moment Last Call opens —
 * agreeing (`Connection.now`). Listed by the auctioneer, the stamps say who is
 * actually connected right now, as opposed to who has ever signed in.
 *
 * Carries nothing identifying: only the public slot key. `firestore.rules`
 * lets a participant write their own doc with their own slot and the server's
 * time, and lets only the auctioneer enumerate them.
 */
export interface PresenceDocData {
  publicKey: string;
  at: Timestamp;
}

/** Seconds between heartbeats. */
export const HEARTBEAT_SEC = 30;
/**
 * A participant counts as online for this long after their last heartbeat.
 * Wider than two beats: a browser throttles a background tab's timers to once
 * a minute, and a supplier who has the board in a background tab is still
 * here.
 */
export const ONLINE_WINDOW_SEC = 100;

export const auctionRef = (id: string) => doc(db, 'auctions', id);
export const eventsCol = (id: string) => collection(db, 'auctions', id, 'events');
export const eventRef = (id: string, seq: number) => doc(db, 'auctions', id, 'events', String(seq).padStart(10, '0'));
export const usersCol = (id: string) => collection(db, 'auctions', id, 'users');
export const userRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'users', publicKey);
export const identitiesCol = (id: string) => collection(db, 'auctions', id, 'identities');
export const identityRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'identities', publicKey);
export const seatsCol = (id: string) => collection(db, 'auctions', id, 'seats');
export const seatRef = (id: string, email: string) => doc(db, 'auctions', id, 'seats', normalizeEmail(email));
export const credentialsCol = (id: string) => collection(db, 'auctions', id, 'credentials');
export const credentialRef = (id: string, publicKey: string) => doc(db, 'auctions', id, 'credentials', publicKey);
export const presenceCol = (id: string) => collection(db, 'auctions', id, 'presence');
export const presenceRef = (id: string, uid: string) => doc(db, 'auctions', id, 'presence', uid);

/** Raised when an operation needs a signed-in user and has none. */
export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to continue.');
    this.name = 'NotSignedInError';
  }
}

/**
 * The signed-in user, insisting on an address. Everything downstream — the seat
 * lookup, every rule in `firestore.rules` — keys off that address, so a session
 * without one cannot proceed. Email *verification* is only required of an admin
 * (see `firestore.rules`), and is checked separately in `init()`.
 */
export async function requireUser(): Promise<User & { email: string }> {
  const user = await currentUser();
  if (!user || !user.email) throw new NotSignedInError();
  return user as User & { email: string };
}

/** Fields to mirror onto `auctions/{id}` alongside a newly appended event, for rules' benefit. */
export function mirrorUpdate(event: AuctionEvent): Record<string, unknown> {
  switch (event.type) {
    case 'setName':
      return { name: event.name };
    case 'startAuction':
      return { startedAt: event.time, auctionLength: event.auctionLength };
    case 'pauseAuction':
      // The rules refuse bids while this is set, so a pause holds even
      // against a hand-crafted write.
      return { pausedAt: event.time };
    case 'resumeAuction':
      return { pausedAt: null, auctionLength: event.auctionLength };
    case 'showResults':
      return { showResults: true };
    case 'placeBid':
      // Extended Time pushes the clock out; mirror it so the rules' time-window check stays accurate.
      return event.auctionLength === undefined ? {} : { auctionLength: event.auctionLength };
    default:
      return {};
  }
}
