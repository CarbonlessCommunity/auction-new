import {
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  type User,
} from 'firebase/auth';
import { auth } from './firebase';

/**
 * Passwordless email-link sign-in — the app's whole notion of "who is this".
 *
 * The previous model bound a slot to an *anonymous* Firebase uid the first time
 * someone opened an invite URL. That had two problems the auction could not
 * live with: the link was a bearer token (whoever it was forwarded to became
 * that supplier), and the binding was to a browser, so clearing cookies or
 * switching laptop locked a supplier out of a live auction with no way back in.
 *
 * Here a participant proves control of the email address the auctioneer
 * invited. Firebase issues the same uid for a given address on every device, so
 * signing in again — anywhere, any number of times — lands on the same seat,
 * and `firestore.rules` can key access off `request.auth.token.email` rather
 * than a secret in a URL.
 */

/**
 * Where the email address is parked between sending the link and following it.
 * Firebase requires the address at completion to stop a link intercepted in
 * transit from being redeemed by someone else. When the link was sent from
 * *another* browser — the auctioneer inviting a supplier — nothing is stored
 * here and the caller has to ask for it; see {@link pendingEmail}.
 */
const PENDING_EMAIL_KEY = 'auction:pendingEmail';

export const pendingEmail = {
  get: () => localStorage.getItem(PENDING_EMAIL_KEY),
  set: (email: string) => localStorage.setItem(PENDING_EMAIL_KEY, email),
  clear: () => localStorage.removeItem(PENDING_EMAIL_KEY),
};

/** Firebase lowercases addresses on the token; match that everywhere we key off one. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/**
 * Emails a sign-in link that returns the recipient to `continueUrl`.
 *
 * Callable for any address, not just the current browser's — that is what lets
 * the auctioneer (re)send a supplier's invitation from the roster screen. The
 * address is only remembered locally when we are inviting ourselves, since a
 * stored address from an unrelated invite would be the wrong one to complete
 * with later.
 */
export async function sendSignInLink(email: string, continueUrl: string, remember: boolean): Promise<AuthResult> {
  const address = normalizeEmail(email);
  try {
    await sendSignInLinkToEmail(auth, address, { url: continueUrl, handleCodeInApp: true });
    if (remember) pendingEmail.set(address);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
}

/** True when this page load is a click on a sign-in link. */
export function isSignInLink(): boolean {
  return isSignInWithEmailLink(auth, location.href);
}

/**
 * Completes a sign-in link click. Returns `needsEmail` when the link was opened
 * on a device that never sent it (the auctioneer-sent case), in which case the
 * caller must collect the address and call {@link completeSignInWithEmail}.
 */
export async function completeSignIn(): Promise<AuthResult & { user?: User; needsEmail?: boolean }> {
  if (!isSignInLink()) return { ok: false, error: 'Not a sign-in link.' };
  const stored = pendingEmail.get();
  if (!stored) return { ok: false, needsEmail: true };
  return completeSignInWithEmail(stored);
}

export async function completeSignInWithEmail(email: string): Promise<AuthResult & { user?: User }> {
  try {
    const credential = await signInWithEmailLink(auth, normalizeEmail(email), location.href);
    pendingEmail.clear();
    // The link carries a single-use code; leaving it in the address bar means a
    // refresh tries to redeem it again and fails with a confusing error.
    history.replaceState(null, '', location.pathname);
    return { ok: true, user: credential.user };
  } catch (err) {
    return { ok: false, error: describeAuthError(err) };
  }
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
  pendingEmail.clear();
  await signOut(auth);
}

/**
 * A supplier who cannot get in mid-auction needs to know *why* in the words of
 * the thing they just did, not a Firebase error code.
 */
function describeAuthError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'auth/invalid-email':
      return 'That does not look like an email address.';
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code':
      return 'That sign-in link has expired or has already been used. Ask for a new one.';
    case 'auth/user-disabled':
      return 'That account has been disabled.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'auth/unauthorized-continue-uri':
    case 'auth/invalid-continue-uri':
      return 'This site is not on the project’s authorised domains — add it under Authentication → Settings in the Firebase console.';
    case 'auth/operation-not-allowed':
      return 'Email link sign-in is switched off for this Firebase project — enable it under Authentication → Sign-in method.';
    default:
      return err instanceof Error ? err.message : 'Could not sign in.';
  }
}
