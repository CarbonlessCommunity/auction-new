import {
  collection,
  deleteDoc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type CollectionReference,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  createParticipantAccount,
  generatePassword,
  normalizeEmail,
  setParticipantPassword,
} from './auth';
import { isAdminEmail } from '../shared/admins';
import { AuctionAggregate, type Participant } from '../shared/aggregate';
import { MAX_BIDDERS, totalRunSec } from '../shared/rules';
import { validateInbound } from '../shared/validation';
import type { AddUserInput, AuctionConfig, Role } from '../shared/types';
import type { Connection } from './connection';
import {
  type ApiResult,
  type AuctionDocData,
  type CredentialDocData,
  type IdentityDocData,
  type SeatDocData,
  auctionRef,
  credentialRef,
  credentialsCol,
  eventRef,
  eventsCol,
  identitiesCol,
  identityRef,
  presenceCol,
  requireUser,
  seatRef,
  seatsCol,
  userRef,
  usersCol,
} from './store';

/**
 * Everything the admin panel does that is not watching a board: listing and
 * creating auctions, and seating, re-credentialing and unseating participants.
 * The participant functions take the open {@link Connection} for the auction
 * they act on — its `submit()` is how the `addUser` event lands, and its `agg`
 * is the roster they read — but none of them is part of running the board.
 */

/** One row of the auctioneer's roster — see {@link roster}. */
export interface RosterEntry {
  publicKey: string;
  /** The real firm/person name. Never leaves an auctioneer's or observer's screen. */
  name: string;
  /** What every other supplier sees instead: "Supplier B". */
  label: string;
  role: Role;
  colorIndex: number;
  /** The participant's address, or null if the seat has been revoked. */
  email: string | null;
  /** When they first signed in, or null if they never have. */
  signedInAt: number | null;
  isYou: boolean;
  /**
   * Admin panel only: the generated password on file for this account, and
   * whether the account pre-existed (in which case there is no password to
   * show — the participant already has one). `password` also goes null once
   * the participant changes it themselves.
   */
  credential?: { password: string | null; preexisting: boolean } | null;
}

/** Random bytes, hex-encoded — used for unguessable auction ids. */
function randomId(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The board URL for an auction — what an admin hands a participant. */
export function auctionUrl(auctionId: string): string {
  return `${location.origin}/a/${auctionId}`;
}

/** One row of the admin panel's auction list. */
export interface AuctionListing {
  id: string;
  name: string;
  createdAt: number | null;
  /** Where it stands, for the list to say at a glance. */
  status: 'not started' | 'running' | 'paused' | 'ended' | 'results released';
  archived: boolean;
}

/** Every auction, newest first — the admin panel's list. Admins only (by rule). */
export async function listAuctions(): Promise<AuctionListing[]> {
  const snap = await getDocs(collection(db, 'auctions'));
  const nowSec = Date.now() / 1000;
  return snap.docs
    .map((docSnap) => {
      const data = docSnap.data() as Partial<AuctionDocData> & { createdAt?: { toMillis?: () => number } };
      const started = typeof data.startedAt === 'number';
      // Read off the mirror fields, which is all a list can afford: a running
      // auction's exact phase is the board's business.
      const status: AuctionListing['status'] = data.showResults
        ? 'results released'
        : !started
          ? 'not started'
          : data.pausedAt != null
            ? 'paused'
            : nowSec > data.startedAt! + (data.auctionLength ?? 0)
              ? 'ended'
              : 'running';
      return {
        id: docSnap.id,
        name: data.name ?? '(untitled)',
        createdAt: data.createdAt?.toMillis?.() ?? null,
        status,
        archived: data.archived === true,
      };
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * Takes an auction off the panel's list, or puts it back. Reversible, changes
 * nothing on the board — and it is the precondition for {@link deleteAuction},
 * which is what keeps a live auction's log out of reach of a stray click.
 */
export async function setArchived(auctionId: string, archived: boolean): Promise<ApiResult> {
  try {
    await updateDoc(auctionRef(auctionId), { archived });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not update the auction.' };
  }
}

/** Firestore takes at most 500 writes in a batch. */
const DELETE_BATCH = 400;

/**
 * Permanently removes an archived auction: every document in every
 * subcollection, then the auction itself. Firestore has no recursive delete,
 * so this walks them — and the rules only let an admin do so once the auction
 * is archived, so a live log can never be deleted by any client.
 *
 * Participants' Firebase Auth accounts are left alone: with no seat they get
 * nowhere, and the same address may be seated in another auction.
 */
export async function deleteAuction(auctionId: string): Promise<ApiResult> {
  try {
    const snap = await getDoc(auctionRef(auctionId));
    if (!snap.exists()) return { ok: false, error: 'No such auction.' };
    if ((snap.data() as AuctionDocData).archived !== true) {
      return { ok: false, error: 'Archive the auction first, then delete it.' };
    }

    // Seats go first: an archived auction's board still works, and a supplier
    // with a seat could otherwise land a bid after the log was purged,
    // leaving an orphan behind. Without a seat the rules refuse it.
    const subcollections: CollectionReference[] = [
      seatsCol(auctionId),
      credentialsCol(auctionId),
      presenceCol(auctionId),
      eventsCol(auctionId),
      usersCol(auctionId),
      identitiesCol(auctionId),
    ];
    for (const col of subcollections) {
      const docs = (await getDocs(col)).docs;
      for (let i = 0; i < docs.length; i += DELETE_BATCH) {
        const batch = writeBatch(db);
        for (const d of docs.slice(i, i + DELETE_BATCH)) batch.delete(d.ref);
        await batch.commit();
      }
    }
    await deleteDoc(auctionRef(auctionId));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not delete the auction.' };
  }
}

export interface CreateAuctionInput {
  name: string;
  ownerName: string;
  config: AuctionConfig;
  /** Contract terms to open the board with, e.g. ['12 Months', '24 Months']. */
  lots: string[];
}

/**
 * Creates a new auction: the auction doc first (so the rules can see it), then
 * the bootstrap `setName`/`addUser` events and the auctioneer's own user and
 * identity docs.
 *
 * The creator is an admin, already signed in — the admin panel is where this is
 * called from. The auctioneer gets a slot in `users` like any participant but
 * *no seat*: an admin resolves to the `owner` role straight from their token
 * (see `resolveYou`), so it works from any device with no capability to carry.
 */
export async function createAuction(input: CreateAuctionInput): Promise<ApiResult & { id?: string }> {
  try {
    const user = await requireUser();
    const id = randomId(6);
    const aRef = auctionRef(id);

    await setDoc(aRef, {
      name: input.name,
      config: input.config,
      ownerUid: user.uid,
      // The auctioneer is always the first `addUser` (seq 1); `setName` adds no
      // user, so its publicKey is '0'. Kept on the doc so an admin can resolve
      // to that slot without reading the log.
      ownerPublicKey: '0',
      nextSeq: 0,
      startedAt: null,
      auctionLength: totalRunSec(input.config),
      showResults: false,
      createdAt: serverTimestamp(),
    });

    const system: Participant = { publicKey: '__system__', role: 'owner' };
    const agg = new AuctionAggregate(id, input.config);

    // Two sequential transactions, not one: the events rule's `seq ==
    // auction().nextSeq` check reads the auction doc via get(), which reflects
    // the state at the start of the transaction, not a sibling write still
    // pending in that same commit (see claimInvite's comment below for the
    // same gotcha). Bundling both bootstrap events into one transaction means
    // the second event's seq can never match the bumped nextSeq.
    const named = validateInbound(agg, { type: 'setName', name: input.name }, system, Date.now() / 1000, 0);
    if (!named.ok) throw new Error(named.error);
    await runTransaction(db, async (tx) => {
      tx.set(eventRef(id, 0), named.event);
      tx.update(aRef, { nextSeq: 1, name: input.name });
    });
    agg.apply(named.event);

    const ownerInput: AddUserInput = {
      type: 'addUser',
      name: input.ownerName,
      role: 'owner',
      email: user.email,
    };
    const owner = validateInbound(agg, ownerInput, system, Date.now() / 1000, 1);
    if (!owner.ok) throw new Error(owner.error);
    const ownerKey = owner.event.publicKey as string;

    await runTransaction(db, async (tx) => {
      tx.set(eventRef(id, 1), owner.event);
      tx.update(aRef, { nextSeq: 2, ownerPublicKey: ownerKey });
      tx.set(userRef(id, ownerKey), {
        publicKey: ownerKey,
        role: 'owner',
        label: owner.event.label as string,
        colorIndex: owner.event.colorIndex as number,
      });
      tx.set(identityRef(id, ownerKey), { name: input.ownerName, email: user.email });
      // No seat: an admin resolves to `owner` from their token alone.
    });
    agg.apply(owner.event);

    // One transaction per term, for the same reason as above: each event's
    // `seq` has to match a `nextSeq` that is already committed.
    for (const [index, lotName] of input.lots.entries()) {
      const lot = validateInbound(agg, { type: 'addLot', name: lotName }, system, Date.now() / 1000, 2 + index);
      if (!lot.ok) throw new Error(lot.error);
      await runTransaction(db, async (tx) => {
        tx.set(eventRef(id, lot.event.seq), lot.event);
        tx.update(aRef, { nextSeq: lot.event.seq + 1 });
      });
      agg.apply(lot.event);
    }

    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the auction.' };
  }
}


function adminGuard(connection: Connection): ApiResult | null {
  return isAdminEmail(connection.email) ? null : { ok: false, error: 'Auctioneers only.' };
}

/**
 * Creates a participant: their email/password account (on a throwaway
 * secondary app, so this admin stays signed in), then the `addUser` event +
 * roster slot + identity + seat, then the generated password on file at
 * `credentials/{publicKey}`.
 *
 * Returns the plaintext password once, for the panel to show and the admin to
 * relay out of band. If the address already had an account it is seated as
 * it is and no password comes back — the participant keeps the one they have.
 */
export async function createParticipant(connection: Connection, input: {
  name: string;
  email: string;
  role: Role;
}): Promise<ApiResult & { email?: string; password?: string; preexisting?: boolean }> {
  const guard = adminGuard(connection);
  if (guard) return guard;

  const address = normalizeEmail(input.email);
  if (input.role === 'bidder' && connection.agg && connection.agg.countRole('bidder') >= MAX_BIDDERS) {
    return { ok: false, error: `An auction can have at most ${MAX_BIDDERS} bidding firms.` };
  }
  const existing = await getDoc(seatRef(connection.auctionId, address));
  if (existing.exists()) {
    return { ok: false, error: `${address} is already taking part in this auction.` };
  }

  const password = generatePassword();
  const account = await createParticipantAccount(address, password);
  if (!account.ok && !account.preexisting) {
    return { ok: false, error: account.error ?? 'Could not create the account.' };
  }
  const preexisting = account.preexisting === true;

  const result = await connection.submit({
    type: 'addUser',
    name: input.name,
    role: input.role,
    email: address,
  });
  if (!result.ok || !result.event) {
    return { ok: false, error: result.error ?? 'Could not add the participant.' };
  }
  const publicKey = result.event.publicKey as string;

  await setDoc(credentialRef(connection.auctionId, publicKey), {
    email: address,
    password: preexisting ? null : password,
    preexisting,
    updatedAt: Date.now() / 1000,
  } satisfies CredentialDocData);

  return { ok: true, email: address, preexisting, ...(preexisting ? {} : { password }) };
}

/**
 * Sets a fresh password on a participant's account and updates the copy on
 * file. Works only while the stored password is still current — if the
 * participant has changed it themselves, remove and re-add them instead.
 */
export async function resetParticipantPassword(
  connection: Connection,
  publicKey: string,
  email: string,
): Promise<ApiResult & { password?: string }> {
  const guard = adminGuard(connection);
  if (guard) return guard;

  const snap = await getDoc(credentialRef(connection.auctionId, publicKey));
  const current = snap.exists() ? (snap.data() as CredentialDocData) : null;
  if (!current || current.preexisting || !current.password) {
    return {
      ok: false,
      error: 'No password on file for this account — remove and re-add them to issue a new one.',
    };
  }

  const next = generatePassword();
  const changed = await setParticipantPassword(email, current.password, next);
  if (!changed.ok) {
    return {
      ok: false,
      error:
        changed.error ??
        'Could not set a new password — the participant may have changed it themselves.',
    };
  }

  await updateDoc(credentialRef(connection.auctionId, publicKey), {
    password: next,
    updatedAt: Date.now() / 1000,
  });
  return { ok: true, password: next };
}

/**
 * Withdraws a participant's access. Deleting the seat is enough on its own —
 * every rule resolves a caller through it — so this bites immediately, on
 * whatever device they are already using. Their slot, colour and any bids
 * stay on the board; the log is append-only.
 */
export async function revokeParticipant(connection: Connection, email: string, publicKey?: string): Promise<ApiResult> {
  const guard = adminGuard(connection);
  if (guard) return guard;
  if (normalizeEmail(email) === connection.email) {
    return { ok: false, error: 'You cannot remove your own access.' };
  }
  try {
    await deleteDoc(seatRef(connection.auctionId, email));
    if (publicKey) await deleteDoc(credentialRef(connection.auctionId, publicKey)).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not remove access.' };
  }
}

/**
 * Moves a slot to a different address and issues that address its own
 * account — the fix for a mistyped email. The old seat is deleted, so anyone
 * on the old address loses access the moment the new one gains it; the slot,
 * colour and any bids are kept.
 */
export async function changeParticipantEmail(
  connection: Connection,
  publicKey: string,
  oldEmail: string,
  newEmail: string,
): Promise<ApiResult & { email?: string; password?: string; preexisting?: boolean }> {
  const guard = adminGuard(connection);
  if (guard) return guard;

  const address = normalizeEmail(newEmail);
  if (address === normalizeEmail(oldEmail)) return { ok: true };

  const user = connection.agg?.users.get(publicKey);
  if (!user) return { ok: false, error: 'No such participant.' };

  const clash = await getDoc(seatRef(connection.auctionId, address));
  if (clash.exists()) {
    return { ok: false, error: `${address} is already taking part in this auction.` };
  }

  const password = generatePassword();
  const account = await createParticipantAccount(address, password);
  if (!account.ok && !account.preexisting) {
    return { ok: false, error: account.error ?? 'Could not create the account.' };
  }
  const preexisting = account.preexisting === true;

  try {
    await setDoc(seatRef(connection.auctionId, address), {
      publicKey,
      role: user.role,
      invitedAt: Date.now() / 1000,
    });
    await deleteDoc(seatRef(connection.auctionId, oldEmail));
    await setDoc(credentialRef(connection.auctionId, publicKey), {
      email: address,
      password: preexisting ? null : password,
      preexisting,
      updatedAt: Date.now() / 1000,
    } satisfies CredentialDocData);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not change the address.' };
  }

  return { ok: true, email: address, preexisting, ...(preexisting ? {} : { password }) };
}

/**
 * The auctioneer's roster: every slot, who holds it, whether they have signed
 * in yet, and — for an admin — the password on file for the account.
 *
 * `identities` (firm name), `seats` (address + sign-in stamp) and
 * `credentials` (password) are joined here because they are protected
 * separately and a supplier may read none of them for anyone but themselves.
 * This is the one view where a name, a colour and an address appear together.
 */
export async function roster(connection: Connection): Promise<RosterEntry[]> {
  if (connection.you?.role !== 'owner' || !connection.agg) return [];
  const admin = isAdminEmail(connection.email);

  const [seatDocs, identityDocs, credentialDocs] = await Promise.all([
    getDocs(seatsCol(connection.auctionId)),
    getDocs(identitiesCol(connection.auctionId)),
    admin ? getDocs(credentialsCol(connection.auctionId)) : Promise.resolve(null),
  ]);

  const seatByKey = new Map<string, { email: string; seat: SeatDocData }>();
  for (const snap of seatDocs.docs) {
    seatByKey.set((snap.data() as SeatDocData).publicKey, {
      email: snap.id,
      seat: snap.data() as SeatDocData,
    });
  }
  const nameByKey = new Map<string, string>();
  const emailByKey = new Map<string, string>();
  for (const snap of identityDocs.docs) {
    const data = snap.data() as IdentityDocData;
    nameByKey.set(snap.id, data.name);
    if (data.email) emailByKey.set(snap.id, data.email);
  }
  const credByKey = new Map<string, { password: string | null; preexisting: boolean }>();
  for (const snap of credentialDocs?.docs ?? []) {
    const data = snap.data() as CredentialDocData;
    credByKey.set(snap.id, { password: data.password, preexisting: data.preexisting });
  }

  return [...connection.agg.users.values()].map((user) => {
    const seated = seatByKey.get(user.publicKey);
    return {
      publicKey: user.publicKey,
      name: nameByKey.get(user.publicKey) ?? user.label,
      label: user.label,
      role: user.role,
      colorIndex: user.colorIndex,
      email: seated?.email ?? emailByKey.get(user.publicKey) ?? null,
      signedInAt: seated?.seat.claimedAt ?? null,
      isYou: user.publicKey === connection.you?.publicKey,
      credential: credByKey.get(user.publicKey) ?? null,
    };
  });
}
