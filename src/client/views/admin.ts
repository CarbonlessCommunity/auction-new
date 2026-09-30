import { Connection } from '../connection';
import {
  auctionUrl,
  changeParticipantEmail,
  createParticipant,
  listAuctions,
  resetParticipantPassword,
  revokeParticipant,
  roster as loadRoster,
  type RosterEntry,
} from '../management';
import { currentUser, reloadUser, signOutNow } from '../auth';
import { isAdminEmail } from '../../shared/admins';
import type { Role } from '../../shared/types';
import { bidderColor, escapeHtml, toast } from '../format';
import { renderCreateForm } from './create';
import { presenceStatus } from './presence';
import { renderSignIn, renderVerifyNotice } from './signin';

/**
 * The admin panel at `/`. Only the two addresses in `src/shared/admins.ts` get
 * in. From here an admin creates auctions and, per auction, provisions every
 * participant's email/password account — nothing is emailed by the app, so the
 * admin copies each generated password and relays it out of band.
 *
 * A single auction is opened by putting its id in the hash (`/#<id>`), so a
 * reload keeps you where you were.
 */

let active: Connection | null = null;
let scope: AbortController | null = null;
/** Force one ID-token refresh per session, so a fresh verification click reaches the rules. */
let tokenRefreshed = false;
/** The credentials of the last account created/changed, shown once. */
let lastIssued: { auctionId: string; email: string; password?: string; preexisting: boolean } | null = null;

export function renderAdmin(root: HTMLElement): void {
  window.addEventListener('hashchange', () => void mount(root));
  void mount(root);
}

async function mount(root: HTMLElement): Promise<void> {
  active?.disconnect();
  active = null;
  scope?.abort();
  scope = new AbortController();

  let user = await currentUser();
  if (!user || !user.email) {
    renderSignIn(root, {
      heading: 'Auction admin',
      blurb: 'Sign in to create and run auctions.',
      onSignedIn: () => void mount(root),
    });
    return;
  }
  const email = user.email;
  if (!isAdminEmail(email)) {
    renderNotStaff(root, email);
    return;
  }
  // A stored session can carry a stale `email_verified` in its ID token after a
  // verification click — the client `emailVerified` flips first. Force one token
  // refresh per session so the claim the rules read catches up.
  if (!tokenRefreshed || !user.emailVerified) {
    await reloadUser();
    tokenRefreshed = true;
    user = (await currentUser()) ?? user;
  }
  if (!user.emailVerified) {
    renderVerifyNotice(root, email);
    return;
  }

  const selected = location.hash.replace(/^#\/?/, '').trim();
  if (selected) renderManager(root, selected, scope.signal);
  else void renderList(root, scope.signal);
}

function renderNotStaff(root: HTMLElement, email: string): void {
  root.innerHTML = `
    <div class="create">
      <h1>Staff only</h1>
      <p class="sub">
        You're signed in as <strong>${escapeHtml(email)}</strong>, which isn't an auction
        staff account. If you're a supplier or client, open the board link your auctioneer
        gave you.
      </p>
      <div class="card"><button data-act="signout" style="width:100%">Sign out</button></div>
    </div>`;
  root.querySelector('[data-act="signout"]')?.addEventListener('click', signOutAndReload);
}

async function signOutAndReload(): Promise<void> {
  await signOutNow();
  location.reload();
}

function signedInBar(email: string): string {
  return `<span class="signed-in">${escapeHtml(email)}
    <button class="link" data-act="signout">sign out</button></span>`;
}

function roleLabel(role: Role): string {
  return role === 'owner' ? 'auctioneer' : role === 'bidder' ? 'supplier' : 'client';
}

// --- the auction list ---------------------------------------------------

async function renderList(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const email = (await currentUser())?.email ?? '';
  if (signal.aborted) return;

  root.innerHTML = `
    <div class="wrap">
      <div class="row" style="margin-bottom:1rem">
        <h1 class="grow">Auctions</h1>
        ${signedInBar(email)}
      </div>

      <div class="card panel">
        <div class="row">
          <h3 class="grow">New auction</h3>
          <button class="link" data-act="toggle-create">show / hide</button>
        </div>
        <div id="create-slot" hidden></div>
      </div>

      <div class="card panel">
        <h3>All auctions</h3>
        <div id="auction-list"><p class="muted">Loading…</p></div>
      </div>
    </div>`;

  const slot = root.querySelector<HTMLElement>('#create-slot')!;
  renderCreateForm(slot, (id) => {
    lastIssued = null;
    location.hash = id;
  });

  root.querySelector('[data-act="toggle-create"]')?.addEventListener('click', () => {
    slot.hidden = !slot.hidden;
  });
  root.querySelector('[data-act="signout"]')?.addEventListener('click', signOutAndReload);

  const listEl = root.querySelector<HTMLElement>('#auction-list')!;
  try {
    const auctions = await listAuctions();
    if (signal.aborted) return;
    listEl.innerHTML = auctions.length
      ? `<ul class="people">${auctions
          .map(
            (a) => `
          <li>
            <span class="grow">
              <a href="#${encodeURIComponent(a.id)}"><strong>${escapeHtml(a.name)}</strong></a>
              <br /><span class="muted">${a.createdAt ? new Date(a.createdAt).toLocaleString() : 'just now'}</span>
            </span>
            <a class="button" href="/a/${encodeURIComponent(a.id)}">open board</a>
          </li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">No auctions yet — create one above.</p>';
  } catch (err) {
    if (signal.aborted) return;
    listEl.innerHTML = `<p class="muted">Could not load auctions: ${escapeHtml(
      err instanceof Error ? err.message : String(err),
    )}</p>`;
  }
}

// --- one auction's participants ---------------------------------------

function renderManager(root: HTMLElement, auctionId: string, signal: AbortSignal): void {
  const connection = new Connection(auctionId);
  active = connection;
  let roster: RosterEntry[] | null = null;

  const refresh = async (): Promise<void> => {
    if (signal.aborted) return;
    roster = await loadRoster(connection);
    if (!signal.aborted) draw();
  };

  connection.onChange(() => void refresh());
  connection.connect();
  renderShell();
  void refresh();

  // A participant signing in stamps their seat, which is not an event — so
  // `onChange` never fires for it. Poll the roster (updating only that panel, so
  // the add form is never clobbered) so "signed in yet?" stays current.
  const poll = window.setInterval(() => void refresh(), 5000);
  signal.addEventListener('abort', () => window.clearInterval(poll));

  // One delegated handler each, torn down when the hash changes.
  root.addEventListener('click', onClick, { signal });
  root.addEventListener('submit', onSubmit, { signal });

  /** The parts that never change while this auction is open. */
  function renderShell(): void {
    root.innerHTML = `
      <div class="wrap">
        <div class="row" style="margin-bottom:1rem">
          <a class="link" href="#">← all auctions</a>
          <h1 class="grow" id="mgr-name">Loading…</h1>
          <a class="button" href="/a/${encodeURIComponent(auctionId)}">open board</a>
          ${signedInBar(connection.email ?? '')}
        </div>

        <div id="mgr-issued"></div>

        <div class="card panel">
          <h3>Add a participant</h3>
          <form class="row" data-form="add">
            <input class="grow" name="name" placeholder="Firm or person" required maxlength="120" />
            <input class="grow" name="email" type="email" placeholder="them@theirfirm.com" required maxlength="200" />
            <select name="role" style="width:auto">
              <option value="bidder">supplier</option>
              <option value="viewer">client</option>
              <option value="owner">co-auctioneer</option>
            </select>
            <button class="primary" type="submit">Create account</button>
          </form>
          <p class="hint">
            Creates an email/password account and shows you the generated password to pass
            on. Nothing is emailed. Each supplier gets a colour here; that colour is all the
            other suppliers ever see of them.
          </p>
        </div>

        <div class="card panel">
          <h3>Participants</h3>
          <div id="mgr-participants"><p class="muted">Loading…</p></div>
        </div>
      </div>`;
  }

  /** Updates only the mutable panels, leaving the add form untouched. */
  function draw(): void {
    if (signal.aborted) return;

    if (connection.authError) {
      root.innerHTML = `
        <div class="create">
          <h1>Can't open this auction</h1>
          <p class="sub">${escapeHtml(connection.authError)}</p>
          <div class="card"><a class="button" href="#">← all auctions</a></div>
        </div>`;
      return;
    }
    if (!root.querySelector('#mgr-name')) renderShell();

    root.querySelector('#mgr-name')!.textContent = connection.auction?.name ?? 'Loading…';
    root.querySelector('#mgr-issued')!.innerHTML =
      lastIssued && lastIssued.auctionId === auctionId ? credentialsCard(lastIssued) : '';
    root.querySelector('#mgr-participants')!.innerHTML =
      roster === null ? '<p class="muted">Loading…</p>' : rosterTable(roster);
  }

  function rosterTable(entries: RosterEntry[]): string {
    if (entries.length === 0) return '<p class="muted">Nobody yet.</p>';
    return `<ul class="people">${entries.map(rosterRow).join('')}</ul>`;
  }

  function rosterRow(entry: RosterEntry): string {
    const swatch =
      entry.role === 'bidder'
        ? `<span class="swatch" style="background:${bidderColor(entry.colorIndex)}"></span>`
        : '';
    const status = entry.isYou
      ? ''
      : entry.email === null
        ? '<span class="status is-revoked">access removed</span>'
        : presenceStatus(connection, entry);

    let actions = '';
    if (entry.role !== 'owner') {
      if (entry.email === null) {
        actions = `<button class="link" data-act="change-email" data-key="${entry.publicKey}" data-email="">set an address</button>`;
      } else {
        actions =
          `<button class="link" data-act="reset" data-key="${entry.publicKey}" data-email="${escapeHtml(entry.email)}">new password</button>
           <button class="link" data-act="change-email" data-key="${entry.publicKey}" data-email="${escapeHtml(entry.email)}">change email</button>` +
          (entry.isYou
            ? ''
            : `<button class="link danger" data-act="revoke" data-email="${escapeHtml(entry.email)}" data-key="${entry.publicKey}" data-name="${escapeHtml(entry.name)}">remove</button>`);
      }
    }

    return `
      <li class="roster-row">
        <span class="grow">
          ${swatch}<strong>${escapeHtml(entry.name)}</strong>
          <span class="role">${roleLabel(entry.role)}</span>
          ${entry.role === 'bidder' ? `<span class="role">seen as ${escapeHtml(entry.label)}</span>` : ''}
          <br /><span class="muted">${escapeHtml(entry.email ?? 'no address')}</span>
          ${credentialLine(entry)}
        </span>
        ${status}
        <span class="roster-actions">${actions}</span>
      </li>`;
  }

  function credentialLine(entry: RosterEntry): string {
    if (entry.role === 'owner' || entry.email === null) return '';
    const c = entry.credential;
    if (c?.password) {
      return `<br /><span class="muted">password <code>${escapeHtml(c.password)}</code>
        <button class="link" data-act="copy" data-copy="${escapeHtml(`${entry.email}  ${c.password}`)}">copy</button></span>`;
    }
    if (c?.preexisting) {
      return '<br /><span class="muted">existing account — they use their own password</span>';
    }
    return '<br /><span class="muted">no password on file</span>';
  }

  function credentialsCard(issued: NonNullable<typeof lastIssued>): string {
    const url = auctionUrl(auctionId);
    const copyAll = escapeHtml(`${url}\n${issued.email}\n${issued.password ?? ''}`).replace(/\n/g, '&#10;');
    const body = issued.preexisting
      ? `<p><strong>${escapeHtml(issued.email)}</strong> already had an account — they keep their existing password.</p>`
      : `<p>Send these to <strong>${escapeHtml(issued.email)}</strong> however you like:</p>
         <p>Board: <code>${escapeHtml(url)}</code><br />
            Email: <code>${escapeHtml(issued.email)}</code><br />
            Password: <code>${escapeHtml(issued.password ?? '')}</code></p>
         <button data-act="copy" data-copy="${copyAll}">Copy all</button>`;
    return `<div class="card panel" style="border-left:4px solid var(--accent)">
      <div class="row"><h3 class="grow">Account ready</h3>
      <button class="link" data-act="dismiss-issued">dismiss</button></div>
      ${body}
    </div>`;
  }

  async function onSubmit(event: Event): Promise<void> {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-form="add"]');
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button') as HTMLButtonElement;
    const data = new FormData(form);

    button.disabled = true;
    const result = await createParticipant(connection, {
      name: String(data.get('name')),
      email: String(data.get('email')),
      role: data.get('role') as Role,
    });
    button.disabled = false;

    if (!result.ok) {
      toast(result.error ?? 'Could not add the participant.', 'error');
      return;
    }
    lastIssued = {
      auctionId,
      email: result.email!,
      password: result.password,
      preexisting: result.preexisting === true,
    };
    await refresh();
  }

  async function onClick(event: Event): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const act = target.dataset.act!;

    if (act === 'signout') return void signOutAndReload();

    if (act === 'dismiss-issued') {
      lastIssued = null;
      draw();
      return;
    }

    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(target.dataset.copy ?? '');
        toast('Copied.');
      } catch {
        toast('Could not copy — select the text instead.', 'error');
      }
      return;
    }

    if (act === 'reset') {
      if (!confirm('Issue a new password? Their current one stops working immediately.')) return;
      const result = await resetParticipantPassword(
        connection,
        target.dataset.key!,
        target.dataset.email!,
      );
      if (!result.ok) {
        toast(result.error ?? 'Could not reset the password.', 'error');
        return;
      }
      lastIssued = { auctionId, email: target.dataset.email!, password: result.password, preexisting: false };
      await refresh();
      return;
    }

    if (act === 'change-email') {
      const next = prompt('New email address for this participant:', target.dataset.email ?? '');
      if (!next) return;
      const result = await changeParticipantEmail(
        connection,
        target.dataset.key!,
        target.dataset.email ?? '',
        next,
      );
      if (!result.ok) {
        toast(result.error ?? 'Could not change the address.', 'error');
        return;
      }
      lastIssued = {
        auctionId,
        email: result.email!,
        password: result.password,
        preexisting: result.preexisting === true,
      };
      await refresh();
      return;
    }

    if (act === 'revoke') {
      const nm = target.dataset.name!;
      if (!confirm(`Remove ${nm}? They're signed out immediately; any bids they placed stay on the board.`)) {
        return;
      }
      const result = await revokeParticipant(connection, target.dataset.email!, target.dataset.key!);
      if (!result.ok) {
        toast(result.error ?? 'Could not remove access.', 'error');
        return;
      }
      toast(`${nm} can no longer sign in.`);
      await refresh();
    }
  }
}
