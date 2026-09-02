import { initializeApp, deleteApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type User,
} from 'firebase/auth';
import { auth, firebaseConfig, usingEmulator } from './firebase';

/**
 * Email/password sign-in — the app's whole notion of "who is this".
 *
 * Every participant has an account with an address and a password. The two
 * admins (see `src/shared/admins.ts`) sign in with their own address and run
 * the auctions; every supplier and client account is *created by an admin* from
 * the admin panel, with a generated password the admin relays out of band.
 *
 * Nothing is emailed by the app. An earlier design used Firebase's passwordless
 * email-link sign-in, but the Spark plan caps those at five per day per project
 * — far too few to seat a real auction — and the cap is tied to the plan, not
 * to the mail transport, so no amount of SMTP configuration lifts it.
 */

/** Firebase lowercases addresses on the token; match that everywhere we key off one. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/** Signs this browser in as an existing account. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  try {
    await signInWithEmailAndPassword(auth, normalizeEmail(email), password);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

/**
 * First-time setup for an admin: creates their account and sends the one
 * address-verification email they need to click. `firestore.rules` requires a
 * *verified* address for admin powers — otherwise anyone could register an
 * admin address here and walk straight in.
 */
export async function createStaffAccount(email: string, password: string): Promise<AuthResult> {
  try {
    const credential = await createUserWithEmailAndPassword(auth, normalizeEmail(email), password);
    await sendEmailVerification(credential.user);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

/** Re-sends the admin verification email, for the "check your inbox" state. */
export async function resendStaffVerification(): Promise<AuthResult> {
  if (!auth.currentUser) return { ok: false, error: 'Sign in first.' };
  try {
    await sendEmailVerification(auth.currentUser);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

export interface ParticipantAccountResult extends AuthResult {
  uid?: string;
  /** True when the address already had an account — seat it, don't recreate it. */
  preexisting?: boolean;
}

/**
 * Creates a participant's account without disturbing the admin's own session.
 *
 * `createUserWithEmailAndPassword` signs in as the account it just made, so it
 * is run on a throwaway secondary Firebase app with in-memory persistence: the
 * primary app (where the admin is signed in) never sees it, and the secondary
 * is torn down immediately afterwards.
 */
export async function createParticipantAccount(
  email: string,
  password: string,
): Promise<ParticipantAccountResult> {
  const address = normalizeEmail(email);
  const secondary = initializeApp(firebaseConfig, `mk-${crypto.randomUUID()}`);
  try {
    const secondaryAuth = initializeAuth(secondary, { persistence: inMemoryPersistence });
    if (usingEmulator) {
      connectAuthEmulator(secondaryAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
    const credential = await createUserWithEmailAndPassword(secondaryAuth, address, password);
    await signOut(secondaryAuth);
    return { ok: true, uid: credential.user.uid };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? '';
    if (code === 'auth/email-already-in-use') {
      return { ok: false, preexisting: true, error: `${address} already has an account.` };
    }
    return { ok: false, error: describeAuthError(err) };
  } finally {
    await deleteApp(secondary).catch(() => {});
  }
}

/**
 * Sets a new password on a participant's account, on a throwaway secondary app.
 *
 * Client-only Firebase can only change a password while signed in *as* that
 * account, so this signs in with the password the admin panel has on file. If
 * the participant has since changed their own password this fails, and the
 * remedy is to remove and re-add them.
 */
export async function setParticipantPassword(
  email: string,
  currentPassword: string,
  newPassword: string,
): Promise<AuthResult> {
  const address = normalizeEmail(email);
  const secondary = initializeApp(firebaseConfig, `pw-${crypto.randomUUID()}`);
  try {
    const secondaryAuth = initializeAuth(secondary, { persistence: inMemoryPersistence });
    if (usingEmulator) {
      connectAuthEmulator(secondaryAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
    }
    const credential = await signInWithEmailAndPassword(secondaryAuth, address, currentPassword);
    await updatePassword(credential.user, newPassword);
    await signOut(secondaryAuth);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  } finally {
    await deleteApp(secondary).catch(() => {});
  }
}

/** A legible generated password: four groups of four unambiguous characters. */
export function generatePassword(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12), chars.slice(12, 16)]
    .map((group) => group.join(''))
    .join('-');
}

/** Resolves with the signed-in user, or null — waits out Firebase's initial restore. */
export function currentUser(): Promise<User | null> {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        unsubscribe();
        resolve(user);
      },
      reject,
    );
  });
}

export async function signOutNow(): Promise<void> {
  await signOut(auth);
}

/**
 * Refreshes the cached user record *and* forces a new ID token, so a just-
 * clicked verification link is reflected both on `user.emailVerified` and in
 * the `email_verified` claim that `firestore.rules` reads.
 */
export async function reloadUser(): Promise<void> {
  if (!auth.currentUser) return;
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
}

/**
 * A participant who cannot get in needs to know *why* in plain words, not a
 * Firebase error code.
 */
function describeAuthError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That does not look like an email address.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/user-disabled':
      return 'That account has been disabled.';
    case 'auth/email-already-in-use':
      return 'That address already has an account.';
    case 'auth/weak-password':
      return 'That password is too weak — use at least six characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection and try again.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is switched off for this Firebase project — enable it under Authentication → Sign-in method.';
    default:
      return err instanceof Error ? err.message : 'Could not sign in.';
  }
}
