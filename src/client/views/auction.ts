import { Connection } from '../connection';
import type { AuctionAggregate, StoredLot } from '../../shared/aggregate';
import type { AuctionPhase, BidDirection, Role } from '../../shared/types';
import { MAX_BIDDERS, MAX_LOTS } from '../../shared/rules';
import { bidderColor, escapeHtml, formatClock, formatValue, patch, toast } from '../format';
import { exportBidsCsv, exportResultsCsv } from '../export';
import { BidChart } from './chart';

type Panel = 'lot' | 'person' | 'people' | 'rules' | null;

/** The live auction screen: board, clock, owner tools and chart. */
export function renderAuction(root: HTMLElement, auctionId: string): void {
  root.innerHTML = `
    <header class="topbar" id="topbar">
      <div class="inner">
        <h1 id="v-name">Loading…</h1>
        <div class="clock" id="v-clock"></div>
        <span class="phase" id="v-phase"></span>
        <div class="grow"></div>
        <div class="whoami" id="v-who"></div>
      </div>
    </header>
    <main class="wrap">
      <div class="controls" id="v-controls"></div>
      <div id="v-panel"></div>
      <div id="v-rules"></div>
      <div class="stage">
        <div class="board" id="v-board"></div>
        <div class="chartwrap" id="v-chartwrap" hidden>
          <p class="chart-empty" id="v-chartempty">No Bids to Display</p>
          <canvas id="v-chart"></canvas>
        </div>
      </div>
    </main>
  `;

  const connection = new Connection(auctionId);
  const el = {
    topbar: root.querySelector<HTMLElement>('#topbar')!,
    name: root.querySelector<HTMLElement>('#v-name')!,
    clock: root.querySelector<HTMLElement>('#v-clock')!,
    phase: root.querySelector<HTMLElement>('#v-phase')!,
    who: root.querySelector<HTMLElement>('#v-who')!,
    controls: root.querySelector<HTMLElement>('#v-controls')!,
    panel: root.querySelector<HTMLElement>('#v-panel')!,
    rules: root.querySelector<HTMLElement>('#v-rules')!,
    board: root.querySelector<HTMLElement>('#v-board')!,
    chartWrap: root.querySelector<HTMLElement>('#v-chartwrap')!,
    chartEmpty: root.querySelector<HTMLElement>('#v-chartempty')!,
  };

  let chart: BidChart | null = null;
  let panel: Panel = null;
  let phaseKey = '';
  let rulesDismissed = false;
  let inviteLinks = new Map<string, string>();

  const isOwner = () => connection.you?.role === 'owner';
  const canBid = () => connection.you?.role === 'bidder';

  // --- rendering ---------------------------------------------------------

  function renderClock(agg: AuctionAggregate, phase: AuctionPhase): void {
    const { lastCallSec } = agg.config;

    // Two clocks, as in the original: the main clock runs the bidding period
    // down to zero, then a separate Last Call clock counts out the final
    // window. `auctionLength` spans both, so the main clock has to subtract
    // Last Call from it — including before the auction starts, where the
    // opening 5:00 is what a supplier expects to see.
    const shown = phase.isInLastCall ? phase.remainingSec : phase.remainingSec - lastCallSec;

    // Once the clock has run out there is nothing left to count down, and the
    // demo's finished board simply drops it.
    el.clock.textContent = phase.isCompleted ? '' : formatClock(shown);

    const status = agg.showResultsReleased
      ? { text: 'Results Released', cls: 'is-released' }
      : phase.isInLastCall
        ? { text: 'Last Call', cls: 'is-lastcall' }
        : phase.isInExtendedTime
          ? { text: 'Extended Time', cls: 'is-extended' }
          : phase.isRunning
            ? { text: '', cls: '' }
            : phase.isCompleted
              ? { text: 'Awaiting Results', cls: '' }
              : { text: 'Not Started', cls: '' };

    el.phase.textContent = status.text;
    el.topbar.className = `topbar ${status.cls}`;
  }

  function renderControls(agg: AuctionAggregate, phase: AuctionPhase): void {
    if (!isOwner()) {
      el.controls.innerHTML = '';
      return;
    }

    const notStarted = agg.startTime === null;
    const buttons: string[] = [];

    if (notStarted) {
      buttons.push(`<button class="primary" data-act="start" ${agg.lots.size ? '' : 'disabled'}>Start auction</button>`);
      buttons.push('<button data-act="panel-rules">Rules</button>');
      // Contract terms are fixed before bidding opens, so this goes away after.
      buttons.push(`<button data-act="panel-lot" ${agg.lots.size >= MAX_LOTS ? 'disabled' : ''}>Add contract term</button>`);
    }
    if (!notStarted && !agg.showResultsReleased) {
      buttons.push(`<button class="primary" data-act="release">Release results</button>`);
    }

    buttons.push('<button data-act="panel-person">Add participant</button>');
    buttons.push(`<button data-act="panel-people">People (${agg.users.size})</button>`);
    buttons.push('<button data-act="export-results">Export results</button>');
    buttons.push('<button data-act="export-bids">Export bids</button>');

    el.controls.innerHTML = buttons.join('');
  }

  function renderPanel(agg: AuctionAggregate): void {
    if (!isOwner() || panel === null) {
      el.panel.innerHTML = '';
      return;
    }

    if (panel === 'lot') {
      el.panel.innerHTML = `
        <form class="card panel" data-form="lot">
          <h3>Add a contract term</h3>
          <div class="row">
            <input class="grow" name="name" data-k="lot-name" placeholder="e.g. 48 Months" required />
            <button class="primary">Add</button>
          </div>
          <p class="muted" style="font-size:0.85rem;margin:0.6rem 0 0">
            Up to ${MAX_LOTS} terms run side by side on one clock, and are fixed once bidding starts.
          </p>
        </form>`;
      return;
    }

    if (panel === 'person') {
      el.panel.innerHTML = `
        <form class="card panel" data-form="person">
          <h3>Add a participant</h3>
          <div class="row">
            <input class="grow" name="name" data-k="person-name" placeholder="Name" required />
            <select name="role" style="width:auto">
              <option value="bidder">${roleLabel('bidder')}</option>
              <option value="viewer">${roleLabel('viewer')}</option>
              <option value="owner">${roleLabel('owner')}</option>
            </select>
            <button class="primary">Add</button>
          </div>
          <p class="muted" style="font-size:0.85rem;margin:0.6rem 0 0">
            You will get a private invite link to send them. Suppliers never see each other's names.
          </p>
        </form>`;
      return;
    }

    if (panel === 'people') {
      const rows = [...agg.users.values()]
        .map((user) => {
          const link = inviteLinks.get(user.publicKey);
          return `
            <li>
              <span class="grow">${escapeHtml(user.name)} <span class="role">${roleLabel(user.role)}</span></span>
              <button class="link" data-act="invite" data-key="${user.publicKey}">
                ${link ? 'new link' : 'get link'}
              </button>
              ${link ? `<button class="link" data-act="copy" data-link="${escapeHtml(link)}">copy</button>` : ''}
            </li>
            ${link ? `<li class="invite">${escapeHtml(link)}</li>` : ''}`;
        })
        .join('');

      el.panel.innerHTML = `<div class="card panel"><h3>People</h3><ul class="people">${rows}</ul></div>`;
      return;
    }

    if (panel === 'rules') {
      const c = agg.config;
      el.panel.innerHTML = `
        <form class="card panel" data-form="rules">
          <h3>Auction rules</h3>
          <label>
            <span>Bid direction</span>
            <select name="bidDirection">
              <option value="reverse" ${c.bidDirection === 'reverse' ? 'selected' : ''}>Reverse — lowest wins</option>
              <option value="forward" ${c.bidDirection === 'forward' ? 'selected' : ''}>Forward — highest wins</option>
            </select>
          </label>
          <div class="grid-2">
            <label><span>Length (s)</span><input type="number" name="auctionLengthSec" value="${c.auctionLengthSec}" min="10" /></label>
            <label><span>Extended time under (s)</span><input type="number" name="extendedTimeThresholdSec" value="${c.extendedTimeThresholdSec}" min="0" /></label>
            <label><span>Last call (s)</span><input type="number" name="lastCallSec" value="${c.lastCallSec}" min="0" /></label>
            <label><span>Last call bidders</span><input type="number" name="lastCallBidders" value="${c.lastCallBidders}" min="0" max="${MAX_BIDDERS}" /></label>
            <label><span>Minimum step</span><input type="number" name="minBidStep" value="${c.minBidStep}" min="0" step="any" /></label>
          </div>
          <button class="primary">Save rules</button>
        </form>`;
    }
  }

  function renderRules(agg: AuctionAggregate): void {
    // Ground rules, shown to a bidder until they place their first bid.
    const you = connection.you;
    const hasBid = you ? agg.activeBids().some((bid) => bid.bidder === you.publicKey) : true;

    if (!canBid() || hasBid || rulesDismissed) {
      el.rules.innerHTML = '';
      return;
    }

    const c = agg.config;
    const better = c.bidDirection === 'reverse' ? 'lower' : 'higher';
    el.rules.innerHTML = `
      <div class="card panel rules">
        <div class="row">
          <h3 class="grow">Ground rules</h3>
          <button class="link" data-act="dismiss-rules">dismiss</button>
        </div>
        <ol>
          <li>You may bid on any or all contract terms, and only bids ${better} than that term's current best are accepted${c.minBidStep > 0 ? `, by at least ${formatValue(c.minBidStep)}` : ''}.</li>
          <li>You see every rival's price but never their name — only their colour.</li>
          <li>A leading bid with under ${formatClock(c.extendedTimeThresholdSec - c.lastCallSec)} left resets the clock to that mark — "Extended Time".</li>
          <li>The final ${formatClock(c.lastCallSec)} is "Last Call"${
            c.lastCallBidders > 0 ? `, open only to each term's ${c.lastCallBidders} leading bidders` : ''
          }: your bids are hidden from other bidders, and theirs from you.</li>
          <li>Results appear once the auctioneer releases them, and the auctioneer may remove a bid made in error at any time.</li>
          <li>The best bidder is not guaranteed the business.</li>
        </ol>
      </div>`;
  }

  function renderBoard(agg: AuctionAggregate, phase: AuctionPhase): void {
    if (agg.lots.size === 0) {
      el.board.innerHTML = `<div class="card muted">No contract terms yet.${
        isOwner() ? ' Add one to get started.' : ''
      }</div>`;
      return;
    }

    const you = connection.you!;
    const bidding = canBid() && phase.isRunning;
    const bidders = [...agg.users.values()].filter((user) => user.role === 'bidder');

    const columns = [...agg.lots.values()]
      .sort((a, b) => a.insertionOrder - b.insertionOrder)
      .map((lot) => lotColumn(agg, lot, phase, you.publicKey, bidding, bidders));

    patch(el.board, columns.join(''));
  }

  /**
   * One contract term: a ladder of every supplier's own best price, best
   * first. Suppliers are identified only by their colour on a bidder's screen
   * — the outbound filter has already replaced rival names by the time we
   * render — while the auctioneer and the client see who is behind each one.
   */
  function lotColumn(
    agg: AuctionAggregate,
    lot: StoredLot,
    phase: AuctionPhase,
    yourKey: string,
    bidding: boolean,
    bidders: Array<{ publicKey: string; name: string }>,
  ): string {
    const ranked = agg.standings(lot.id);

    const rows = ranked
      .map((bid, index) => {
        const user = agg.users.get(bid.bidder);
        return `
          <li class="bid ${index === 0 ? 'lead' : ''} ${bid.bidder === yourKey ? 'ours' : ''}"
              style="--bidder-color:${bidderColor(bid.bidder)}">
            <span class="price">${formatValue(bid.value)}</span>
            <span class="who">${escapeHtml(user?.name ?? 'Unknown')}</span>
            ${isOwner() ? `<button class="link" data-act="cancel" data-seq="${bid.seq}">remove</button>` : ''}
          </li>`;
      })
      .join('');

    // Last Call hands the term to its leaders; everyone else can only watch.
    const eligible = phase.isInLastCall ? agg.lastCallEligible(lot.id) : null;
    const lockedOut = eligible !== null && !eligible.includes(yourKey);

    const yourForm = !bidding
      ? ''
      : lockedOut
        ? `<p class="locked">Last Call — open only to the ${agg.config.lastCallBidders} leading bidders on this term.</p>`
        : `<form class="bidform" data-form="bid" data-lot="${lot.id}">
             <input name="value" type="number" step="any" min="0" data-k="bid-${lot.id}" placeholder="Your bid" required />
             <button class="primary">Bid</button>
           </form>`;

    const onBehalf =
      isOwner() && phase.isRunning && bidders.length
        ? `<form class="bidform" data-form="behalf" data-lot="${lot.id}">
             <select name="bidder">
               ${bidders.map((b) => `<option value="${b.publicKey}">${escapeHtml(b.name)}</option>`).join('')}
             </select>
             <input name="value" type="number" step="any" min="0" data-k="behalf-${lot.id}" placeholder="Amount" required />
             <button>Bid</button>
           </form>`
        : '';

    return `
      <section class="term" data-lot="${lot.id}">
        <header>
          <h2>${escapeHtml(lot.name)}</h2>
          ${isOwner() && agg.startTime === null ? `<button class="link" data-act="rename" data-lot="${lot.id}">rename</button>` : ''}
        </header>
        ${rows ? `<ol class="ladder">${rows}</ol>` : '<p class="empty">(no bids)</p>'}
        ${yourForm}
        ${onBehalf}
      </section>`;
  }

  function update(): void {
    if (connection.authError) {
      el.name.textContent = 'Access denied';
      el.who.innerHTML = '';
      el.controls.innerHTML = '';
      el.panel.innerHTML = '';
      el.rules.innerHTML = '';
      el.board.innerHTML = `<div class="card muted">${escapeHtml(connection.authError)}</div>`;
      el.chartWrap.hidden = true;
      return;
    }

    const agg = connection.agg;
    if (!agg || !connection.you) return;

    const phase = agg.phase(connection.now());
    el.name.textContent = agg.name;
    el.who.textContent = `${connection.you.name} (${roleLabel(connection.you.role)})`;

    renderClock(agg, phase);
    renderControls(agg, phase);
    renderPanel(agg);
    renderRules(agg);
    renderBoard(agg, phase);

    if (agg.lots.size > 0) {
      el.chartWrap.hidden = false;
      chart ??= new BidChart(root.querySelector<HTMLCanvasElement>('#v-chart')!);
      el.chartEmpty.hidden = chart.update(agg);
    }

    phaseKey = keyOf(phase, agg);
  }

  function roleLabel(role: Role): string {
    return role === 'owner' ? 'auctioneer' : role === 'bidder' ? 'supplier' : 'viewer';
  }

  function keyOf(phase: AuctionPhase, agg: AuctionAggregate): string {
    return [phase.isRunning, phase.isInExtendedTime, phase.isInLastCall, phase.isCompleted, agg.showResultsReleased].join('|');
  }

  // --- interaction -------------------------------------------------------

  async function submit(input: Parameters<Connection['submit']>[0], onOk?: (result: Awaited<ReturnType<Connection['submit']>>) => void) {
    const result = await connection.submit(input);
    if (!result.ok) {
      toast(result.error ?? 'Rejected.', 'error');
      return;
    }
    onOk?.(result);
    update();
  }

  /**
   * Empties a bid box by its `data-k` key rather than through the form node we
   * submitted from: a rival's event can land mid-request and re-render the
   * board, leaving that node detached — and `patch` would then carry the old
   * value straight back into the fresh input.
   */
  function clearField(key: string): void {
    const input = root.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(key)}"]`);
    if (input) input.value = '';
  }

  root.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target) return;
    const act = target.dataset.act!;

    if (act.startsWith('panel-')) {
      const next = act.slice(6) as Panel;
      panel = panel === next ? null : next;
      update();
      return;
    }

    if (act === 'dismiss-rules') {
      rulesDismissed = true;
      update();
      return;
    }

    if (act === 'start') {
      await submit({ type: 'startAuction' });
      return;
    }

    if (act === 'release') {
      if (!confirm('Release results to everyone? Last Call bids become visible.')) return;
      await submit({ type: 'showResults' });
      return;
    }

    if (act === 'cancel') {
      await submit({ type: 'cancelBid', bidSeq: Number(target.dataset.seq) });
      return;
    }

    if (act === 'rename') {
      const lot = connection.agg?.lots.get(target.dataset.lot!);
      const name = prompt('New name for this lot:', lot?.name ?? '');
      if (name) await submit({ type: 'renameLot', lotId: target.dataset.lot!, name });
      return;
    }

    if (act === 'invite') {
      const key = target.dataset.key!;
      const result = await connection.createInvite(key);
      if (result.ok && result.inviteUrl) {
        inviteLinks.set(key, result.inviteUrl);
        update();
      } else {
        toast(result.error ?? 'Could not create a link.', 'error');
      }
      return;
    }

    if (act === 'copy') {
      await navigator.clipboard.writeText(target.dataset.link!);
      toast('Invite link copied.');
      return;
    }

    if (act === 'export-results') {
      if (connection.agg) exportResultsCsv(connection.agg);
      return;
    }

    if (act === 'export-bids') {
      if (connection.agg) exportBidsCsv(connection.agg);
    }
  });

  root.addEventListener('submit', async (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-form]');
    if (!form) return;
    event.preventDefault();

    const data = new FormData(form);
    const kind = form.dataset.form;

    if (kind === 'bid') {
      const field = `bid-${form.dataset.lot}`;
      await submit({ type: 'placeBid', lotId: form.dataset.lot!, value: Number(data.get('value')) }, () =>
        clearField(field),
      );
    } else if (kind === 'behalf') {
      const field = `behalf-${form.dataset.lot}`;
      await submit(
        {
          type: 'placeBid',
          lotId: form.dataset.lot!,
          value: Number(data.get('value')),
          onBehalfOfPublicKey: String(data.get('bidder')),
        },
        () => clearField(field),
      );
    } else if (kind === 'lot') {
      await submit({ type: 'addLot', name: String(data.get('name')) }, () => {
        panel = null;
      });
    } else if (kind === 'person') {
      await submit(
        { type: 'addUser', name: String(data.get('name')), role: data.get('role') as Role },
        (result) => {
          const key = String((result.event as { publicKey?: string } | undefined)?.publicKey ?? '');
          if (result.inviteUrl) inviteLinks.set(key, result.inviteUrl);
          panel = 'people';
        },
      );
    } else if (kind === 'rules') {
      const body = {
        bidDirection: data.get('bidDirection') as BidDirection,
        auctionLengthSec: Number(data.get('auctionLengthSec')),
        extendedTimeThresholdSec: Number(data.get('extendedTimeThresholdSec')),
        lastCallSec: Number(data.get('lastCallSec')),
        lastCallBidders: Number(data.get('lastCallBidders')),
        minBidStep: Number(data.get('minBidStep')),
      };
      const result = await connection.updateConfig(body);
      if (result.ok) {
        toast('Rules saved.');
        panel = null;
        update();
      } else {
        toast(result.error ?? 'Could not save rules.', 'error');
      }
    }
  });

  // --- lifecycle ---------------------------------------------------------

  connection.onChange(() => {
    document.querySelector('.offline')?.remove();
    if (!connection.connected) {
      const bar = document.createElement('div');
      bar.className = 'offline';
      bar.textContent = 'Reconnecting…';
      document.body.append(bar);
    }
    update();
  });

  connection.connect();

  // The clock is local; a full re-render only happens when the phase flips.
  setInterval(() => {
    const agg = connection.agg;
    if (!agg) return;

    const phase = agg.phase(connection.now());
    renderClock(agg, phase);
    if (keyOf(phase, agg) === phaseKey) return;

    // Crossing into Last Call changes what this viewer may see, and no event
    // announces it — the clock alone opens the blind window.
    connection.refold();
    update();
  }, 250);
}
