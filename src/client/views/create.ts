import { createAuction } from '../connection';
import { DEFAULT_CONFIG, MAX_BIDDERS, MAX_LOTS } from '../../shared/rules';
import type { BidDirection } from '../../shared/types';
import { toast } from '../format';

/** The Create Auction page — the modern replacement for `view/create.html`. */
export function renderCreate(root: HTMLElement): void {
  root.innerHTML = `
    <div class="create">
      <h1>Create an auction</h1>
      <p class="sub">
        A live, timed auction. You will get an auctioneer link, plus an invite
        link for every participant you add.
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
        <label>
          <span>Your email (optional)</span>
          <input name="email" type="email" maxlength="200" placeholder="you@example.com" />
        </label>

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
              <span>Length (seconds)</span>
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
            The length spans the whole run: the bidding clock plus Last Call. A
            leading bid placed with less than the extended-time threshold left
            pushes the clock back out to it. Last Call itself is blind, and open
            only to each term's leading bidders.
          </p>
        </details>

        <button class="primary" type="submit" style="width:100%">Create auction</button>
      </form>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('#create-form')!;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button')!;
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

    const result = await createAuction({
      name: String(data.get('name')),
      ownerName: String(data.get('ownerName')),
      email: (data.get('email') as string) || undefined,
      lots,
      config: {
        bidDirection: data.get('bidDirection') as BidDirection,
        auctionLengthSec: number('auctionLengthSec'),
        extendedTimeThresholdSec: number('extendedTimeThresholdSec'),
        lastCallSec: number('lastCallSec'),
        lastCallBidders: number('lastCallBidders'),
        minBidStep: number('minBidStep'),
      },
    });

    if (result.ok && result.id) {
      location.href = `/a/${result.id}`;
    } else {
      toast(result.error ?? 'Could not create the auction.', 'error');
      button.disabled = false;
    }
  });
}
