import { createStaffAccount, reloadUser, resendStaffVerification, signIn } from '../auth';
import { isAdminEmail } from '../../shared/admins';
import { escapeHtml, toast } from '../format';

export interface SignInOptions {
  heading: string;
  /** One line saying what signing in will get them, in their own terms. */
  blurb: string;
  /** Runs once they are signed in, so the caller can retry whatever it wanted. */
  onSignedIn: () => void;
}

/**
 * The sign-in gate. Everyone signs in with an email address and a password —
 * the two admins and every participant alike. Participant accounts are created
 * by an admin, who hands over the address and the generated password out of
 * band; an admin sets up their own account here, once, the first time.
 */
export function renderSignIn(root: HTMLElement, options: SignInOptions): void {
  root.innerHTML = `
    <div class="create">
      <h1>${escapeHtml(options.heading)}</h1>
      <p class="sub">${escapeHtml(options.blurb)}</p>
      <form class="card" data-form="signin">
        <label>
          <span>Email address</span>
          <input name="email" type="email" required maxlength="200"
                 placeholder="you@yourfirm.com" autocomplete="email" />
        </label>
        <label>
          <span>Password</span>
          <input name="password" type="password" required maxlength="200"
                 autocomplete="current-password" />
        </label>
        <button class="primary" type="submit" style="width:100%">Sign in</button>
        <p class="muted" data-staff hidden style="font-size:0.85rem;margin:0.8rem 0 0">
          First time as auction staff?
          <button type="button" class="link" data-act="staff-setup">Set your password</button>
        </p>
      </form>
    </div>`;

  const form = root.querySelector<HTMLFormElement>('form')!;
  const emailInput = form.querySelector<HTMLInputElement>('[name="email"]')!;
  const staffLine = form.querySelector<HTMLElement>('[data-staff]')!;

  const syncStaffLine = () => {
    staffLine.hidden = !isAdminEmail(emailInput.value);
  };
  emailInput.addEventListener('input', syncStaffLine);
  syncStaffLine();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    const data = new FormData(form);

    button.disabled = true;
    const result = await signIn(String(data.get('email')), String(data.get('password')));
    button.disabled = false;

    if (!result.ok) {
      toast(result.error ?? 'Could not sign in.', 'error');
      return;
    }
    options.onSignedIn();
  });

  form.querySelector('[data-act="staff-setup"]')?.addEventListener('click', async () => {
    const data = new FormData(form);
    const email = String(data.get('email'));
    const password = String(data.get('password'));

    if (!isAdminEmail(email)) {
      toast('That address is not on the staff list.', 'error');
      return;
    }
    if (password.length < 6) {
      toast('Type a password of at least six characters, then set it.', 'error');
      return;
    }
    const result = await createStaffAccount(email, password);
    if (!result.ok) {
      toast(result.error ?? 'Could not set up the account.', 'error');
      return;
    }
    renderVerifyNotice(root, email);
  });
}

/**
 * After a staff account is created they must click the one verification email
 * before `firestore.rules` will grant admin powers. This is the wait state.
 */
export function renderVerifyNotice(root: HTMLElement, email: string): void {
  root.innerHTML = `
    <div class="create">
      <h1>Verify your email</h1>
      <p class="sub">
        A verification link is on its way to <strong>${escapeHtml(email)}</strong>. Open
        it, then come back here — admin access needs a verified address.
      </p>
      <div class="card">
        <button data-act="resend" style="width:100%">Send it again</button>
        <button class="primary" data-act="reload" style="width:100%;margin-top:0.6rem">
          I've verified — continue
        </button>
      </div>
    </div>`;

  root.querySelector('[data-act="resend"]')?.addEventListener('click', async () => {
    const result = await resendStaffVerification();
    toast(
      result.ok ? `Sent again to ${email}.` : result.error ?? 'Could not resend.',
      result.ok ? 'info' : 'error',
    );
  });
  root.querySelector('[data-act="reload"]')?.addEventListener('click', async () => {
    await reloadUser();
    location.reload();
  });
}
