import { api } from '../connection';
import { DEFAULT_CONFIG } from '../../shared/rules';
import { toast } from '../format';

/** The Create Auction page — the modern replacement for `view/create.html`. */
export function renderCreate(root: HTMLElement): void {
  root.innerHTML = `
    <div class="create">
      <h1>Create an auction</h1>
      <p class="sub">
        A live, timed auction. You will get an organiser link, plus an invite
        link for every participant you add.
      </p>

      <form id="create-form" class="card">
        <label>
          <span>Auction name</span>
          <input name="name" required maxlength="120" placeholder="Q3 Freight Tender" />
        </label>
        <label>
          <span>Your name</span>
          <input name="ownerName" required maxlength="120" placeholder="Administrator" value="Administrator" />
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
              <span>Minimum bid step</span>
              <input name="minBidStep" type="number" min="0" step="any" value="${DEFAULT_CONFIG.minBidStep}" />
            </label>
          </div>
          <p class="muted" style="font-size:0.8rem;margin:0">
            A leading bid placed with less than the extended-time threshold left
            pushes the clock back out to it. The final stretch is blind.
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

    const result = await api<{ ok: boolean; id?: string; error?: string }>('/api/auctions', {
      method: 'POST',
      body: JSON.stringify({
        name: data.get('name'),
        ownerName: data.get('ownerName'),
        email: data.get('email') || undefined,
        config: {
          bidDirection: data.get('bidDirection'),
          auctionLengthSec: number('auctionLengthSec'),
          extendedTimeThresholdSec: number('extendedTimeThresholdSec'),
          lastCallSec: number('lastCallSec'),
          minBidStep: number('minBidStep'),
        },
      }),
    });

    if (result.ok && result.id) {
      location.href = `/a/${result.id}`;
    } else {
      toast(result.error ?? 'Could not create the auction.', 'error');
      button.disabled = false;
    }
  });
}
