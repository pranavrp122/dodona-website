/** Customer console: signed-in demo account, hash routes, positions with a split panel (delivery choice, listing, bids), provider and lender tools, overview panels. */
import * as v from '/dashboard-view.js';
import { loadAccount, mountShell, wireNavMore, toast, signOut } from '/platform-shell.js';
import { attachHover, whatIfBlock, whatIfParts } from '/dashboard-charts.js';
import * as plat from '/dashboard-platform.js';

const READ_KEY = 'dodonaDemoAlertsRead';
const DAY_MS = 86400000;
const QUOTE_TIMEOUT_MS = 3000;
const PHONE = '(max-width:720px)';
const SCREENS = ['overview', 'positions', 'alerts', 'market', 'provider', 'lender', 'emails', 'settings'];
const PAGES = {
  overview: ['Overview', 'Overview', 'Your positions, their Dodona Value today and what needs your attention.'],
  positions: ['Positions', 'Positions', 'Every price cap, price floor, fixed price and offtake you hold. Select a row for its term sheet and actions.'],
  alerts: ['Alerts', 'Alerts', "Index moves, deadlines, bids and collateral flags, generated from today's numbers."],
  market: ['Index and implied curve', 'Index and implied curve', 'Ornn daily index for each GPU, and what Kalshi prices imply for the monthly average.'],
  provider: ['Provider view', 'Sell a cap on idle hours', 'Earn a premium today on hours you might not fill. If the average index over the window rises past the cap, the buyer takes the block at the cap price and your cluster is fully rented.'],
  lender: ['Lender view', 'Lender view', 'GPU fleets marked daily from the rental income they can still earn. Move the rent shock to see value, loan-to-value and months to breach.'],
  emails: ['Emails', 'Emails', 'Every email the platform sent this account.'],
  settings: ['Settings', 'Settings', 'Organisation, team, notifications, API, billing and statements.'],
};
const ROLE_TEXT = { buyer: 'Buys compute', provider: 'Provides compute', lender: 'Lends or insures', admin: 'Admin', other: 'Other' };
const RANGE_LABEL = Object.fromEntries(v.RANGES);
const $ = id => document.getElementById(id);
const esc = v.escapeHtml;

const state = {
  data: null, session: null, screen: 'overview', selected: null, splitOpen: true, range: 'all', details: new Map(),
  exercise: null, listing: false, countering: false, whatIfAvg: null, listed: new Map(), read: new Set(), shock: 0,
  stale: false, shortfall: false, busy: false,
  provider: { block: 'all', window: 'weekend', cap: 1.1, floor: 0.9, collarCap: 1.2 },
};

/* ---------- storage (per-tab convenience for read alerts; the page works without it) ---------- */
function readJson(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: keep going in memory */ }
}

// Fire-and-forget audit event for demo-only actions; the API records its own. Summaries carry no personal data.
function audit(kind, ref, summary) {
  try {
    fetch('/api/audit/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, ref, summary }) }).catch(() => {});
  } catch { /* audit is best effort */ }
}

// Bar widths and heights arrive as data attributes and become custom properties (the CSP allows no style attributes).
function applyBars(root) {
  root.querySelectorAll('[data-w]').forEach(el => el.style.setProperty('--w', `${el.dataset.w}%`));
  root.querySelectorAll('[data-h]').forEach(el => el.style.setProperty('--h', el.dataset.h));
}

/* ---------- positions with listings and local demo scenarios applied ---------- */
const SHORTFALL = { id: 'scenario-shortfall', severity: 'warn', kind: 'Delivery', go: 'positions/H3', text: 'Provider delivered 60 of 64 H100 for H3 · 4 GPUs credited at $5.40 × remaining hours' };
const positions = () => (state.data?.positions || []).map(p => {
  const listed = p.orderRef ? plat.withListing(p, state.details.get(p.orderRef))
    : state.listed.has(p.id) ? { ...p, status: 'listed', ...state.listed.get(p.id) } : p;
  return state.shortfall && p.id === 'H3' ? { ...listed, warning: 'Delivery shortfall · credited' } : listed;
});
const allAlerts = () => (state.shortfall ? [SHORTFALL, ...state.data.alerts] : state.data.alerts);
const byId = id => positions().find(p => p.id === id);

/* ---------- overview ---------- */
function accountDigits() {
  const s = state.session;
  const account = state.data?.account;
  if (account?.accountNumber && s.company === account.organisation) return account.accountNumber;
  return String([...s.email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9000, 7) + 1000);
}

function renderAccount() {
  document.querySelectorAll('[data-bind=account]').forEach(el => { el.textContent = `•••• ${accountDigits()}`; });
}

function renderPortfolioChart() {
  const r = v.historyRange(state.data.history, state.range);
  $('d-chart').innerHTML = v.portfolioChart(r.points);
  attachHover($('d-chart'), r.points, p => [v.shortDate(p.date), `Market value ${v.usd(p.marketValue)}`, `Committed cost ${v.usd(p.committedCost)}`, `Dodona Value ${v.signedUsd(p.value)}`]);
  $('d-hero-chips').innerHTML = v.rangeChip(RANGE_LABEL[state.range], r.change);
  $('d-hero-since').textContent = v.rangeCaption(r);
  $('d-range-since').textContent = r.partial ? `Since ${v.shortDate(r.since)}` : '';
  $('d-chart-span').textContent = `${r.points.length} day${r.points.length === 1 ? '' : 's'}`;
  document.querySelectorAll('#d-ranges [data-range]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === state.range)));
}

function renderOverview() {
  const { kpis } = state.data;
  $('d-hero-value').textContent = v.signedUsd(kpis.netValue);
  $('d-hero-value').className = `d-big ${v.tone(kpis.netValue)}`;
  $('d-hero-cents').textContent = `${v.cents(kpis.centsOnDollar)} on fixed contracts`;
  $('d-hero-say').textContent = `At the index on ${v.shortDate(state.data.asOf)} your remaining hours are worth ${v.usd(Math.abs(kpis.netValue))} ${kpis.netValue >= 0 ? 'more' : 'less'} than you committed to pay. Fixed prices and offtakes mark at ${v.cents(kpis.centsOnDollar)} per dollar still owed; caps and floors only pay if the average index over their window ends past the strike.`;
  renderPortfolioChart();
  $('d-kpis').innerHTML = v.kpiRows(kpis);
  $('d-prices').innerHTML = v.pricesLine(state.data.prices, state.data.methodVersion);
  renderPanels();
}

function renderPanels() {
  const list = positions();
  const asOf = state.data.asOf;
  $('d-summary').innerHTML = v.positionSummary({ positions: list, asOf });
  $('d-coverage').innerHTML = v.coveragePanel(list, asOf);
  $('d-savings').innerHTML = v.savingsPanel(list, asOf, state.data.kpis.netValue);
  $('d-upcoming').innerHTML = v.upcomingPanel(list, asOf);
  applyBars($('d-coverage'));
}

function renderLedger() {
  $('d-rows').innerHTML = positions().map(p => v.ledgerRow(p, { selected: p.id === state.selected, today: state.data.asOf })).join('');
}

function markSelected() {
  document.querySelectorAll('#d-rows [data-row]').forEach(row => row.setAttribute('aria-selected', String(row.dataset.row === state.selected)));
}

/* ---------- position detail (split panel) ---------- */
const termRow = (term, value, note = '', kind = '') => `<div><dt>${esc(term)}${kind ? ' ' + v.tag(kind) : ''}${note ? `<span>${esc(note)}</span>` : ''}</dt><dd>${esc(value)}</dd></div>`;
const calcRows = rows => `<dl>${rows.map(([t, d], i) => `<div${i === rows.length - 1 ? ' class="is-total"' : ''}><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>`;
const TYPE_TEXT = { call: 'Price cap (a call), delivered', put: 'Price floor (a put), pays the difference below the floor', offtake: 'Offtake, take-or-pay', lock: 'Fixed price, delivered' };

function optionRows(p, val) {
  const put = p.kind === 'put';
  const wa = val.windowAverage;
  return [
    termRow('Settles on', `Average ${p.gpu} index over the window, ${put ? 'floored' : 'capped'} at ${v.perHour(p.pricePerGpuHour)}`, `The window average is the mean of the daily ${p.gpu} index over ${v.windowLabel(p.start, p.end)}`),
    termRow('Expected window average', `${v.perHour(val.forwardAvg)}/GPU-h`, wa && wa.realised != null ? 'Realised days blended with the forward for the rest' : 'Forward at mid-window, after region and hardware basis'),
    ...(wa && wa.realised != null ? [termRow('Window average so far', `${v.perHour(wa.realised * val.basis)}/GPU-h`, `Over ${Math.round(wa.elapsedDays)} of ${wa.totalDays} days`)] : []),
    termRow('Premium paid', `${v.perHour(p.premiumPerGpuHour)}/GPU-h · ${v.dollars(val.premiumPaid ?? 0)}`),
    termRow('Bought', p.boughtOn ? v.shortDate(p.boughtOn) : '—', p.indexAtPurchase ? `Index then ${v.perHour(p.indexAtPurchase)}` : ''),
    termRow('Break-even', `Pays off if the window average ends ${put ? 'below' : 'above'} ${v.perHour(v.payoffBreakEven(p.kind, p.pricePerGpuHour, p.premiumPerGpuHour))}/GPU-h`),
    ...(put ? [] : [termRow('Cluster utilisation', v.percent(p.utilisation ?? 1), 'Sets the resale bid')]),
    termRow(p.orderRef ? 'Choose by' : 'Exercise by', v.utcStamp(v.deadlineOf(p))),
  ];
}

function orderRows(p) {
  if (!p.orderRef) return [];
  const choice = p.deliveryChoice === 'resell' ? 'Resell the hours' : 'Use the hours';
  return [termRow('Order', `${p.orderRef} · ${String(p.orderStatus || '').replace('_', ' ')}`, 'Open it from the Orders page for the full timeline'), termRow('Delivery choice', choice)];
}

function termSheet(p) {
  const val = p.valuation;
  const option = v.isOption(p);
  const rows = [
    termRow('Type', TYPE_TEXT[p.kind] || p.kind),
    termRow('Compute', `${p.count.toLocaleString('en-US')} ${p.gpu} · ${p.config}`, p.region),
    termRow('Window', v.windowLabel(p.start, p.end), `${v.utcStamp(p.start)} to ${v.utcStamp(p.end)}`),
    termRow('GPU-hours left', v.hoursText(val.remainingHours)),
    termRow(option ? (p.kind === 'put' ? 'Floor price' : 'Cap price') : 'Contract price', `${v.perHour(p.pricePerGpuHour)}/GPU-h`),
    termRow('Index today', `${v.perHour(val.spot)}/GPU-h`, `Ornn ${p.gpu} · basis ×${(val.basis ?? 1).toFixed(2)}`, state.data.prices.live ? 'live' : ''),
    ...orderRows(p),
    ...(option ? optionRows(p, val) : [termRow('Still to pay', v.dollars(val.remainingCost)), termRow('Forward average', `${v.perHour(val.forwardAvg)}/GPU-h`, 'After region and hardware basis')]),
    termRow('Provider', p.provider?.label || p.neocloud?.name || 'Partner neocloud', !p.provider || p.provider.creditTier === 'Delivery-backed' ? 'Delivery-backed' : `Tier ${p.provider.creditTier} · bonds ${p.provider.bondPriceCents}¢`),
    termRow('Volatility', v.percent(val.vol ?? 0, 1), val.volSampling === 'weekly' ? 'Annualised from weekly changes' : 'Annualised from daily changes'),
    termRow('Method', val.methodVersion || state.data.methodVersion, `As of ${v.shortDate(state.data.asOf)}`),
  ];
  return `<div class="example-terms d-terms" data-tour="terms"><dl>${rows.join('')}</dl></div>`;
}

function howComputed(p) {
  const option = v.isOption(p);
  const put = p.kind === 'put';
  const timeValue = p.valuation.timeValue == null
    ? 'Time value (the chance it moves further before the window) is added once the pricing engine is connected; it is not included here.'
    : `The pricing engine adds ${v.usd(p.valuation.timeValue)} of time value.`;
  const step3 = option
    ? `A ${put ? 'price floor' : 'price cap'} settles on the average daily index over its window, never on one day's print. Its value is how far the expected window average sits ${put ? 'below the floor' : 'above the cap'}, times the hours, discounted: max(${put ? `${v.perHour(p.pricePerGpuHour)} − Ā × basis` : `Ā × basis − ${v.perHour(p.pricePerGpuHour)}`}, 0) × hours × discount. Before the window Ā is the forward at mid-window; during it, the average printed so far blended by days with the forward for the rest. ${timeValue} The premium you paid is already spent and is not counted.`
    : 'Multiply the hours by the gap between that forward and your contract price, month by month.';
  return `<details class="d-how"><summary>How this value is computed</summary><ol>
    <li>Take the ${esc(v.hoursText(p.valuation.remainingHours))} you still have.</li>
    <li>Estimate the market price for those hours from the Ornn index today (${esc(v.perHour(p.valuation.spot))}), grown at half its recent trend to the window, times the region and hardware basis.</li>
    <li>${esc(step3)}</li>
    <li>Discount at 5% a year, and for the chance the provider does not deliver (zero for delivery-backed contracts).</li>
    ${option ? '' : '<li>Cents on the dollar = 100 + value ÷ remaining contract cost × 100. Above 100 means you pay less than the market.</li>'}
  </ol><p class="fine">Method ${esc(p.valuation.methodVersion || state.data.methodVersion)}. An estimate, not an appraisal, offer or advice.</p></details>`;
}

function exerciseRows(p, deliver) {
  const hours = v.hoursText(p.valuation.remainingHours);
  if (p.kind !== 'call') {
    return deliver
      ? [['GPU-hours', hours], [p.kind === 'put' ? 'Floor' : 'Fixed price', `${v.perHour(p.pricePerGpuHour)}/GPU-h`], ['Settles on', 'The average daily index over the window']]
      : [['GPU-hours', hours], ['Listed on', 'The board, open to buyer bids'], ['Who pays the compute bill', 'The resale buyer']];
  }
  const ex = v.exerciseQuote(p, p.valuation.spot);
  const K = p.pricePerGpuHour;
  return deliver
    ? [['GPU-hours', hours], ['Expected window average', `${v.perHour(ex.average)}/GPU-h · cap ${v.perHour(K)}`],
      ['Billed at the lower of the two', `${v.perHour(Math.min(ex.average, K))} × ${hours} = ${v.dollars(ex.pay)}`],
      ['Saving vs the window average', ex.saving > 0 ? `${v.dollars(ex.saving)} · ${v.perHour(ex.average - K)}/GPU-h` : 'None · the window average is expected below the cap, not needed yet']]
    : [['Best bid today', `${v.perHour(ex.regional)} × ${v.percent(p.utilisation ?? 1)} utilisation − ${v.perHour(v.RESALE_SPREAD)} = ${v.perHour(ex.bid)}`],
      ['Bid above the cap', `max(${v.perHour(ex.bid)} − ${v.perHour(K)}, 0) = ${v.perHour(Math.max(ex.bid - K, 0))}/GPU-h`],
      ['Resale proceeds', `× ${hours} = ${v.dollars(ex.gross)}`], ['Dodona fee 1%', `−${v.dollars(ex.fee)}`],
      ['Net to you', ex.net > 0 ? v.dollars(ex.net) : '$0 · the bid is below the cap today']];
}

function exercisePanel(p) {
  const deliver = state.exercise === 'deliver';
  const copy = deliver
    ? `You take the hours and the neocloud provisions the cluster from ${v.utcStamp(p.start)}. The bill is set on the window's average index when the window ends.`
    : 'Dodona lists the block on the board and buyers bid on it. The resale buyer takes the compute bill.';
  const verb = p.orderRef ? (deliver ? 'Use the hours' : 'Resell the hours') : `Confirm ${deliver ? 'delivery' : 'resale'}`;
  return `<div class="d-calc" role="region" aria-label="Review the choice"><p class="eyebrow">Review · ${deliver ? 'use the hours' : 'resell the hours'} ${v.tag('model')}</p><p>${esc(copy)}</p>${calcRows(exerciseRows(p, deliver))}
    <div class="c-acts"><button type="button" class="btn btn-sm btn-primary" data-act="ex-confirm" id="d-ex-confirm">${v.icon('circle-check')}<span>${esc(verb)}</span></button><button type="button" class="btn btn-sm" data-act="ex-cancel">${v.icon('x')}<span>Cancel</span></button></div></div>`;
}

function listForm(p) {
  const offtake = p.kind === 'offtake';
  const val = p.valuation;
  const fair = offtake ? Math.round(val.centsOnDollar ?? 100) : Math.max(p.pricePerGpuHour, val.forwardAvg ?? 0, 0.01).toFixed(2);
  return `<form class="d-form" id="d-list-form" novalidate><div class="field"><label for="d-ask">${offtake ? 'Asking, cents on the dollar' : 'Asking, $ per GPU-hour'}</label>
    <input id="d-ask" name="ask" type="number" inputmode="decimal" required ${offtake ? 'min="50" max="150" step="0.5"' : 'min="0.01" max="100" step="0.01"'} value="${esc(fair)}"></div>
    <button type="submit" class="btn btn-sm btn-primary">${v.icon('tag')}<span>List at this price</span></button>
    <p class="fine">${p.orderRef ? 'Bids usually arrive within a day of listing.' : `Today's Dodona Value is ${esc(offtake ? v.cents(val.centsOnDollar) : v.perHour(Number(fair)) + '/GPU-h')}.`} Listings are anonymous until both sides agree.</p></form>`;
}

function counterForm(p) {
  if (p.bestBid) {
    const value = (Number(p.bestBid.pricePerHour) + 0.1).toFixed(2);
    return `<form class="d-form" id="d-offer-form" novalidate><div class="field"><label for="d-counter">Counter, $ per GPU-hour</label>
      <input id="d-counter" type="number" inputmode="decimal" required min="0.01" max="100" step="0.01" value="${esc(value)}"></div>
      <button type="submit" class="btn btn-sm btn-primary">${v.icon('message-square')}<span>Send counter</span></button>
      <p class="fine">Best bid ${esc(v.perHour(p.bestBid.pricePerHour))}/GPU-h from ${esc(p.bestBid.bidder)} against your ask of ${esc(v.perHour(p.askingPerGpuHour))}. The buyer raises by $0.05 per counter, up to the forward.</p></form>`;
  }
  return `<form class="d-form" id="d-offer-form" novalidate><div class="field"><label for="d-counter">Counter-offer, cents on the dollar</label>
    <input id="d-counter" type="number" inputmode="decimal" required min="50" max="150" step="0.5" value="${esc(Math.round((p.bestOfferCents + p.askingCents) / 2))}"></div>
    <button type="submit" class="btn btn-sm btn-primary">${v.icon('message-square')}<span>Send counter-offer</span></button>
    <p class="fine">The best offer today is ${esc(p.bestOfferCents)}¢ against your ask of ${esc(p.askingCents)}¢. Both sides stay anonymous until agreed.</p></form>`;
}

// Same button set as the row: one primary, the rest outlined, a third and later under "More".
function detailActions(p) {
  if (p.phase === 'used') return p.orderRef ? v.actionBar([{ act: 'order', label: 'Open the order', icon: 'receipt', primary: true }]) : '';
  const listed = p.status === 'listed';
  const choose = p.orderRef ? plat.choiceOpen(p) : p.kind === 'call';
  const actions = [];
  if (choose && !listed) {
    actions.push({ act: 'ex', mode: 'deliver', label: p.orderRef ? 'Use the hours' : 'Exercise · deliver', icon: 'zap', primary: true, pressed: state.exercise === 'deliver' },
      { act: 'ex', mode: 'resell', label: p.orderRef ? 'Resell the hours' : 'Exercise · resell the hours', icon: 'tag', pressed: state.exercise === 'resell' });
  }
  if (listed && p.bestBid) actions.push({ act: 'accept', label: `Accept ${v.perHour(p.bestBid.pricePerHour)} bid`, icon: 'check', primary: true }, { act: 'counter', label: 'Counter the bid', icon: 'message-square', expanded: state.countering });
  else if (listed && p.bestOfferCents) actions.push({ act: 'counter', label: `Counter the ${p.bestOfferCents}¢ offer`, icon: 'message-square', primary: true, expanded: state.countering });
  if (!listed && (p.orderRef ? choose : true)) actions.push({ act: 'list', label: 'List for sale', icon: 'tag', primary: !actions.length, expanded: state.listing });
  if (p.orderRef) actions.push({ act: 'order', label: 'Open the order', icon: 'receipt', primary: !actions.length });
  return v.actionBar(actions, { menuId: 'd-menu-detail', label: `More actions for ${p.id}` });
}

function detailHeadline(p, range) {
  const val = p.valuation;
  if (p.phase === 'used') {
    const saving = p.settlement?.netResult ?? p.used?.saving ?? 0;
    return `<p class="d-big ${v.tone(saving)}">${esc(v.signedUsd(saving))}</p><p class="d-d-row d-muted">${p.settlement ? 'Net result at settlement, after the fee.' : 'Saved against the index over the window.'} Nothing left to value.</p>`;
  }
  const option = v.isOption(p);
  const gap = option ? v.optionGap(p) : 0;
  const side = p.kind === 'put' ? 'below the floor' : 'above the cap';
  const money = gap > 0 ? `window average expected ${v.perHour(gap)} ${side}` : `window average expected ${v.perHour(-gap)} on the other side · not needed yet`;
  const line = option
    ? `<strong>Pays off if the window average ends ${p.kind === 'put' ? 'below' : 'above'} ${esc(v.perHour(v.payoffBreakEven(p.kind, p.pricePerGpuHour, p.premiumPerGpuHour)))}/GPU-h</strong><span class="${gap > 0 ? 'is-gain' : 'd-oom'}">${esc(money)}</span>`
    : `<strong class="${v.tone((val.centsOnDollar ?? 100) - 100)}">${esc(v.cents(val.centsOnDollar))} on the dollar</strong>`;
  return `<p class="d-big ${option ? (gap > 0 ? 'is-gain' : 'd-oom') : v.tone(val.value)}">${esc(v.signedUsd(val.value))}</p>
    <p class="d-d-row">${line}<span class="d-muted">range ${esc(v.signedUsd(val.low))} to ${esc(v.signedUsd(val.high))}</span></p>
    <div class="d-chips">${v.rangeChip(RANGE_LABEL[state.range], range.change)}</div>`;
}

function chartBlock(range) {
  return `<div><div class="p-chart-head"><p class="eyebrow">Dodona Value ${v.tag('model')}</p>
      <div class="p-range-row"><div class="p-ranges" role="group" aria-label="Position chart range">${v.rangeButtons(state.range, 'position')}</div><span class="p-since">${esc(v.rangeCaption(range))}</span></div></div>
    <div class="d-chart-wrap" id="d-detail-chart">${v.positionChart({ ...byId(state.selected), history: range.points })}</div></div>`;
}

function renderDetail() {
  const p = byId(state.selected);
  const box = $('d-detail');
  if (!p) { box.innerHTML = '<p class="d-empty">0 selected. Select a position to see its term sheet, value and actions.</p>'; return; }
  const live = p.phase !== 'used';
  const range = v.historyRange(p.history || [], state.range);
  const status = v.statusText(p, state.data.asOf);
  const toggle = `<button type="button" class="btn btn-sm btn-icon" data-act="split-toggle" aria-expanded="${state.splitOpen}" aria-controls="d-split-b" aria-label="${state.splitOpen ? 'Collapse' : 'Expand'} the detail panel">${v.icon(state.splitOpen ? 'chevron-down' : 'chevron-up')}</button>`;
  box.classList.toggle('is-collapsed', !state.splitOpen);
  box.innerHTML = `<div class="c-split-h" data-tour="detail-head"><div><p class="eyebrow">1 selected · ${esc(p.id)} · ${esc(v.kindLabel(p.kind))}${p.orderRef ? ` · order ${esc(p.orderRef)}` : ''} ${v.tag(p.orderRef ? 'demo' : 'sample')}</p>
      <h2 id="d-split-h" tabindex="-1">${esc(p.label)}</h2></div>
      <div class="c-acts">${v.statusPill(status.cls, status.text)}${detailActions(p)}${toggle}</div></div>
    <div class="c-split-b" id="d-split-b"${state.splitOpen ? '' : ' hidden'}>
      <div class="c-split-col">
        <div class="d-d-head"><p class="d-d-sub">${esc(p.region)} · ${esc(p.provider?.label || p.neocloud?.name || 'Partner neocloud')}</p>${detailHeadline(p, range)}</div>
        ${live && state.exercise ? exercisePanel(p) : ''}
        ${live && state.listing && p.status !== 'listed' ? listForm(p) : ''}
        ${live && state.countering && (p.bestBid || p.bestOfferCents) ? counterForm(p) : ''}
        ${live ? chartBlock(range) : ''}
        ${live ? whatIfBlock(p, state.whatIfAvg) : ''}
      </div>
      <div class="c-split-col"><h3 class="d-h3">Term sheet</h3>${termSheet(p)}${howComputed(p)}</div>
    </div>`;
  if (live && state.splitOpen) attachHover($('d-detail-chart'), range.points, point => [v.shortDate(point.date), `Dodona Value ${v.signedUsd(point.value)}`]);
}

function revealDetail() {
  if (window.matchMedia(PHONE).matches) $('d-detail').scrollIntoView({ block: 'start' });
}

function select(id, { scroll = false } = {}) {
  if (!byId(id)) return;
  if (state.selected !== id) Object.assign(state, { exercise: null, listing: false, countering: false, whatIfAvg: null });
  state.selected = id;
  markSelected();
  renderDetail();
  renderHead();
  if (scroll) revealDetail();
}

/* ---------- alerts ---------- */
function alertItem(alert, full) {
  const read = state.read.has(alert.id);
  const [iconName, toneName] = v.alertLook(alert);
  return `<li class="${read ? 'is-read' : ''}"><span class="d-sev tone-${toneName}">${v.icon(iconName)}</span>
    <div><div class="d-alert-text">${esc(alert.text)}</div><div class="d-meta">${esc(alert.kind)}${read ? ' · read' : ''}</div></div>
    <div class="d-alert-acts">${full ? `<a class="btn btn-sm" href="#${esc(alert.go)}">${v.icon('arrow-right')}<span>View</span></a>` : ''}${read ? '' : `<button type="button" class="btn btn-sm" data-act="read" data-id="${esc(alert.id)}">${v.icon('check')}<span>Mark read</span></button>`}</div></li>`;
}

function renderAlerts() {
  const alerts = allAlerts();
  $('d-alerts-mini').innerHTML = alerts.slice(0, 4).map(a => alertItem(a, false)).join('') || '<li class="d-muted">No alerts.</li>';
  $('d-alerts-full').innerHTML = alerts.map(a => alertItem(a, true)).join('') || '<li class="d-muted">No alerts.</li>';
  const unread = alerts.filter(a => !state.read.has(a.id)).length;
  $('d-badge').textContent = unread;
  $('d-badge').hidden = !unread;
  $('d-badge').setAttribute('aria-label', `${unread} unread`);
  $('d-alerts-mini-count').textContent = unread ? `${unread} unread` : '';
  $('d-alerts-count').textContent = `${unread} unread of ${alerts.length}`;
}

/* ---------- provider ---------- */
// Next Saturday (weekend) or Monday (week) at 00:00 UTC that is at least 48 hours away, to satisfy the quote rules.
function nextWindow(kind) {
  const earliest = Date.now() + 2 * DAY_MS + 3600000;
  const target = kind === 'weekend' ? 6 : 1;
  const day = new Date(earliest);
  let start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  while (start < earliest || new Date(start).getUTCDay() !== target) start += DAY_MS;
  const hours = kind === 'weekend' ? 48 : 168;
  return { start: new Date(start).toISOString(), end: new Date(start + hours * 3600000).toISOString(), hours };
}

async function fetchQuote(params) {
  if (state.stale) return { premium: v.PLACEHOLDER_PREMIUM, placeholder: 'Quotes paused · index is 3 days old' };
  try {
    const response = await fetch(`/api/quote?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
    if (response.ok) {
      const quote = await response.json();
      if (Number.isFinite(quote.premiumPerGpuHour)) return { premium: quote.premiumPerGpuHour, quote, placeholder: null, computeMs: Number.isFinite(quote.computeMs) ? quote.computeMs : null };
    }
    return { premium: v.PLACEHOLDER_PREMIUM, placeholder: response.status === 501 ? 'Pricing engine not connected' : 'Quote unavailable' };
  } catch {
    return { premium: v.PLACEHOLDER_PREMIUM, placeholder: 'Quote unavailable' };
  }
}

const seg = (key, options) => `<div class="d-seg" role="group">${options.map(([value, label]) => `<button type="button" data-act="pick" data-key="${key}" data-value="${value}" aria-pressed="${String(state.provider[key]) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
const placeholderFlag = quote => (quote.placeholder ? `<span class="d-flag">${esc(quote.placeholder)} · placeholder premium ${esc(v.perHour(v.PLACEHOLDER_PREMIUM))}/GPU-h</span>` : '');
const chip = (index, factor, prefix) => `${prefix} · ${v.perHour(v.roundTo(index * factor, 0.05))}`;

function scenarioTable(rows) {
  return `<div class="d-scroll"><table class="d-table"><caption class="visually-hidden">Renting at market only against selling the cap</caption>
    <thead><tr><th scope="col">Scenario</th><th scope="col" class="r">Index</th><th scope="col" class="r">Booked</th><th scope="col" class="r">Market only</th><th scope="col" class="r">With the cap</th><th scope="col">Better</th></tr></thead>
    <tbody>${rows.map(r => `<tr><th scope="row">${esc(r.name)}<span class="d-sub">${r.used ? 'Cap used · block 100% rented' : 'Cap unused'}</span></th><td class="r d-num">${esc(v.perHour(r.price))}</td><td class="r d-num">${v.percent(r.fill)}</td><td class="r d-num">${esc(v.dollars(r.market))}</td><td class="r d-num">${esc(v.dollars(r.withCap))}</td><td><span class="d-win${r.winner === 'cap' ? ' is-cap' : ''}">${r.winner === 'cap' ? 'Sell the cap' : 'Market only'}</span></td></tr>`).join('')}</tbody></table></div>`;
}

async function renderProvider() {
  const pv = state.data.provider;
  if (!pv) { $('d-provider').innerHTML = '<p class="d-empty">The provider view needs the sample provider data.</p>'; return; }
  const ps = state.provider;
  const index = pv.index;
  const gpus = ps.block === 'all' ? pv.idleWeekend.gpus : Number(ps.block);
  const win = nextWindow(ps.window);
  const gpuHours = gpus * win.hours;
  const strike = v.roundTo(index * ps.cap, 0.05);
  const floor = v.roundTo(index * ps.floor, 0.05);
  const collarCap = v.roundTo(index * ps.collarCap, 0.05);
  const base = { gpu: pv.gpu, count: String(Math.min(gpus, 256)), start: win.start, end: win.end, region: pv.region, config: pv.config };
  const monthStart = Date.parse(nextWindow('week').start);
  const collarBase = { ...base, count: '256', start: new Date(monthStart).toISOString(), end: new Date(monthStart + 30 * DAY_MS).toISOString() };
  const [capQuote, putQuote, callQuote] = await Promise.all([
    fetchQuote({ ...base, type: 'call', strike: strike.toFixed(2) }),
    fetchQuote({ ...collarBase, type: 'put', strike: floor.toFixed(2) }),
    fetchQuote({ ...collarBase, type: 'call', strike: collarCap.toFixed(2) }),
  ]);
  if (state.screen !== 'provider') return;
  const rows = v.providerScenarios({ index, strike, premium: capQuote.premium, gpuHours });
  const c = v.collar({ floor, putPremium: putQuote.premium, callPremium: callQuote.premium, gpuHours: pv.units * 30 * 24, units: pv.units });
  const net = `${c.netPerHour < 0 ? '−' : ''}${v.perHour(Math.abs(c.netPerHour))}${c.netPerHour < 0 ? ' (a credit)' : ''}`;
  $('d-provider').innerHTML = `
    <section class="c-ctr" aria-labelledby="d-pv-1"><div class="c-ctr-h"><div><h2 id="d-pv-1">1 · Pick the block and the cap</h2><p>${esc(pv.name)} ${v.tag('sample')}</p></div></div><div class="d-step">
      <div class="d-pick"><span>Block</span>${seg('block', [['all', `All idle weekend GPUs (${pv.idleWeekend.gpus})`], ['64', '64 GPUs'], ['128', '128 GPUs']])}</div>
      <div class="d-pick"><span>Window</span>${seg('window', [['weekend', 'Next weekend · 48 h'], ['week', 'Next week · 168 h']])}</div>
      <div class="d-pick"><span>Cap price</span>${seg('cap', [[1, chip(index, 1, "Today's index")], [1.1, chip(index, 1.1, '+10%')], [1.2, chip(index, 1.2, '+20%')]])}</div>
      <p class="fine">${pv.units.toLocaleString('en-US')} ${esc(pv.gpu)} ${esc(pv.config)} in ${esc(pv.region)} · ${v.percent(pv.utilisation)} utilised · Ornn ${esc(pv.gpu)} index ${esc(v.perHour(index))}/GPU-h. Window ${esc(v.utcStamp(win.start))} to ${esc(v.utcStamp(win.end))}.</p>
      ${scenarioTable(rows)}
      <p class="fine">With the cap, income is the premium plus either the market rental (cap unused) or the whole block at the cap price (cap used).</p>
    </div></section>
    <div class="c-stack">
      <div class="d-result"><p class="eyebrow">Premium income, paid now ${v.tag('model')}</p><strong>${esc(v.dollars(capQuote.premium * gpuHours))}</strong>
        <p>${esc(v.perHour(capQuote.premium))}/GPU-h on ${esc(v.hoursText(gpuHours))} · cap ${esc(v.perHour(strike))}/GPU-h</p>${placeholderFlag(capQuote)}${capQuote.computeMs != null ? `<p class="d-quote-ms">priced in ${esc(capQuote.computeMs < 10 ? capQuote.computeMs.toFixed(1) : Math.round(capQuote.computeMs))} ms</p>` : ''}</div>
      <section class="c-ctr" aria-labelledby="d-pv-2"><div class="c-ctr-h"><div><h2 id="d-pv-2">2 · Buy a floor</h2><p>Pay for it partly by selling a cap.</p></div></div><div class="d-step">
        <div class="d-pick"><span>Floor price</span>${seg('floor', [[1, chip(index, 1, 'Today')], [0.9, chip(index, 0.9, '−10%')], [0.8, chip(index, 0.8, '−20%')]])}</div>
        <div class="d-pick"><span>Cap price sold to pay for it</span>${seg('collarCap', [[1.1, chip(index, 1.1, '+10%')], [1.2, chip(index, 1.2, '+20%')], [1.3, chip(index, 1.3, '+30%')]])}</div>
        <div class="d-calc">${calcRows([['Floor premium (you pay)', `${v.perHour(putQuote.premium)}/GPU-h`], ['Cap premium (you receive)', `${v.perHour(callQuote.premium)}/GPU-h`],
          ['Net cost per GPU-hour', net], ['Net for 30 days, whole fleet', v.dollars(c.netTotal)]])}
          ${placeholderFlag(putQuote.placeholder ? putQuote : callQuote)}</div>
      </div></section>
      <div class="d-lender-card"><p class="eyebrow">For your lender</p><p>Revenue protected per month</p><strong>${esc(v.dollars(c.protectedPerMonth))}</strong>
        <p class="fine">Floor ${esc(v.perHour(floor))} × ${pv.units.toLocaleString('en-US')} GPUs × 720 h at full utilisation. A price floor protects the rate on hours sold, not the volume.</p></div>
    </div>`;
}

/* ---------- lender ---------- */
const fleetRows = () => (state.data.fleets || []).map(f => ({ f, s: v.fleetUnderShock(f, state.shock) }));

function ltvBar(ltv, status) {
  const width = 110;
  return `<svg viewBox="0 0 ${width} 12" role="img" aria-label="Loan-to-value ${v.percent(ltv)}"><rect class="d-ltv-track" width="${width}" height="12" rx="2"/><rect class="d-ltv-fill is-${status}" width="${(Math.min(ltv, 1) * width).toFixed(1)}" height="12" rx="2"/><line class="d-ltv-tick" x1="${width * 0.6}" x2="${width * 0.6}" y1="0" y2="12"/><line class="d-ltv-tick" x1="${width * 0.75}" x2="${width * 0.75}" y1="0" y2="12"/></svg>`;
}

function renderLender() {
  $('d-shock-out').textContent = `${state.shock ? '−' : ''}${Math.round(state.shock * 100)}%`;
  $('d-fleets').innerHTML = fleetRows().map(({ f, s }) => `<tr><th scope="row">${esc(f.label)}</th><td>${f.units.toLocaleString('en-US')} ${esc(f.gpu)}</td><td>${esc(v.shortDate(f.installedOn).replace(/^\d+ /, ''))}</td>
    <td class="r d-num">${esc(v.usd(f.loanBalance))}</td><td class="r d-num">${esc(v.usd(s.value))}</td>
    <td><div class="d-ltv"><span class="d-num">${esc(v.percent(s.ltv))}</span>${ltvBar(s.ltv, s.status)}</div></td>
    <td>${v.statusPill(s.status, s.status === 'ok' ? 'OK' : s.status === 'watch' ? 'Watch' : 'Breach')}</td>
    <td class="r d-num">${s.monthsToBreach === 0 ? 'In breach' : s.monthsToBreach ? `${s.monthsToBreach} mo` : 'Not within life'}</td></tr>`).join('') || '<tr><td colspan="8" class="d-muted">No facilities on this account.</td></tr>';
}

/* ---------- CSV exports ---------- */
const saveCsv = plat.saveCsv;

function downloadCsv() {
  const lines = [['Facility', 'GPU', 'Units', 'Installed', 'Loan balance USD', 'Fleet value USD', 'Loan-to-value', 'Status', 'Months to breach', 'Rent shock', 'Index as of', 'Method']];
  for (const { f, s } of fleetRows()) {
    lines.push([f.label, f.gpu, f.units, f.installedOn, Math.round(f.loanBalance), Math.round(s.value), s.ltv.toFixed(4), s.status, s.monthsToBreach ?? '', `-${Math.round(state.shock * 100)}%`, state.data.prices.asOf, state.data.methodVersion]);
  }
  saveCsv(lines, `dodona-facilities-${state.data.asOf}.csv`, 'CSV downloaded.');
}

function positionsCsv() {
  const lines = [['Position', 'Order', 'Type', 'GPU', 'Count', 'Region', 'Window start UTC', 'Window end UTC', 'Price USD per GPU-hour', 'GPU-hours left', 'Dodona Value USD', 'Cents on the dollar', 'Status', 'Method']];
  for (const p of positions()) {
    const val = p.valuation;
    lines.push([p.id, p.orderRef || '', v.kindLabel(p.kind), p.gpu, p.count, p.region, p.start, p.end, p.pricePerGpuHour, Math.round(val.remainingHours), p.phase === 'used' ? '' : Math.round(val.value), val.centsOnDollar == null ? '' : val.centsOnDollar.toFixed(1), v.statusText(p, state.data.asOf).text, state.data.methodVersion]);
  }
  saveCsv(lines, `dodona-positions-${state.data.asOf}.csv`, 'CSV downloaded.');
}

function billingCsv() {
  const lines = [['Invoice', 'Month', 'Premiums USD', 'Of which platform fee USD', 'Booking fees USD', 'Total USD', 'Status', 'Positions']];
  for (const row of v.billingMonths(positions(), state.data.asOf)) {
    lines.push([row.id, row.month, row.premiums.toFixed(2), row.platformFee.toFixed(2), row.bookingFees.toFixed(2), row.total.toFixed(2), row.status, row.positions.join(' ')]);
  }
  saveCsv(lines, `dodona-billing-${state.data.asOf}.csv`, 'Billing CSV downloaded.');
}

const exportCsv = () => (state.screen === 'lender' ? downloadCsv() : state.screen === 'settings' ? billingCsv() : positionsCsv());

/* ---------- settings ---------- */
function renderSettings() {
  const s = state.session;
  const domain = s.email.split('@')[1] || 'example.com';
  const kv = rows => `<dl class="d-kv">${rows.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>`;
  const now = new Date(state.data.asOf.slice(0, 10) + 'T00:00:00Z');
  const nextInvoice = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const head = (id, title, desc, action = '') => `<div class="c-ctr-h"><div><h2 id="${id}">${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${action}</div>`;
  const smallBtn = (attrs, iconName, label) => `<button type="button" class="btn btn-sm" ${attrs}>${v.icon(iconName)}<span>${esc(label)}</span></button>`;
  $('d-settings').innerHTML = `
    <section class="c-ctr c-s6" aria-labelledby="d-set-org">${head('d-set-org', 'Organisation', 'Who this account belongs to.')}${kv([['Name', s.company], ['KYB status', s.kyb === 'verified' ? 'Verified' : s.kyb === 'rejected' ? 'Rejected' : 'Pending'], ['Role', ROLE_TEXT[s.role] || s.role], ['Account', `•••• ${accountDigits()}`]])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-team">${head('d-set-team', 'Team <span class="c-count">2</span>', 'People who can see and act on positions.', smallBtn('data-toast="Invite sent."', 'plus', 'Invite'))}
      <div class="d-scroll"><table class="d-table"><thead><tr><th scope="col">Member</th><th scope="col">Role</th></tr></thead><tbody>
        <tr><td>${esc(s.email)}</td><td>Admin</td></tr><tr><td>finance@${esc(domain)}</td><td>Finance</td></tr></tbody></table></div></section>
    <section class="c-ctr c-s12" aria-labelledby="d-set-bill">${head('d-set-bill', `${v.icon('receipt', 'c-h-ic')}Billing ${v.tag('demo')}`, `Next invoice ${esc(v.shortDate(nextInvoice))} · paid through the escrow agent · Dodona never holds funds.`, smallBtn('data-act="billing-csv"', 'download', 'Export CSV'))}
      <div class="c-ctr-b">${v.billingPanel(positions(), state.data.asOf)}</div></section>
    <section class="c-ctr c-s12" aria-labelledby="d-set-stmt">${head('d-set-stmt', `${v.icon('file-text', 'c-h-ic')}Statements ${v.tag('demo')}`, 'Premiums, booking fees, compute bills and payouts by month.', `<a class="btn btn-sm" href="/api/statements.csv" download>${v.icon('download')}<span>Download CSV</span></a>`)}
      <div id="d-statements"></div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-note">${head('d-set-note', 'Notifications', 'Email alerts for this account. They land in the Emails screen.')}<div class="d-toggles">
      <label class="d-toggle">Index moves over 3% on my GPUs<input type="checkbox" checked></label>
      <label class="d-toggle">Choice deadlines, 3 days before the window<input type="checkbox" checked></label>
      <label class="d-toggle">Bids on my listings<input type="checkbox" checked></label></div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-api">${head('d-set-api', 'API', 'Read positions and values from your own tools.', smallBtn('data-toast="API key created. It is shown once."', 'plus', 'Create key'))}
      ${kv([['Read key', 'dod_test_••••••••7f3a'], ['Scope', 'Positions and values, read only'], ['Endpoint', '/api/portfolio']])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-terms">${head('d-set-terms', 'How terms settle', 'The words used across this console.')}
      ${kv([['Price cap', 'Settles on the average daily index over the window, never on one day. You pay the lower of that average and the cap.'], ['Price floor', 'Pays the holder the difference when the window average ends below the floor. Usually bought by providers.'], ['Window average', 'Mean of the daily Ornn index on each day of the delivery window, after region and hardware basis.'], ['Fixed price', 'A set price per GPU-hour for the window, whatever the index does.'], ['Offtake', 'Take-or-pay hours at a fixed price over several months.']])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-demo">${head('d-set-demo', `Scenarios ${v.tag('demo')}`, 'What-if views for this page only. The date in the top bar moves the account itself.')}<div class="d-scenarios">
      <button type="button" class="btn btn-sm" data-act="scenario" data-id="stale" aria-pressed="${state.stale}">${v.icon('clock')}<span>Stale quote · index 3 days old, quotes paused</span></button>
      <button type="button" class="btn btn-sm" data-act="scenario" data-id="shortfall" aria-pressed="${state.shortfall}">${v.icon('triangle-alert')}<span>Delivery shortfall · H3 delivered 60 of 64</span></button></div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-session">${head('d-set-session', 'Session', '')}<div class="c-ctr-b"><p>Signed in as ${esc(s.email)}.</p>
      <p class="c-acts c-note">${smallBtn('data-act="sign-out"', 'log-out', 'Sign out')}</p></div></section>`;
  applyBars($('d-settings'));
  plat.renderStatements($('d-statements'));
}

/* ---------- routing and page header ---------- */
function parseHash() {
  const [screen, id] = location.hash.replace(/^#/, '').split('/');
  return { screen: SCREENS.includes(screen) ? screen : null, id: id ? decodeURIComponent(id) : null };
}

const defaultScreen = () => ({ provider: 'provider', lender: 'lender' }[state.session?.role] || 'overview');

function renderHead() {
  const [crumb, title, desc] = PAGES[state.screen];
  const trail = state.screen === 'positions' && state.selected
    ? `<a href="#positions">${esc(crumb)}</a><span aria-hidden="true">/</span><span aria-current="page">${esc(state.selected)}</span>`
    : `<span aria-current="page">${esc(crumb)}</span>`;
  document.querySelector('.c-crumbs').innerHTML = `<a href="#overview">Console</a><span aria-hidden="true">/</span>${trail}`;
  $('d-title').textContent = title;
  $('d-desc').textContent = desc;
  document.title = `${crumb} · Console — Dodona`;
}

function route() {
  if (!state.session || !state.data) return;
  closeMenus();
  $('d-rail').classList.remove('is-more');
  $('d-nav-more').setAttribute('aria-expanded', 'false');
  const { screen, id } = parseHash();
  state.screen = screen || defaultScreen();
  $('main').dataset.screen = state.screen;
  document.querySelectorAll('[data-screens]').forEach(section => { section.hidden = !section.dataset.screens.split(' ').includes(state.screen); });
  document.querySelectorAll('.d-rail [data-nav]').forEach(link => {
    if (link.dataset.nav === state.screen) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  renderHead();
  if (state.screen === 'provider') renderProvider();
  if (state.screen === 'lender') renderLender();
  if (state.screen === 'settings') renderSettings();
  if (state.screen === 'emails') plat.renderEmails($('d-mails'), $('d-mail-count'));
  if (state.screen === 'positions' && id && byId(id)) { state.splitOpen = true; select(id, { scroll: true }); }
  else if (screen) window.scrollTo(0, 0);
}

/* ---------- menus ---------- */
function closeMenus(except) {
  document.querySelectorAll('.c-menu:not([hidden])').forEach(menu => {
    if (menu === except) return;
    menu.hidden = true;
    document.querySelector(`[aria-controls="${menu.id}"]`)?.setAttribute('aria-expanded', 'false');
  });
}

function toggleMenu(button) {
  const menu = $(button.getAttribute('aria-controls'));
  if (!menu) return;
  closeMenus(menu);
  if (!menu.hidden) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); return; }
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  const box = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = box.bottom + 4 + height <= window.innerHeight;
  menu.style.setProperty('--menu-left', `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`);
  menu.style.setProperty('--menu-top', `${below ? box.bottom + 4 : Math.max(8, box.top - height - 4)}px`);
  menu.querySelector('[role=menuitem]')?.focus({ preventScroll: true });
}

/* ---------- data refresh and API actions ---------- */
async function refresh() {
  state.data = await plat.loadPortfolio();
  state.details = await plat.orderDetails(state.data.positions);
  if (!byId(state.selected)) state.selected = firstSelection();
  renderAccount();
  renderOverview();
  renderLedger();
  renderDetail();
  renderAlerts();
  route();
}

// Runs one API action, then reloads the portfolio so every panel shows the new state.
async function apiAction(run, message, after = {}) {
  if (state.busy) return;
  state.busy = true;
  try {
    await run();
    Object.assign(state, { exercise: null, listing: false, countering: false }, after);
    toast(message);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally { state.busy = false; }
}

function confirmExercise(p) {
  const mode = state.exercise;
  if (p.orderRef) {
    apiAction(() => plat.chooseDelivery(p.orderRef, mode), mode === 'deliver' ? `You will use the hours on ${p.id}. The neocloud provisions the cluster for the window.` : `You will resell the hours on ${p.id}. Set an asking price to list them.`, mode === 'resell' ? { listing: true } : {});
    return;
  }
  const ex = v.exerciseQuote(p, p.valuation.spot);
  toast(mode === 'deliver' ? `Delivery confirmed for ${p.id}. You pay ${v.dollars(ex.pay)}.` : `${p.id} listed for resale at ${v.perHour(ex.bid)}/GPU-h, net about ${v.dollars(ex.net)}.`);
  audit('exercise_confirmed', p.id, `Exercise · ${mode} · ${p.id} · ${p.count} ${p.gpu} · ${v.perHour(p.pricePerGpuHour)}`);
  state.exercise = null;
  renderDetail();
}

function runScenario(id) {
  if (id === 'stale') {
    state.stale = !state.stale;
    $('d-stale').hidden = !state.stale;
  } else {
    state.shortfall = !state.shortfall;
    renderLedger();
    renderDetail();
    renderAlerts();
  }
  renderSettings();
  toast(id === 'stale' ? (state.stale ? 'Stale index scenario on. Quotes pause until the index updates.' : 'Stale index scenario off. Quotes resume.') : (state.shortfall ? 'Delivery shortfall scenario on for H3.' : 'Delivery shortfall cleared.'));
}

// Row and panel actions open the split panel on that position first.
function positionAction(act, button) {
  const fromRow = button.dataset.pos;
  if (fromRow) select(fromRow);
  state.splitOpen = true;
  const p = byId(state.selected);
  if (act === 'order' && p?.orderRef) { location.assign(`/orders/${encodeURIComponent(p.orderRef)}`); return; }
  if (act === 'accept' && p?.bestBid) { apiAction(() => plat.acceptBid(p.orderRef, p.bestBid.id), `Bid accepted on ${p.id} at ${v.perHour(p.bestBid.pricePerHour)}/GPU-h. The resale buyer takes the hours and the compute bill.`); return; }
  const toggle = (key, value) => (fromRow ? value : state[key] === value ? (typeof value === 'boolean' ? false : null) : value);
  Object.assign(state, {
    exercise: act === 'ex' ? toggle('exercise', button.dataset.mode) : null,
    listing: act === 'list' ? toggle('listing', true) : false,
    countering: act === 'counter' ? toggle('countering', true) : false,
  });
  renderDetail();
  if (fromRow) revealDetail();
  const focus = { ex: 'd-ex-confirm', list: 'd-ask', counter: 'd-counter', view: 'd-split-h' }[act];
  $(focus)?.focus({ preventScroll: !window.matchMedia(PHONE).matches });
}

function onClick(event) {
  if (!event.target.closest('.c-menu, [data-act="more"]')) closeMenus();
  const target = event.target.closest('button, [data-row]');
  if (!target) return;
  if (target.dataset.toast) { toast(target.dataset.toast); return; }
  if (target.dataset.row) { if (!event.target.closest('a')) select(target.dataset.row); return; }
  if (target.dataset.range) { state.range = target.dataset.range; renderPortfolioChart(); renderDetail(); return; }
  const p = byId(state.selected);
  switch (target.dataset.act) {
    case 'more': toggleMenu(target); break;
    case 'ex': case 'list': case 'counter': case 'view': case 'accept': case 'order': closeMenus(); positionAction(target.dataset.act, target); break;
    case 'split-toggle': state.splitOpen = !state.splitOpen; renderDetail(); document.querySelector('[data-act="split-toggle"]')?.focus(); break;
    case 'ex-cancel': state.exercise = null; renderDetail(); break;
    case 'ex-confirm': confirmExercise(p); break;
    case 'scenario': runScenario(target.dataset.id); break;
    case 'stale-dismiss': state.stale = false; $('d-stale').hidden = true; if (state.screen === 'settings') renderSettings(); break;
    case 'read': state.read.add(target.dataset.id); writeJson(READ_KEY, [...state.read]); renderAlerts(); break;
    case 'pick': state.provider[target.dataset.key] = ['block', 'window'].includes(target.dataset.key) ? target.dataset.value : Number(target.dataset.value); renderProvider(); break;
    case 'export': exportCsv(); break;
    case 'billing-csv': billingCsv(); break;
    case 'sign-out': signOut(); break;
    default: break;
  }
}

// Rows: Enter and Space select, arrow keys move between rows and carry the selection. Menus: Escape closes, arrows move.
function onKeydown(event) {
  if (event.key === 'Escape') {
    const open = document.querySelector('.c-menu:not([hidden])');
    if (open) { closeMenus(); document.querySelector(`[aria-controls="${open.id}"]`)?.focus(); return; }
  }
  const item = event.target.closest?.('[role=menuitem]');
  if (item && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    const items = [...item.parentElement.querySelectorAll('[role=menuitem]')];
    items[(items.indexOf(item) + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    return;
  }
  const row = event.target.closest?.('[data-row]');
  if (!row || event.target !== row) return;
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.dataset.row, { scroll: true }); }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (next?.dataset.row) { next.focus(); select(next.dataset.row); }
  }
}

function onCounter(event) {
  event.preventDefault();
  const p = byId(state.selected);
  const value = Number($('d-counter').value);
  if (p.bestBid) {
    if (!(value > 0 && value <= 100)) { toast('Enter a counter between $0.01 and $100 per GPU-hour.'); return; }
    apiAction(() => plat.counterBid(p.orderRef, p.bestBid.id, value), `Counter of ${v.perHour(value)}/GPU-h sent on ${p.id}. The buyer answers when the clock moves on.`);
    return;
  }
  if (!(value >= 50 && value <= 150)) { toast('Enter a counter-offer between 50¢ and 150¢.'); return; }
  state.countering = false;
  renderDetail();
  audit('offer_sent', p.id, `Offer · ${p.id} · ${value}c`);
  toast(`Counter-offer of ${value}¢ on ${p.id} sent.`);
}

function onSubmit(event) {
  if (event.target.id === 'd-offer-form') { onCounter(event); return; }
  if (event.target.id !== 'd-list-form') return;
  event.preventDefault();
  const p = byId(state.selected);
  const ask = Number($('d-ask').value);
  const offtake = p.kind === 'offtake';
  if (offtake ? !(ask >= 50 && ask <= 150) : !(ask > 0 && ask <= 100)) {
    toast(offtake ? 'Enter an asking price between 50¢ and 150¢.' : 'Enter an asking price between $0.01 and $100 per GPU-hour.');
    return;
  }
  if (p.orderRef) {
    apiAction(() => plat.listHours(p, ask), `${p.id} listed at ${v.perHour(ask)}/GPU-h. Bids usually arrive within a day.`);
    return;
  }
  state.listed.set(p.id, offtake ? { askingCents: ask } : { askingPerGpuHour: ask });
  audit('listing_created', p.id, `Listing · ${p.id} · ${offtake ? `${ask}c` : `${v.perHour(ask)}/GPU-h`}`);
  state.listing = false;
  renderLedger();
  renderDetail();
  renderPanels();
  toast(`${p.id} listed at ${offtake ? `${ask}¢` : `${v.perHour(ask)}/GPU-h`}.`);
}

function onInput(event) {
  if (event.target.id === 'd-whatif') {
    state.whatIfAvg = Number(event.target.value);
    const w = whatIfParts(byId(state.selected), state.whatIfAvg);
    $('d-whatif-label').innerHTML = w.label;
    $('d-whatif-chart').innerHTML = w.chart;
    $('d-whatif-out').innerHTML = w.out;
  }
  if (event.target.id === 'd-shock-in') { state.shock = Number(event.target.value) / 100; renderLender(); }
}

/* ---------- start ---------- */
function showSignIn(account) {
  $('d-content').hidden = true;
  $('d-signin').hidden = false;
  if (account?.off) $('d-signin').innerHTML = '<p class="p-off">The platform is off on this server.</p>';
}

function firstSelection() {
  const fromHash = parseHash().id;
  if (fromHash && byId(fromHash)) return fromHash;
  const list = positions();
  return (list.find(p => v.isOption(p) && p.phase !== 'used') || list.find(p => p.phase !== 'used') || list[0])?.id;
}

function wireEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('scroll', () => closeMenus(), { capture: true, passive: true });
  window.addEventListener('resize', () => closeMenus());
  window.addEventListener('hashchange', route);
  $('d-read-all').addEventListener('click', () => { allAlerts().forEach(a => state.read.add(a.id)); writeJson(READ_KEY, [...state.read]); renderAlerts(); });
}

async function start() {
  document.documentElement.classList.remove('no-js');
  wireNavMore();
  let account;
  try { account = await loadAccount(); } catch (error) { toast(error.message); return; }
  if (!account || account.off) { showSignIn(account); document.body.dataset.portfolio = 'gate'; return; }
  state.session = plat.sessionOf(account);
  state.read = new Set(readJson(READ_KEY) || []);
  mountShell(account, {
    onChange: async acct => {
      state.session = plat.sessionOf(acct);
      try { await refresh(); } catch (error) { toast(error.message); }
    },
  });
  wireEvents();
  try {
    state.data = await plat.loadPortfolio();
    state.details = await plat.orderDetails(state.data.positions);
  } catch (error) {
    toast(`Values could not be loaded. ${error.message}`);
    return;
  }
  state.selected = firstSelection();
  renderAccount();
  renderOverview();
  renderLedger();
  renderDetail();
  renderAlerts();
  route();
  document.body.dataset.portfolio = 'loaded';
}

start();
