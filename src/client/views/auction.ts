import { Connection } from '../connection';
import { roster as loadRoster, type RosterEntry } from '../management';
import { signOutNow } from '../auth';
import { renderSignIn } from './signin';
import type { AuctionAggregate, StoredLot, StoredUser } from '../../shared/aggregate';
import type { AuctionPhase, BidDirection, Role } from '../../shared/types';
import { MAX_BIDDERS, MAX_LOTS } from '../../shared/rules';
import { auditLog } from '../../shared/audit';
import { bidderColor, escapeHtml, formatClock, formatValue, patch, toast } from '../format';
import { exportBidsCsv, exportResultsCsv } from '../export';
import type { BidChart } from './chart';
import { presenceStatus } from './presence';

type Panel = 'lot' | 'people' | 'rules' | 'audit' | null;

/**
 * A bid this far past the current best — half again, either direction — is
 * more likely a slipped decimal point than a price, so it gets a second look
 * before it lands. Withdrawal exists for the ones that get through, but a
 * wrong bid that sits on the board for even a minute moves everyone else.
 */
const IMPLAUSIBLE_IMPROVEMENT = 0.5;
/** How long the outbid banner pulses after it appears. */
const OUTBID_FLASH_MS = 2500;

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
  let chartLoading: Promise<void> | null = null;
  /** The contract term whose name is being edited inline, if any. */
  let renamingLot: string | null = null;
  let panel: Panel = null;
  let phaseKey = '';
  let rulesDismissed = false;
  /** The auctioneer's roster, fetched on demand — see `refreshRoster`. */
  let roster: RosterEntry[] | null = null;
  /** Per term, who led the last time the board was painted — see `trackOutbid`. */
  const leaders = new Map<string, string | undefined>();
  /** Terms this supplier led and has since lost, and when (local ms). */
  const outbid = new Map<string, number>();

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

    // The tab title carries the clock too, for the supplier who has five
    // terms on this tab and their spreadsheet on another.
    const clock = phase.isCompleted ? status.text || 'Ended' : formatClock(shown);
    const state = phase.isCompleted || !status.text ? '' : ` ${status.text}`;
    const alert = canBid() && outbid.size > 0 ? 'Outbid · ' : '';
    const title = `${alert}${clock}${state} · ${agg.name}`;
    if (document.title !== title) document.title = title;
  }

  /**
   * Notices a supplier losing the lead on a term. Nothing in the log says
   * "you were outbid" — it is a comparison between two paintings of the
   * board — so it is spotted here, once per repaint, and remembered until
   * they lead that term again. Inside blind Last Call a rival's bid never
   * reaches this screen, so nothing fires there; that is the point of blind.
   */
  function trackOutbid(agg: AuctionAggregate): void {
    if (!canBid()) return;
    const me = connection.you!.publicKey;

    for (const lot of agg.lots.values()) {
      const leader = agg.standings(lot.id)[0]?.bidder;
      const previous = leaders.get(lot.id);
      if (previous === me && leader !== undefined && leader !== me) {
        outbid.set(lot.id, Date.now());
        toast(`You've been outbid on ${lot.name}.`, 'warn');
      }
      if (leader === me) outbid.delete(lot.id);
      leaders.set(lot.id, leader);
    }
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
      buttons.push(`<button class="primary" data-act="release">Release results to everyone</button>`);
    }

    // "Who is actually here" is the question in the ten minutes before Start,
    // so it sits on the button rather than behind it.
    const others = [...agg.users.values()].filter((user) => user.publicKey !== connection.you!.publicKey);
    const online = others.filter((user) => connection.isOnline(user.publicKey)).length;
    buttons.push(`<button data-act="panel-people">People · ${online} of ${others.length} online</button>`);
    if (!notStarted) buttons.push('<button data-act="panel-audit">Audit log</button>');
    buttons.push('<button data-act="export-results">Download results (CSV)</button>');
    buttons.push('<button data-act="export-bids">Download bid log (CSV)</button>');

    // The two were easy to confuse: one changes what other people's screens
    // show, the other only puts a file on this machine.
    const hint = agg.showResultsReleased
      ? 'Results are released — every screen now shows the Last Call bids. The downloads are private files for you, and always include the firm names.'
      : notStarted
        ? 'Releasing results is what reveals the Last Call bids on the suppliers’ and client’s screens. Downloading only saves a CSV to this machine.'
        : 'Nobody sees the Last Call bids until you release results. Downloading a CSV changes nothing on their screens — it just saves a file here.';

    el.controls.innerHTML = `${buttons.join('')}<p class="hint">${hint}</p>`;
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

    if (panel === 'people') {
      el.panel.innerHTML = `
        <div class="card panel">
          <h3>People</h3>
          ${roster === null ? '<p class="muted">Loading…</p>' : rosterTable(roster)}
          <p class="hint">
            Add, remove and re-credential participants from the admin panel.
            Everyone signs in with their own address; a supplier's colour is the
            only thing the other suppliers see of them.
          </p>
        </div>`;
      return;
    }

    if (panel === 'audit') {
      el.panel.innerHTML = `
        <div class="card panel">
          <h3>Audit log</h3>
          ${auditReport(agg)}
          <p class="hint">
            Replays the whole log through the same validator every screen uses and lists
            anything it would have refused. Bid arithmetic is enforced only in the
            submitting browser, so an entry here means a write that bypassed it, or a
            badly set clock. Everything listed
            still stands on the board — withdraw it if it should not.
          </p>
        </div>`;
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
            <label><span>Bidding clock (s)</span><input type="number" name="auctionLengthSec" value="${c.auctionLengthSec}" min="10" /></label>
            <label><span>Extended time under (s)</span><input type="number" name="extendedTimeThresholdSec" value="${c.extendedTimeThresholdSec}" min="0" /></label>
            <label><span>Last call (s)</span><input type="number" name="lastCallSec" value="${c.lastCallSec}" min="0" /></label>
            <label><span>Last call bidders</span><input type="number" name="lastCallBidders" value="${c.lastCallBidders}" min="0" max="${MAX_BIDDERS}" /></label>
            <label><span>Minimum step</span><input type="number" name="minBidStep" value="${c.minBidStep}" min="0" step="any" /></label>
          </div>
          <p class="hint">
            Every number is read off the clock on screen: ${formatClock(c.auctionLengthSec)} of bidding,
            Extended Time from ${formatClock(c.extendedTimeThresholdSec)} showing, then
            ${formatClock(c.lastCallSec)} of Last Call on top — ${formatClock(c.auctionLengthSec + c.lastCallSec)} in all.
            Last Call is blind either way; "last call bidders" only sets how many of a
            term's leaders may answer in it (0 leaves it open to everyone).
          </p>
          <button class="primary">Save rules</button>
        </form>`;
    }
  }

  /**
   * The auctioneer's roster: one row per participant, saying who they are, what
   * they can see, and — the question that actually matters in the ten minutes
   * before an auction opens — whether they have managed to get in yet.
   */
  function rosterTable(entries: RosterEntry[]): string {
    const rows = entries
      .map((entry) => {
        const swatch =
          entry.role === 'bidder'
            ? `<span class="swatch" style="background:${bidderColor(entry.colorIndex)}"></span>`
            : '';
        const status = entry.isYou
          ? ''
          : entry.email === null
            ? '<span class="status is-revoked">access removed</span>'
            : presenceStatus(connection, entry);

        return `
          <li class="roster-row">
            <span class="grow">
              ${swatch}<strong>${escapeHtml(entry.name)}</strong>
              <span class="role">${roleLabel(entry.role)}</span>
              ${entry.role === 'bidder' ? `<span class="role">seen as ${escapeHtml(entry.label)}</span>` : ''}
              <br /><span class="muted">${escapeHtml(entry.email ?? 'no address')}</span>
            </span>
            ${status}
          </li>`;
      })
      .join('');

    return `<ul class="people">${rows}</ul>`;
  }

  /** The audit panel's body: a clean bill, or one line per finding. */
  function auditReport(agg: AuctionAggregate): string {
    const report = auditLog(agg.id, agg.config, connection.auditTrail());
    if (report.events === 0) return '<p class="muted">Nothing in the log yet.</p>';
    if (report.findings.length === 0) {
      return `<p class="audit-ok">All ${report.events} events pass — every bid beat the best it could see, every
        Extended Time push was right, and nothing landed outside the clock.</p>`;
    }
    const errors = report.findings.filter((finding) => finding.severity === 'error').length;
    const rows = report.findings
      .map((finding) => {
        const event = connection.auditTrail()[finding.seq];
        const where = describeEvent(agg, event);
        return `<li class="audit-row is-${finding.severity}">
          <span class="audit-seq">#${finding.seq}</span>
          <span class="grow"><strong>${escapeHtml(where)}</strong><br />${escapeHtml(finding.message)}</span>
        </li>`;
      })
      .join('');
    return `<p>${report.events} events, ${report.findings.length} flagged${
      errors ? ` (${errors} would have been refused)` : ''
    }:</p><ul class="audit">${rows}</ul>`;
  }

  /** One line saying what an event was, in board terms. */
  function describeEvent(agg: AuctionAggregate, event: { type: string; [key: string]: unknown } | undefined): string {
    if (!event) return 'unknown event';
    const lot = typeof event.lotId === 'string' ? agg.lots.get(event.lotId)?.name ?? event.lotId : '';
    const who = typeof event.bidder === 'string' ? agg.users.get(event.bidder)?.name ?? event.bidder : '';
    switch (event.type) {
      case 'placeBid':
        return `bid of ${formatValue(event.value as number)} on ${lot} by ${who}${event.placedBy ? ' (entered by the auctioneer)' : ''}`;
      case 'cancelBid':
        return `withdrawal of bid #${event.bidSeq}${who ? ` (${who}'s)` : ''}`;
      case 'addUser':
        return `participant added (${event.label ?? event.publicKey})`;
      case 'addLot':
        return `contract term added (${event.name})`;
      case 'renameLot':
        return `contract term renamed (${event.name})`;
      default:
        return event.type;
    }
  }

  /** Re-reads the roster from Firestore, then repaints whatever is on screen. */
  async function refreshRoster(): Promise<void> {
    if (!isOwner()) return;
    roster = await loadRoster(connection);
    update();
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
          <li>You see every rival's price, but never who they are — a rival is only ever a
              colour. That stays true after the auction ends, and their screens tell them
              no more about you. Your own bids carry your name, on your screen only.</li>
          <li>A leading bid with under ${formatClock(c.extendedTimeThresholdSec)} on the clock resets it to that mark — "Extended Time".</li>
          <li>The clock then runs a final ${formatClock(c.lastCallSec)} of "Last Call"${
            c.lastCallBidders > 0 ? `, open only to each term's ${c.lastCallBidders} leading bidders` : ''
          }: it is blind, so the board shows you your own bids and nothing else until results are released.</li>
          <li>You can remove a bid of your own if you enter it wrongly, and the auctioneer may remove any bid made in error.</li>
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
   * first — and the one place the three screens genuinely differ.
   *
   * On a supplier's screen a rival is only ever a colour: real names were never
   * in the log they folded and the identity docs are closed to them, so there
   * is nothing to print. Their own card carries their own name. The auctioneer
   * and the buying-side client see the same ladder with the firm on every card,
   * which is the only screen where a price and a firm appear together.
   *
   * In Last Call a supplier's board narrows to their own bids alone. Rivals'
   * bids from inside the window were never sent to them (that part is
   * enforced); the pre-window prices they had already seen are simply taken off
   * the board, so the final minute is bid blind on both sides.
   */
  function lotColumn(
    agg: AuctionAggregate,
    lot: StoredLot,
    phase: AuctionPhase,
    yourKey: string,
    bidding: boolean,
    bidders: StoredUser[],
  ): string {
    const yoursOnly = phase.isInLastCall && canBid() && !agg.showResultsReleased;
    const ranked = agg.standings(lot.id).filter((bid) => !yoursOnly || bid.bidder === yourKey);

    const rows = ranked
      .map((bid, index) => {
        const user = agg.users.get(bid.bidder);
        const name = who(user, yourKey);
        // A supplier may withdraw their own mistyped bid; the auctioneer any.
        const removable = isOwner() || (canBid() && bid.bidder === yourKey && phase.isRunning);
        return `
          <li class="bid ${index === 0 && !yoursOnly ? 'lead' : ''} ${bid.bidder === yourKey ? 'ours' : ''}"
              style="--bidder-color:${bidderColor(user?.colorIndex ?? 0)}">
            <span class="price">${formatValue(bid.value)}</span>
            ${name ? `<span class="who">${escapeHtml(name)}</span>` : ''}
            ${removable ? `<button class="link" data-act="cancel" data-seq="${bid.seq}">remove</button>` : ''}
          </li>`;
      })
      .join('');

    const blindNote = !phase.isInLastCall || isOwner() || agg.showResultsReleased
      ? ''
      : canBid()
        ? '<p class="locked">Last Call is blind — you can see your own bids only.</p>'
        : '<p class="locked">Last Call is blind — bids placed now appear when results are released.</p>';

    // Last Call hands the term to its leaders; everyone else can only watch.
    const eligible = phase.isInLastCall ? agg.lastCallEligible(lot.id) : null;
    const lockedOut = eligible !== null && !eligible.includes(yourKey);

    // The number to beat, in the box itself. It is the *visible* best — the
    // same one a bid is validated against — so inside blind Last Call it
    // can only ever name a price this supplier had already seen.
    const target = bidTarget(agg, lot.id);

    const yourForm = !bidding
      ? ''
      : lockedOut
        ? `<p class="locked">Last Call — open only to the ${agg.config.lastCallBidders} leading bidders on this term.</p>`
        : `<form class="bidform" data-form="bid" data-lot="${lot.id}">
             <input name="value" type="number" step="any" min="0" data-k="bid-${lot.id}" placeholder="${escapeHtml(target)}" required />
             <button class="primary">Bid</button>
           </form>`;

    const onBehalf =
      isOwner() && phase.isRunning && bidders.length
        ? `<form class="bidform" data-form="behalf" data-lot="${lot.id}">
             <select name="bidder">
               ${bidders
                 .map((b) => `<option value="${b.publicKey}">${escapeHtml(b.name)}</option>`)
                 .join('')}
             </select>
             <input name="value" type="number" step="any" min="0" data-k="behalf-${lot.id}" placeholder="${escapeHtml(target)}" required />
             <button>Bid</button>
           </form>`
        : '';

    const since = outbid.get(lot.id);
    const outbidNote =
      since === undefined
        ? ''
        : `<p class="outbid ${Date.now() - since < OUTBID_FLASH_MS ? 'flash' : ''}">You've been outbid${
            bidding && !lockedOut ? ' — bid again to lead' : ''
          }</p>`;

    const canRename = isOwner() && agg.startTime === null;
    const header =
      canRename && renamingLot === lot.id
        ? `<form class="bidform" data-form="rename" data-lot="${lot.id}">
             <input name="name" value="${escapeHtml(lot.name)}" data-k="rename-${lot.id}" required maxlength="120" />
             <button class="primary">Save</button>
             <button type="button" class="link" data-act="rename-cancel">cancel</button>
           </form>`
        : `<h2>${escapeHtml(lot.name)}</h2>
           ${canRename ? `<button class="link" data-act="rename" data-lot="${lot.id}">rename</button>` : ''}`;

    return `
      <section class="term ${since === undefined ? '' : 'is-outbid'}" data-lot="${lot.id}">
        <header>${header}</header>
        ${outbidNote}
        ${rows ? `<ol class="ladder">${rows}</ol>` : '<p class="empty">(no bids)</p>'}
        ${blindNote}
        ${yourForm}
        ${onBehalf}
      </section>`;
  }

  /** The best bid this viewer is allowed to see on a term, as `validateInbound` will judge it. */
  function visibleBest(agg: AuctionAggregate, lotId: string): number | null {
    const you = connection.you!;
    return agg.visibleBestFor(lotId, { publicKey: you.publicKey, role: you.role }, connection.now())?.value ?? null;
  }

  /** Placeholder text for a bid box: the price a bid has to beat, or an invitation if there is none. */
  function bidTarget(agg: AuctionAggregate, lotId: string): string {
    const best = visibleBest(agg, lotId);
    if (best === null) return 'Your bid';
    const { bidDirection, minBidStep } = agg.config;
    if (minBidStep > 0) {
      return bidDirection === 'reverse' ? `≤ ${formatValue(best - minBidStep)}` : `≥ ${formatValue(best + minBidStep)}`;
    }
    return bidDirection === 'reverse' ? `< ${formatValue(best)}` : `> ${formatValue(best)}`;
  }

  /**
   * The fat-finger check. A bid the validator will accept can still be a
   * mistake — 0.0537 typed as 0.0057 is a perfectly legal, catastrophically
   * good price — so anything implausibly far past the best gets one plain
   * question before it lands. Null when the bid looks like a price.
   */
  function implausible(agg: AuctionAggregate, lotId: string, value: number): string | null {
    if (!(value > 0)) return `A bid of ${formatValue(value)} is not a price.`;
    const best = visibleBest(agg, lotId);
    if (best === null || best <= 0) return null;
    const improvement = agg.config.bidDirection === 'reverse' ? (best - value) / best : (value - best) / best;
    if (improvement <= IMPLAUSIBLE_IMPROVEMENT) return null;
    const pct = Math.round(improvement * 100);
    return `${formatValue(value)} is ${pct}% ${agg.config.bidDirection === 'reverse' ? 'below' : 'above'} the current best of ${formatValue(best)}.`;
  }

  function update(): void {
    // Nobody is signed in: this is a sign-in problem, not a refusal, and the
    // remedy is a form rather than an apology.
    if (connection.needsSignIn) {
      renderSignIn(root, {
        heading: 'Sign in to this auction',
        blurb:
          'Use the email address and password your auctioneer gave you. Which screen you ' +
          'get — auctioneer, supplier or client — follows from who you are.',
        onSignedIn: () => location.reload(),
      });
      return;
    }

    if (connection.authError) {
      el.name.textContent = 'Access denied';
      el.who.innerHTML = signedInAs();
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
    // The mentor's first complaint was that the three screens were
    // indistinguishable, so each one says what it is and what it shows.
    el.who.innerHTML = `
      <span class="me">${escapeHtml(connection.you.name)}</span>
      <span class="view">${escapeHtml(viewBanner(connection.you.role))}</span>
      ${signedInAs()}`;

    trackOutbid(agg);
    renderClock(agg, phase);
    renderControls(agg, phase);
    renderPanel(agg);
    renderRules(agg);
    renderBoard(agg, phase);

    if (agg.lots.size > 0) {
      el.chartWrap.hidden = false;
      if (chart) {
        el.chartEmpty.hidden = chart.update(agg);
      } else if (!chartLoading) {
        // Chart.js is a third of the bundle and nobody needs it to sign in or
        // read the board, so it arrives after the first paint, on its own.
        chartLoading = import('./chart').then(({ BidChart }) => {
          chart = new BidChart(root.querySelector<HTMLCanvasElement>('#v-chart')!);
          update();
        });
      }
    }

    phaseKey = keyOf(phase, agg);
  }

  function roleLabel(role: Role): string {
    return role === 'owner' ? 'auctioneer' : role === 'bidder' ? 'supplier' : 'client';
  }

  /**
   * How a participant is named on a ladder row — empty for a card that should
   * carry no name at all. A supplier sees their own firm on their own cards and
   * nothing but colour on a rival's; the auctioneer and the client see every
   * firm. (`user.name` is only ever a real name for identities this viewer was
   * allowed to read, so this is a presentation choice on top of an access one,
   * not the thing keeping rivals anonymous.)
   */
  function who(user: StoredUser | undefined, yourKey: string): string {
    if (!user) return '';
    if (user.publicKey === yourKey) return `${user.name} (you)`;
    return canBid() ? '' : user.name;
  }

  /**
   * The address this browser is acting as. On screen at all times, including on
   * the access-denied page: "you are signed in as the wrong address" is by far
   * the most likely reason someone cannot see what they expect, and it is
   * unguessable unless the app says so.
   */
  function signedInAs(): string {
    if (!connection.email) return '';
    return `<span class="signed-in">${escapeHtml(connection.email)}
      <button class="link" data-act="signout">sign out</button></span>`;
  }

  /** The one line that tells someone which of the three screens they are on. */
  function viewBanner(role: Role): string {
    if (role === 'owner') return 'Auctioneer view — you see every firm, including Last Call bids';
    if (role === 'viewer') return 'Client view — you see every firm; Last Call bids appear when released';
    return 'Supplier view — rivals are colours only, and never named';
  }

  function keyOf(phase: AuctionPhase, agg: AuctionAggregate): string {
    return [
      phase.isRunning,
      phase.isInExtendedTime,
      phase.isInLastCall,
      phase.isCompleted,
      agg.showResultsReleased,
      // Someone dropping off the board is a clock event too: their last beat
      // simply ages out, and nothing else would trigger the repaint.
      connection.onlineKey(),
    ].join('|');
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
      // The roster is the one panel whose contents live outside the event log,
      // so opening it is what goes and reads them.
      if (panel === 'people') void refreshRoster();
      return;
    }

    if (act === 'signout') {
      await signOutNow();
      location.reload();
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
      if (!confirm('Release results to everyone? Last Call bids become visible on every screen.')) return;
      await submit({ type: 'showResults' });
      return;
    }

    if (act === 'cancel') {
      const mine = !isOwner();
      if (mine && !confirm('Remove this bid? Your next-best bid on this term takes its place.')) return;
      await submit({ type: 'cancelBid', bidSeq: Number(target.dataset.seq) });
      return;
    }

    if (act === 'rename') {
      renamingLot = target.dataset.lot!;
      update();
      root.querySelector<HTMLInputElement>(`[data-k="rename-${CSS.escape(renamingLot)}"]`)?.select();
      return;
    }

    if (act === 'rename-cancel') {
      renamingLot = null;
      update();
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

    if (kind === 'bid' || kind === 'behalf') {
      const doubt = connection.agg ? implausible(connection.agg, form.dataset.lot!, Number(data.get('value'))) : null;
      if (doubt && !confirm(`${doubt} Place it anyway?`)) return;
    }

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
    } else if (kind === 'rename') {
      const lotId = form.dataset.lot!;
      const name = String(data.get('name')).trim();
      if (!name || name === connection.agg?.lots.get(lotId)?.name) {
        renamingLot = null;
        update();
        return;
      }
      await submit({ type: 'renameLot', lotId, name }, () => {
        renamingLot = null;
      });
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
    // Someone who is not signed in yet is not "reconnecting" — they are being
    // asked a question, and a network warning over the top only muddies it.
    if (!connection.connected && !connection.needsSignIn && !connection.authError) {
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
