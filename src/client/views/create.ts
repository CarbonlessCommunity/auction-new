import { createAuction, type CreateAuctionInput } from '../management';
import { DEFAULT_CONFIG, MAX_BIDDERS, MAX_LOTS } from '../../shared/rules';
import type { BidDirection } from '../../shared/types';
import { toast } from '../format';

/**
 * The new-auction form, mounted inside the admin panel. The admin is already
 * signed in, so there is no email round-trip — submitting creates the auction
 * and calls `onCreated` with its id.
 */
export function renderCreateForm(container: HTMLElement, onCreated: (id: string) => void): void {
  container.innerHTML = `
    <form id="create-form">
      <label>
        <span>Auction name</span>
        <input name="name" required maxlength="120" placeholder="Midwest Large Load Customer" />
      </label>
      <label>
        <span>Contract terms</span>
        <input name="lots" required maxlength="200" value="12 Months, 24 Months, 36 Months" />
        <small class="muted">
          Up to ${MAX_LOTS}, comma-separated. They run at once on one clock, and are fixed
          before bidding opens.
        </small>
      </label>
      <label>
        <span>Auctioneer name (shown on the board)</span>
        <input name="ownerName" required maxlength="120" value="Auctioneer" />
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
          <label><span>Bidding clock (s)</span><input name="auctionLengthSec" type="number" min="10" value="${DEFAULT_CONFIG.auctionLengthSec}" /></label>
          <label><span>Extended time under (s)</span><input name="extendedTimeThresholdSec" type="number" min="0" value="${DEFAULT_CONFIG.extendedTimeThresholdSec}" /></label>
          <label><span>Last call (s)</span><input name="lastCallSec" type="number" min="0" value="${DEFAULT_CONFIG.lastCallSec}" /></label>
          <label><span>Last call bidders</span><input name="lastCallBidders" type="number" min="0" max="${MAX_BIDDERS}" value="${DEFAULT_CONFIG.lastCallBidders}" /></label>
          <label><span>Minimum bid step</span><input name="minBidStep" type="number" min="0" step="any" value="${DEFAULT_CONFIG.minBidStep}" /></label>
        </div>
        <p class="muted" style="font-size:0.8rem;margin:0">
          Every number is read off the clock on screen: the bidding clock counts down to
          zero, then Last Call runs for its own window on top — the defaults are 5:00 of
          bidding followed by 1:00 of Last Call.
        </p>
      </details>

      <button class="primary" type="submit" style="width:100%">Create auction</button>
    </form>`;

  const form = container.querySelector<HTMLFormElement>('#create-form')!;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    const data = new FormData(form);
    const number = (key: string) => Number(data.get(key));

    const lots = String(data.get('lots'))
      .split(',')
      .map((term) => term.trim())
      .filter(Boolean);

    if (lots.length === 0 || lots.length > MAX_LOTS) {
      toast(`Give between 1 and ${MAX_LOTS} contract terms.`, 'error');
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

    button.disabled = true;
    const result = await createAuction(input);
    button.disabled = false;

    if (result.ok && result.id) {
      onCreated(result.id);
      return;
    }
    toast(result.error ?? 'Could not create the auction.', 'error');
  });
}
