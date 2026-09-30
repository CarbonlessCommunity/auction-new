import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN_EMAILS } from '../../src/shared/admins';

/**
 * One whole auction, end to end, in three real browsers: an admin creates it
 * and seats two suppliers, the suppliers trade the lead, the clock crosses
 * into Last Call, one of them bids blind, the admin releases results and
 * audits the log. Every assertion below is something a person would check
 * with their own eyes on the day — which is exactly what the unit and rules
 * suites cannot see.
 *
 * Requires the Auth + Firestore emulators (`npm run test:e2e` starts them).
 */

const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1';
const ADMIN = { email: ADMIN_EMAILS[0], password: 'smoke-test-admin' };

/**
 * Registers the admin straight against the Auth emulator, verified, so the
 * test does not have to fish the verification link out of the emulator's
 * outbox. `Authorization: Bearer owner` is the emulator's admin bypass.
 */
async function seedAdmin(): Promise<void> {
  const signUp = await fetch(`${AUTH}/accounts:signUp?key=emulator`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ADMIN.email, password: ADMIN.password, returnSecureToken: true }),
  });
  const { localId } = (await signUp.json()) as { localId: string };
  const verify = await fetch(`${AUTH}/accounts:update?key=emulator`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, emailVerified: true }),
  });
  expect(verify.ok).toBe(true);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A participant's own browser: fresh context, straight to the board, signed in. */
async function openBoard(browser: Browser, auctionId: string, email: string, password: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`/a/${auctionId}`);
  await signIn(page, email, password);
  await expect(page.locator('#v-name')).toHaveText('Smoke Test');
  return page;
}

/** Seats a participant from the admin panel and returns the generated password. */
async function seat(admin: Page, name: string, email: string): Promise<string> {
  const form = admin.locator('form[data-form="add"]');
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="email"]').fill(email);
  await form.getByRole('button', { name: 'Create account' }).click();
  const issued = admin.locator('#mgr-issued');
  await expect(issued).toContainText(`Send these to ${email}`);
  return (await issued.locator('code').nth(2).textContent())!.trim();
}

const ladder = (page: Page, lot: string) => page.locator(`[data-lot="${lot}"] .bid`);

async function bid(page: Page, lot: string, value: string): Promise<void> {
  const box = page.locator(`form[data-form="bid"][data-lot="${lot}"] input[name="value"]`);
  await box.fill(value);
  await box.press('Enter');
}

test('a whole auction: seat, bid, outbid, Last Call, release, audit', async ({ browser, page: admin }) => {
  await seedAdmin();

  // --- the admin panel: create the auction and seat two suppliers ---------
  await admin.goto('/');
  await signIn(admin, ADMIN.email, ADMIN.password);
  await admin.getByRole('button', { name: 'show / hide' }).click();

  const create = admin.locator('#create-slot form');
  await create.locator('[name="name"]').fill('Smoke Test');
  await create.locator('[name="lots"]').fill('12 Months, 24 Months');
  await create.locator('[name="ownerName"]').fill('Organiser');
  // A short run: 20s of bidding, then a 10s blind Last Call.
  await create.locator('summary', { hasText: 'Auction rules' }).click();
  await create.locator('[name="auctionLengthSec"]').fill('20');
  await create.locator('[name="extendedTimeThresholdSec"]').fill('3');
  await create.locator('[name="lastCallSec"]').fill('10');
  await create.getByRole('button', { name: 'Create auction' }).click();

  await expect(admin.locator('#mgr-name')).toHaveText('Smoke Test');
  const auctionId = decodeURIComponent(new URL(admin.url()).hash.replace(/^#\/?/, ''));
  expect(auctionId).toMatch(/^[0-9a-f]{12}$/);

  const alicePassword = await seat(admin, 'Alice Energy', 'alice@example.com');
  const bobPassword = await seat(admin, 'Bob Power', 'bob@example.com');
  await expect(admin.locator('#mgr-participants')).toContainText('not signed in yet');

  // --- the suppliers arrive ---------------------------------------------
  const alice = await openBoard(browser, auctionId, 'alice@example.com', alicePassword);
  const bob = await openBoard(browser, auctionId, 'bob@example.com', bobPassword);
  await expect(alice.locator('#v-who')).toContainText('Supplier view');

  // Heartbeats: the admin panel sees them come online.
  await expect(admin.locator('#mgr-participants')).toContainText('online now');

  // --- the board, as the auctioneer -------------------------------------
  await admin.goto(`/a/${auctionId}`);
  await expect(admin.locator('#v-who')).toContainText('Auctioneer view');
  await expect(admin.locator('[data-act="panel-people"]')).toHaveText('People · 2 of 2 online');
  await admin.locator('[data-act="start"]').click();
  await expect(admin.locator('#v-clock')).not.toHaveText('');
  await expect(alice).toHaveTitle(/^0:\d\d · Smoke Test$/);

  // --- trading the lead --------------------------------------------------
  await expect(alice.locator('form[data-form="bid"][data-lot="lot-0"] input')).toHaveAttribute('placeholder', 'Your bid');
  await bid(alice, 'lot-0', '0.07');
  await expect(ladder(alice, 'lot-0')).toHaveCount(1);
  await expect(ladder(alice, 'lot-0').first()).toContainText('Alice Energy (you)');

  // Bob sees the price to beat, and a rival that is only a colour.
  await expect(bob.locator('form[data-form="bid"][data-lot="lot-0"] input')).toHaveAttribute('placeholder', '< 0.07000');
  await expect(ladder(bob, 'lot-0').first()).toHaveText('0.07000');
  await bid(bob, 'lot-0', '0.069');
  await expect(ladder(bob, 'lot-0')).toHaveCount(2);
  await expect(ladder(bob, 'lot-0').first()).toContainText('Bob Power (you)');

  // Alice is told she lost the lead — on the term, and in the tab title.
  await expect(alice.locator('[data-lot="lot-0"] .outbid')).toContainText("You've been outbid");
  await expect(alice).toHaveTitle(/^Outbid · /);
  // ...and still cannot see who took it.
  await expect(ladder(alice, 'lot-0').first()).toHaveText('0.06900');

  // The auctioneer sees both firms named.
  await expect(ladder(admin, 'lot-0').first()).toContainText('Bob Power');
  await expect(ladder(admin, 'lot-0').nth(1)).toContainText('Alice Energy');

  // A slipped decimal point gets a question first; declining it places nothing.
  bob.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('below the current best');
    void dialog.dismiss();
  });
  await bid(bob, 'lot-0', '0.01');
  await expect(ladder(bob, 'lot-0').first()).toContainText('0.06900');

  // --- Last Call ----------------------------------------------------------
  await expect(admin.locator('#v-phase')).toHaveText('Last Call', { timeout: 30_000 });
  await expect(alice.locator('[data-lot="lot-0"] .locked')).toContainText('Last Call is blind');
  // Alice's board narrows to her own bid alone.
  await expect(ladder(alice, 'lot-0')).toHaveCount(1);

  await bid(bob, 'lot-0', '0.05');
  // The auctioneer watches it land live; Alice must not.
  await expect(ladder(admin, 'lot-0').first()).toContainText('0.05000');
  await expect(ladder(alice, 'lot-0')).toHaveCount(1);
  await expect(alice.locator('section[data-lot="lot-0"]')).not.toContainText('0.05000');

  // --- results ------------------------------------------------------------
  await expect(admin.locator('#v-phase')).toHaveText('Awaiting Results', { timeout: 30_000 });
  await expect(alice.locator('section[data-lot="lot-0"]')).not.toContainText('0.05000');

  admin.once('dialog', (dialog) => void dialog.accept());
  await admin.locator('[data-act="release"]').click();
  await expect(admin.locator('#v-phase')).toHaveText('Results Released');
  await expect(ladder(alice, 'lot-0').first()).toHaveText('0.05000');
  await expect(alice.locator('section[data-lot="lot-0"]')).not.toContainText('Bob');

  // --- the audit ------------------------------------------------------------
  await admin.locator('[data-act="panel-audit"]').click();
  await expect(admin.locator('#v-panel')).toContainText(/All \d+ events pass/);
});
