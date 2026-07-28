import { completeSignInWithEmail, pendingEmail, sendSignInLink } from '../auth';
import { escapeHtml, toast } from '../format';

export interface SignInOptions {
  /** Where the emailed link should land them — usually the page they are on. */
  continueUrl: string;
  heading: string;
  /** One line saying what signing in will get them, in their own terms. */
  blurb: string;
  /** Runs once they are signed in, so the caller can retry whatever it wanted. */
  onSignedIn: () => void;
}

/**
 * The sign-in gate.
 *
 * This screen is the answer to "how does a supplier get to see only his page?"
 * — they say who they are, prove it by opening their own email, and the seat
 * the auctioneer set aside for that address is the only one they can occupy.
 * Nothing about which screen they land on is decided by the URL they were sent.
 */
export function renderSignIn(root: HTMLElement, options: SignInOptions): void {
  const known = pendingEmail.get() ?? '';

  root.innerHTML = `
    <div class="create">
      <h1>${escapeHtml(options.heading)}</h1>
      <p class="sub">${escapeHtml(options.blurb)}</p>
      <form class="card" data-form="signin">
        <label>
          <span>Your email address</span>
          <input name="email" type="email" required maxlength="200" value="${escapeHtml(known)}"
                 placeholder="you@yourfirm.com" autocomplete="email" />
          <small class="muted">
            Use the address the auctioneer invited. We email you a sign-in link —
            there is no password to remember, and no link to lose: you can ask
            for a new one whenever you need it, on any device.
          </small>
        </label>
        <button class="primary" type="submit" style="width:100%">Email me a sign-in link</button>
      </form>
    </div>`;

  root.querySelector('form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const button = form.querySelector('button')!;
    const email = String(new FormData(form).get('email'));

    button.disabled = true;
    const result = await sendSignInLink(email, options.continueUrl, true);
    button.disabled = false;

    if (!result.ok) {
      toast(result.error ?? 'Could not send the link.', 'error');
      return;
    }
    renderLinkSent(root, email, options);
  });
}

/** The "go and check your inbox" state — a dead end until they click the link. */
function renderLinkSent(root: HTMLElement, email: string, options: SignInOptions): void {
  root.innerHTML = `
    <div class="create">
      <h1>Check your email</h1>
      <p class="sub">
        A sign-in link is on its way to <strong>${escapeHtml(email)}</strong>.
        Open it on any device — this page can stay as it is.
      </p>
      <div class="card">
        <p class="muted" style="margin:0 0 1rem">
          Nothing arrived? It may be in the spam folder, or the auctioneer may have
          invited a different address.
        </p>
        <button data-act="again" style="width:100%">Use a different address</button>
      </div>
    </div>`;

  root.querySelector('[data-act="again"]')!.addEventListener('click', () => {
    pendingEmail.clear();
    renderSignIn(root, options);
  });
}

/**
 * Asks for the address a sign-in link was sent to.
 *
 * Firebase requires it at redemption so that a link intercepted in transit
 * cannot be redeemed by whoever intercepted it. Normally it is remembered from
 * the browser that requested the link — but the auctioneer's roster can send
 * one *to someone else*, and that recipient's browser has never seen it. So
 * they confirm it here, which also proves the link reached its intended inbox.
 */
export function renderConfirmEmail(root: HTMLElement, onSignedIn: () => void): void {
  root.innerHTML = `
    <div class="create">
      <h1>Confirm your email</h1>
      <p class="sub">
        For security, type the address this sign-in link was sent to.
      </p>
      <form class="card" data-form="confirm">
        <label>
          <span>Your email address</span>
          <input name="email" type="email" required maxlength="200"
                 placeholder="you@yourfirm.com" autocomplete="email" />
        </label>
        <button class="primary" type="submit" style="width:100%">Sign in</button>
      </form>
    </div>`;

  root.querySelector('form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const button = form.querySelector('button')!;
    button.disabled = true;

    const result = await completeSignInWithEmail(String(new FormData(form).get('email')));
    button.disabled = false;

    if (!result.ok) {
      toast(result.error ?? 'Could not sign in.', 'error');
      return;
    }
    onSignedIn();
  });
}
