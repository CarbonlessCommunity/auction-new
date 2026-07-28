import { createAuction, type CreateAuctionInput } from '../connection';
import { currentUser, sendSignInLink, signOutNow } from '../auth';
import { DEFAULT_CONFIG, MAX_BIDDERS, MAX_LOTS } from '../../shared/rules';
import type { BidDirection } from '../../shared/types';
import { escapeHtml, toast } from '../format';

/**
 * Where a filled-in auction is parked while the creator goes to their inbox.
 *
 * Creating an auction needs a verified address — the auctioneer holds a seat
 * like everyone else — but making someone sign in *before* they may type
 * anything is a poor trade for a form they came here to fill in. So they fill
 * it in, and it waits here across the round trip through their email.
 */
const PENDING_DRAFT_KEY = 'auction:pendingDraft';

/** The Create Auction page. */
export function renderCreate(root: HTMLElement): void {
  void paint(root);
}

async function paint(root: HTMLElement): Promise<void> {
  const user = await currentUser();
  const signedIn = user?.email && user.emailVerified ? user.email : null;

  // Coming back from the inbox with a draft still waiting: finish the job they
  // started rather than making them retype it.
  const draft = readDraft();
  if (signedIn && draft) {
    clearDraft();
    renderCreating(root);
    await create(root, draft);
    return;
  }

  renderForm(root, signedIn);
}

function renderForm(root: HTMLElement, signedIn: string | null): void {
  root.innerHTML = `
    <div class="create">
      <h1>Create an auction</h1>
      <p class="sub">
        A live, timed auction. You run it from your own account, and invite each
        supplier and client by email — nobody shares a link or a password.
      </p>

      <form id="create-form" class="card">
        <label>
          <span>Auction name</span>
          <input name="name" required maxlength="120" placeholder="Midwest Large Load Customer" />
        </label>
        <label>
          <span>Contract terms</span>
          <input name="lots" required maxlength="200" value="12 Months, 24 Months, 36 Months" />
          <small class="muted">
            Up to ${MAX_LOTS}, separated by commas. They all run at once on a single clock,
            and are fixed before bidding opens.
          </small>
        </label>
        <label>
          <span>Your name</span>
          <input name="ownerName" required maxlength="120" placeholder="Auctioneer" value="Auctioneer" />
        </label>
        ${
          signedIn
            ? `<p class="signed-in">
                 Signed in as <strong>${escapeHtml(signedIn)}</strong>.
                 <button type="button" class="link" data-act="signout">not you?</button>
               </p>`
            : `<label>
                 <span>Your email</span>
                 <input name="email" type="email" required maxlength="200"
                        placeholder="you@yourfirm.com" autocomplete="email" />
                 <small class="muted">
                   We email you a sign-in link to confirm it. This is the address you
                   will run the auction from, on any device.
                 </small>
               </label>`
        }

        <details>
          <summary class="muted" style="cursor:pointer;margin:0.5rem 0 1rem">Auction rules</summary>

          <label>
            <span>Bid direction</span>
            <select name="bidDirection">
              <option value="reverse">Reverse — lowest bid wins (procurement)</option>
              <option value="forward">Forward — highest bid wins</option>
            </select>
          </label>

          <div class="grid-2">
            <label>
              <span>Bidding clock (seconds)</span>
              <input name="auctionLengthSec" type="number" min="10" value="${DEFAULT_CONFIG.auctionLengthSec}" />
            </label>
            <label>
              <span>Extended time under (s)</span>
              <input name="extendedTimeThresholdSec" type="number" min="0" value="${DEFAULT_CONFIG.extendedTimeThresholdSec}" />
            </label>
            <label>
              <span>Last call (seconds)</span>
              <input name="lastCallSec" type="number" min="0" value="${DEFAULT_CONFIG.lastCallSec}" />
            </label>
            <label>
              <span>Last call bidders</span>
              <input name="lastCallBidders" type="number" min="0" max="${MAX_BIDDERS}" value="${DEFAULT_CONFIG.lastCallBidders}" />
            </label>
            <label>
              <span>Minimum bid step</span>
              <input name="minBidStep" type="number" min="0" step="any" value="${DEFAULT_CONFIG.minBidStep}" />
            </label>
          </div>
          <p class="muted" style="font-size:0.8rem;margin:0">
            Every number is read off the clock on screen. The bidding clock counts
            down to zero, then Last Call runs for its own window on top — so the
            defaults are 5:00 of bidding followed by 1:00 of Last Call. Extended
            time under 90 means a leading bid with the clock showing less than
            1:30 pushes it back out to 1:30. Last Call is blind, and open only to
            each term's leading bidders.
          </p>
        </details>

        <button class="primary" type="submit" style="width:100%">
          ${signedIn ? 'Create auction' : 'Continue — we’ll email you a link'}
        </button>
      </form>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#create-form')!;

  root.querySelector('[data-act="signout"]')?.addEventListener('click', async () => {
    await signOutNow();
    void paint(root);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]')!  as HTMLButtonElement;
    button.disabled = true;

    const data = new FormData(form);
    const number = (key: string) => Number(data.get(key));

    const lots = String(data.get('lots'))
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean);

    if (lots.length === 0 || lots.length > MAX_LOTS) {
      toast(`Give between 1 and ${MAX_LOTS} contract terms.`, 'error');
      button.disabled = false;
      return;
    }

    const input: CreateAuctionInput = {
      name: String(data.get('name')),
      ownerName: String(data.get('ownerName')),
      lots,
      config: {
        bidDirection: data.get('bidDirection') as BidDirection,
        auctionLengthSec: number('auctionLengthSec'),
        extendedTimeThresholdSec: number('extendedTimeThresholdSec'),
        lastCallSec: number('lastCallSec'),
        lastCallBidders: number('lastCallBidders'),
        minBidStep: number('minBidStep'),
      },
    };

    if (signedIn) {
      await create(root, input);
      button.disabled = false;
      return;
    }

    const email = String(data.get('email'));
    writeDraft(input);
    const sent = await sendSignInLink(email, `${location.origin}/`, true);
    if (!sent.ok) {
      clearDraft();
      toast(sent.error ?? 'Could not send the link.', 'error');
      button.disabled = false;
      return;
    }
    renderLinkSent(root, email);
  });
}

function renderLinkSent(root: HTMLElement, email: string): void {
  root.innerHTML = `
    <div class="create">
      <h1>Check your email</h1>
      <p class="sub">
        A sign-in link is on its way to <strong>${escapeHtml(email)}</strong>.
        Open it and your auction will be created — everything you typed is saved.
      </p>
    </div>`;
}

function renderCreating(root: HTMLElement): void {
  root.innerHTML = `<div class="create"><h1>Creating your auction…</h1></div>`;
}

async function create(root: HTMLElement, input: CreateAuctionInput): Promise<void> {
  const result = await createAuction(input);
  if (result.ok && result.id) {
    location.href = `/a/${result.id}`;
    return;
  }
  toast(result.error ?? 'Could not create the auction.', 'error');
  renderForm(root, (await currentUser())?.email ?? null);
}

// --- the parked draft ------------------------------------------------------

function writeDraft(input: CreateAuctionInput): void {
  localStorage.setItem(PENDING_DRAFT_KEY, JSON.stringify(input));
}

function clearDraft(): void {
  localStorage.removeItem(PENDING_DRAFT_KEY);
}

/**
 * A draft is only ever written by this page one moment earlier, but it is read
 * back out of storage a browser hop later — so treat it as untrusted and drop
 * anything that no longer parses rather than half-creating an auction from it.
 */
function readDraft(): CreateAuctionInput | null {
  const raw = localStorage.getItem(PENDING_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CreateAuctionInput;
    if (!parsed?.name || !parsed?.ownerName || !Array.isArray(parsed.lots) || !parsed.config) {
      clearDraft();
      return null;
    }
    return parsed;
  } catch {
    clearDraft();
    return null;
  }
}
