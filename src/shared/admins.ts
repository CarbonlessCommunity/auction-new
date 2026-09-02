/**
 * The people who run auctions. An admin signs in with their own email/password,
 * lands on the admin panel at `/`, and is treated as the `owner` of every
 * auction — they create auctions and provision every participant's account.
 *
 * IMPORTANT: these two addresses are also written literally into
 * `firestore.rules` (`isAdmin()`), which cannot import this file. Change one,
 * change the other.
 */
export const ADMIN_EMAILS = [
  'jeffreyhuang165@gmail.com',
  'craig.r.schuttenberg@gmail.com',
] as const;

/** Firebase lowercases the address on the token; compare on the same footing. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return (ADMIN_EMAILS as readonly string[]).includes(normalized);
}
