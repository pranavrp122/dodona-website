/** Customer console: demo session, hash routes, positions with a split panel (exercise, listing, counter-offer), provider and lender tools, overview panels. */
import * as v from '/dashboard-view.js';

const SESSION_KEY = 'dodonaDemoSession';
const BOOKINGS_KEY = 'dodonaDemoBookings';
const READ_KEY = 'dodonaDemoAlertsRead';
const DAY_MS = 86400000;
const QUOTE_TIMEOUT_MS = 3000;
const PHONE = '(max-width:720px)';
const SCREENS = ['overview', 'positions', 'alerts', 'market', 'provider', 'lender', 'settings'];
const PAGES = {
  overview: ['Overview', 'Overview', 'Your positions, their Dodona Value today and what needs your attention.'],
  positions: ['Positions', 'Positions', 'Every price cap, fixed price and offtake you hold. Select a row for its term sheet and actions.'],
  alerts: ['Alerts', 'Alerts', "Index moves, deadlines, offers and collateral flags, generated from today's numbers."],
  market: ['Index and implied curve', 'Index and implied curve', 'Ornn daily index for each GPU, and what Kalshi prices imply for the monthly average.'],
  provider: ['Provider view', 'Sell a cap on idle hours', 'Earn a premium today on hours you might not fill. If the average index over the window rises past the cap, the buyer takes the block at the cap price and your cluster is fully rented.'],
  lender: ['Lender view', 'Lender view', 'GPU fleets marked daily from the rental income they can still earn. Move the rent shock to see value, loan-to-value and months to breach.'],
  settings: ['Settings', 'Settings', 'Organisation, team, notifications, API and billing.'],
};
const ROLE_TEXT = { buyer: 'Buys compute', provider: 'Provides compute', lender: 'Lends or insures', other: 'Other' };
const DEMO_SESSION = { email: 'ops@samplelabs.example', company: 'Sample Labs', role: 'buyer', kyb: 'verified' };
const $ = id => document.getElementById(id);
const esc = v.escapeHtml;

const state = {
  data: null, session: null, screen: 'overview', selected: null, splitOpen: true,
  exercise: null, listing: false, countering: false, whatIf: 0, listed: new Map(), read: new Set(), shock: 0,
  stale: false, shortfall: false,
  provider: { block: 'all', window: 'weekend', cap: 1.1, floor: 0.9, collarCap: 1.2 },
};

/* ---------- storage (per-tab conveniences; the page works without them) ---------- */
function readJson(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key, value) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: keep going in memory */ }
}
function readSession() {
  const s = readJson(SESSION_KEY);
  if (!s || typeof s !== 'object' || typeof s.email !== 'string') return null;
  return {
    email: s.email.slice(0, 254),
    company: typeof s.company === 'string' && s.company.trim() ? s.company.trim().slice(0, 120) : 'Your company',
    role: ['buyer', 'provider', 'lender', 'other'].includes(s.role) ? s.role : 'other',
    kyb: s.kyb === 'verified' ? 'verified' : 'pending',
  };
}

function toast(message) {
  const box = $('d-toasts');
  const item = document.createElement('div');
  item.className = 'd-toast';
  item.textContent = message;
  box.append(item);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => item.remove(), 5200);
}

// Fire-and-forget audit event; the audit route may be absent, so every failure is ignored. Summaries carry no personal data.
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

/* ---------- chart hover layer ---------- */
function attachHover(wrap, points, describe) {
  const svg = wrap?.querySelector('svg.d-chart');
  if (!svg || points.length < 2) return;
  const d = svg.dataset;
  const [left, right, top, bottom, lo, hi] = ['left', 'right', 'top', 'bottom', 'lo', 'hi'].map(k => Number(d[k]));
  const x = i => left + i / (points.length - 1) * (right - left);
  const y = value => top + (hi - value) / (hi - lo) * (bottom - top);
  const cross = svg.querySelector('.d-cross');
  const rule = cross.querySelector('line');
  const dots = [...cross.querySelectorAll('circle')];
  const tip = document.createElement('div');
  tip.className = 'd-tip';
  tip.hidden = true;
  wrap.append(tip);
  let current = points.length - 1;
  const show = i => {
    current = Math.max(0, Math.min(points.length - 1, i));
    const px = x(current);
    rule.setAttribute('x1', px);
    rule.setAttribute('x2', px);
    const ys = dots.map(dot => {
      const py = y(points[current][dot.dataset.key]);
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', py);
      return py;
    });
    cross.setAttribute('visibility', 'visible');
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    tip.innerHTML = describe(points[current]).map(line => `<div>${esc(line)}</div>`).join('');
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(px * scale, 90), wrap.clientWidth - 90)}px`;
    tip.style.top = `${Math.min(...ys) * scale - 10}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect();
    const fx = (event.clientX - box.left) / box.width * svg.viewBox.baseVal.width;
    show(Math.round((fx - left) / (right - left) * (points.length - 1)));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('focus', () => show(current));
  svg.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      show(current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 7 : 1));
    } else if (event.key === 'Escape') hide();
  });
}

/* ---------- positions with local demo state applied ---------- */
const SHORTFALL = { id: 'scenario-shortfall', severity: 'warn', kind: 'Delivery', go: 'positions/H3', text: 'Provider delivered 60 of 64 H100 for H3 · 4 GPUs credited at $5.40 × remaining hours' };
const positions = () => (state.data?.positions || []).map(p => {
  const listed = state.listed.has(p.id) ? { ...p, status: 'listed', ...state.listed.get(p.id) } : p;
  return state.shortfall && p.id === 'H3' ? { ...listed, warning: 'Delivery shortfall · credited' } : listed;
});
const allAlerts = () => (state.shortfall ? [SHORTFALL, ...state.data.alerts] : state.data.alerts);
const byId = id => positions().find(p => p.id === id);
const change = (p, back) => (p.history.length > back ? p.history.at(-1).value - p.history.at(-1 - back).value : 0);

/* ---------- overview ---------- */
function accountDigits() {
  const s = state.session;
  const account = state.data?.account;
  if (account && s.company === account.organisation) return account.accountNumber;
  return String([...s.email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9000, 7) + 1000);
}

function renderAccount() {
  const s = state.session;
  document.querySelectorAll('[data-bind=org]').forEach(el => { el.textContent = s.company; });
  document.querySelectorAll('[data-bind=role]').forEach(el => { el.textContent = ROLE_TEXT[s.role]; });
  document.querySelectorAll('[data-bind=email]').forEach(el => { el.textContent = s.email; });
  document.querySelectorAll('[data-bind=account]').forEach(el => { el.textContent = `•••• ${accountDigits()}`; });
  document.querySelectorAll('[data-bind=kyb]').forEach(el => {
    el.textContent = s.kyb === 'verified' ? 'KYB verified' : 'KYB pending · business checks in progress';
    el.classList.toggle('is-pending', s.kyb !== 'verified');
  });
}

function renderOverview() {
  const { kpis, history } = state.data;
  $('d-hero-value').textContent = v.signedUsd(kpis.netValue);
  $('d-hero-value').className = `d-big ${v.tone(kpis.netValue)}`;
  $('d-hero-cents').textContent = `${v.cents(kpis.centsOnDollar)} on fixed contracts`;
  $('d-hero-say').textContent = `At today's index your remaining hours are worth ${v.usd(Math.abs(kpis.netValue))} ${kpis.netValue >= 0 ? 'more' : 'less'} than you committed to pay. Fixed prices and offtakes mark at ${v.cents(kpis.centsOnDollar)} per dollar still owed; price caps only pay if the average index over their window rises above the cap.`;
  $('d-hero-chips').innerHTML = v.changeChips(kpis.change);
  $('d-chart').innerHTML = v.portfolioChart(history);
  attachHover($('d-chart'), history, p => [v.shortDate(p.date), `Market value ${v.usd(p.marketValue)}`, `Committed cost ${v.usd(p.committedCost)}`, `Dodona Value ${v.signedUsd(p.value)}`]);
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

function termSheet(p) {
  const val = p.valuation;
  const call = p.kind === 'call';
  const rows = [
    termRow('Type', call ? 'Price cap (a call), delivered' : p.kind === 'offtake' ? 'Offtake, take-or-pay' : 'Fixed price, delivered'),
    termRow('Compute', `${p.count.toLocaleString('en-US')} ${p.gpu} · ${p.config}`, p.region),
    termRow('Window', v.windowLabel(p.start, p.end), `${v.utcStamp(p.start)} to ${v.utcStamp(p.end)}`),
    termRow('GPU-hours left', v.hoursText(val.remainingHours)),
    termRow(call ? 'Cap price' : 'Contract price', `${v.perHour(p.pricePerGpuHour)}/GPU-h`),
    termRow('Index today', `${v.perHour(val.spot)}/GPU-h`, `Ornn ${p.gpu} · basis ×${val.basis.toFixed(2)}`, state.data.prices.live ? 'live' : ''),
  ];
  if (call) {
    const wa = val.windowAverage;
    rows.push(
      termRow('Settles on', `Average ${p.gpu} index over the window, capped at ${v.perHour(p.pricePerGpuHour)}`, `Your price for ${v.windowLabel(p.start, p.end)} is the average daily ${p.gpu} index over those days`),
      termRow('Expected window average', `${v.perHour(val.forwardAvg)}/GPU-h`, wa && wa.realised != null ? 'Realised days blended with the forward for the rest' : 'Forward at mid-window, after region and hardware basis'),
      ...(wa && wa.realised != null ? [termRow('Window average so far', `${v.perHour(wa.realised * val.basis)}/GPU-h`, `Over ${Math.round(wa.elapsedDays)} of ${wa.totalDays} days`)] : []),
      termRow('Premium paid', `${v.perHour(p.premiumPerGpuHour)}/GPU-h · ${v.dollars(val.premiumPaid)}`),
      termRow('Bought', p.boughtOn ? v.shortDate(p.boughtOn) : '—', p.indexAtPurchase ? `Index then ${v.perHour(p.indexAtPurchase)}` : ''),
      termRow('Break-even', `Pays off if the window average tops ${v.perHour(val.breakEven)}/GPU-h`),
      termRow('Cluster utilisation', v.percent(p.utilisation ?? 1), 'Sets the resale bid'),
      termRow('Exercise by', v.utcStamp(v.deadlineOf(p))),
    );
  } else {
    rows.push(termRow('Still to pay', v.dollars(val.remainingCost)), termRow('Forward average', `${v.perHour(val.forwardAvg)}/GPU-h`, 'After region and hardware basis'));
  }
  rows.push(
    termRow('Provider', p.provider.label, p.provider.creditTier === 'Delivery-backed' ? 'Delivery-backed' : `Tier ${p.provider.creditTier} · bonds ${p.provider.bondPriceCents}¢`),
    termRow('Volatility', v.percent(val.vol, 1), val.volSampling === 'weekly' ? 'Annualised from weekly changes' : 'Annualised from daily changes'),
    termRow('Method', val.methodVersion, `As of ${v.shortDate(state.data.asOf)}`),
  );
  return `<div class="example-terms d-terms"><dl>${rows.join('')}</dl></div>`;
}

function howComputed(p) {
  const call = p.kind === 'call';
  const timeValue = p.valuation.timeValue == null
    ? 'Time value (the chance it goes further above before the window) is added once the pricing engine is connected; it is not included here.'
    : `Plus time value from the pricing engine: ${v.usd(p.valuation.timeValue)}.`;
  const step3 = call
    ? `A price cap settles on the average daily index over its window, never on one day's print. Its value is how far the expected window average sits above the cap, times the hours, discounted: max(Ā × basis − ${v.perHour(p.pricePerGpuHour)}, 0) × hours × discount. Before the window Ā is the forward at mid-window; during it, the average printed so far blended by days with the forward for the rest. ${timeValue} The premium you paid is already spent and is not counted.`
    : 'Multiply the hours by the gap between that forward and your contract price, month by month.';
  return `<details class="d-how"><summary>How this value is computed</summary><ol>
    <li>Take the GPU-hours you still have: ${esc(v.hoursText(p.valuation.remainingHours))}.</li>
    <li>Estimate the market price for those hours: today's Ornn index (${esc(v.perHour(p.valuation.spot))}), grown at half its recent trend to the window, times the region and hardware basis.</li>
    <li>${esc(step3)}</li>
    <li>Discount at 5% a year, and for the chance the provider does not deliver (zero for delivery-backed contracts).</li>
    ${call ? '' : '<li>Cents on the dollar = 100 + value ÷ remaining contract cost × 100. Above 100 means you pay less than the market.</li>'}
  </ol><p class="fine">Method ${esc(p.valuation.methodVersion)}. An estimate, not an appraisal, offer or advice.</p></details>`;
}

function whatIfParts(p) {
  const index = p.valuation.spot * (1 + state.whatIf);
  const ex = v.exerciseQuote(p, index);
  const pct = Math.round(state.whatIf * 100);
  return {
    pct,
    label: `${esc(v.perHour(index))}/GPU-h <span class="d-muted">(${pct >= 0 ? '+' : '−'}${Math.abs(pct)}%) · window average ${esc(v.perHour(ex.average))}</span>`,
    out: `<div><dt>Intrinsic value</dt><dd>${esc(v.usd(v.intrinsicAt(p, index)))}</dd></div>
      <div><dt>Deliver: saving</dt><dd>${esc(ex.saving > 0 ? v.usd(ex.saving) : 'none')}</dd></div>
      <div><dt>Resell: net</dt><dd>${esc(v.usd(ex.net))}</dd></div>`,
  };
}

function whatIfBlock(p) {
  const w = whatIfParts(p);
  return `<div class="d-whatif"><label for="d-whatif">What if today's index moves to <span id="d-whatif-label">${w.label}</span></label>
    <input type="range" id="d-whatif" min="-40" max="40" step="1" value="${w.pct}" aria-describedby="d-whatif-out">
    <dl id="d-whatif-out" aria-live="polite">${w.out}</dl></div>`;
}

function exercisePanel(p) {
  const ex = v.exerciseQuote(p, p.valuation.spot * (1 + state.whatIf));
  const K = p.pricePerGpuHour;
  const hours = v.hoursText(ex.hours);
  const deliver = state.exercise === 'deliver';
  const rows = deliver
    ? [['GPU-hours', hours], ['Expected window average', `${v.perHour(ex.average)}/GPU-h · cap ${v.perHour(K)}`],
      ['Billed at the lower of the two', `${v.perHour(Math.min(ex.average, K))} × ${hours} = ${v.dollars(ex.pay)}`],
      ['Saving vs the window average', ex.saving > 0 ? `${v.dollars(ex.saving)} · ${v.perHour(ex.average - K)}/GPU-h` : 'None · the window average is expected below the cap, not needed yet']]
    : [['Best bid', `${v.perHour(ex.regional)} × ${v.percent(p.utilisation ?? 1)} utilisation − ${v.perHour(v.RESALE_SPREAD)} = ${v.perHour(ex.bid)}`],
      ['Bid above the cap', `max(${v.perHour(ex.bid)} − ${v.perHour(K)}, 0) = ${v.perHour(Math.max(ex.bid - K, 0))}/GPU-h`],
      ['Resale proceeds', `× ${hours} = ${v.dollars(ex.gross)}`], ['Dodona fee 1%', `−${v.dollars(ex.fee)}`],
      ['Net to you', ex.net > 0 ? v.dollars(ex.net) : '$0 · the bid is below the cap today']];
  const copy = deliver
    ? `You take the hours and the partner neocloud provisions the cluster from ${v.utcStamp(p.start)}. You are billed at the lower of the window's average index and your cap, so the final bill is set when the window ends.`
    : `You take delivery at the cap price and Dodona lists the block for resale. Best bid today: ${v.perHour(ex.bid)}/GPU-h, from the provider or another business.`;
  return `<div class="d-calc" role="region" aria-label="Review exercise"><p class="eyebrow">Step 2 · review ${deliver ? 'delivery' : 'resale'} ${v.tag('model')}</p><p>${esc(copy)}</p>${calcRows(rows)}
    <div class="c-acts"><button type="button" class="btn btn-sm btn-primary" data-act="ex-confirm" id="d-ex-confirm">${v.icon('circle-check')}<span>Confirm ${deliver ? 'delivery' : 'resale'}</span></button><button type="button" class="btn btn-sm" data-act="ex-cancel">${v.icon('x')}<span>Cancel</span></button></div></div>`;
}

function listForm(p) {
  const offtake = p.kind === 'offtake';
  const val = p.valuation;
  const fair = offtake ? Math.round(val.centsOnDollar ?? 100) : Math.max(0.01, val.value / Math.max(val.remainingHours, 1)).toFixed(2);
  return `<form class="d-form" id="d-list-form" novalidate><div class="field"><label for="d-ask">${offtake ? 'Asking, cents on the dollar' : 'Asking, $ per GPU-hour'}</label>
    <input id="d-ask" name="ask" type="number" inputmode="decimal" required ${offtake ? 'min="50" max="150" step="0.5"' : 'min="0.01" max="20" step="0.01"'} value="${esc(fair)}"></div>
    <button type="submit" class="btn btn-sm btn-primary">${v.icon('tag')}<span>List at this price</span></button>
    <p class="fine">Today's Dodona Value is ${esc(offtake ? v.cents(val.centsOnDollar) : v.perHour(Number(fair)) + '/GPU-h')}. Listings are anonymous until both sides agree.</p></form>`;
}

function counterForm(p) {
  return `<form class="d-form" id="d-offer-form" novalidate><div class="field"><label for="d-counter">Counter-offer, cents on the dollar</label>
    <input id="d-counter" type="number" inputmode="decimal" required min="50" max="150" step="0.5" value="${esc(Math.round((p.bestOfferCents + p.askingCents) / 2))}"></div>
    <button type="submit" class="btn btn-sm btn-primary">${v.icon('message-square')}<span>Send counter-offer</span></button>
    <p class="fine">Best offer today: ${esc(p.bestOfferCents)}¢ against your ask of ${esc(p.askingCents)}¢. Both sides stay anonymous until agreed.</p></form>`;
}

// Same button set as the row: one primary, the rest outlined, a third under "More".
function detailActions(p) {
  if (p.phase === 'used') return '';
  const listed = p.status === 'listed';
  const actions = [];
  if (p.kind === 'call' && !listed) {
    actions.push({ act: 'ex', mode: 'deliver', label: 'Exercise · deliver', icon: 'zap', primary: true, pressed: state.exercise === 'deliver' },
      { act: 'ex', mode: 'resell', label: 'Exercise · resell the hours', icon: 'zap', pressed: state.exercise === 'resell' });
  }
  if (listed && p.bestOfferCents) actions.push({ act: 'counter', label: `Counter the ${p.bestOfferCents}¢ offer`, icon: 'message-square', primary: true, expanded: state.countering });
  if (!listed) actions.push({ act: 'list', label: 'List for sale', icon: 'tag', primary: !actions.length, expanded: state.listing });
  return v.actionBar(actions, { menuId: 'd-menu-detail', label: `More actions for ${p.id}` });
}

function detailHeadline(p) {
  const val = p.valuation;
  if (p.phase === 'used') return `<p class="d-big is-gain">${esc(v.signedUsd(p.used.saving))}</p><p class="d-d-row d-muted">Saved against the index over the window. Nothing left to value.</p>`;
  const call = p.kind === 'call';
  const money = val.moneyness > 0 ? `window average expected ${v.perHour(val.moneyness)} above the cap` : `window average expected ${v.perHour(-val.moneyness)} below the cap · not needed yet`;
  const line = call
    ? `<strong>Pays off if the window average tops ${esc(v.perHour(val.breakEven))}/GPU-h</strong><span class="${val.moneyness > 0 ? 'is-gain' : 'd-oom'}">${esc(money)}</span>`
    : `<strong class="${v.tone(val.centsOnDollar - 100)}">${esc(v.cents(val.centsOnDollar))} on the dollar</strong>`;
  return `<p class="d-big ${call ? (val.moneyness > 0 ? 'is-gain' : 'd-oom') : v.tone(val.value)}">${esc(v.signedUsd(val.value))}</p>
    <p class="d-d-row">${line}<span class="d-muted">range ${esc(v.signedUsd(val.low))} to ${esc(v.signedUsd(val.high))}</span></p>
    <div class="d-chips">${v.changeChips({ d1: change(p, 1), d7: change(p, 7), d30: change(p, 30) })}</div>`;
}

function renderDetail() {
  const p = byId(state.selected);
  const box = $('d-detail');
  if (!p) { box.innerHTML = '<p class="d-empty">0 selected. Select a position to see its term sheet, 90-day value and actions.</p>'; return; }
  const live = p.phase !== 'used';
  const call = p.kind === 'call';
  const status = v.statusText(p, state.data.asOf);
  const toggle = `<button type="button" class="btn btn-sm btn-icon" data-act="split-toggle" aria-expanded="${state.splitOpen}" aria-controls="d-split-b" aria-label="${state.splitOpen ? 'Collapse' : 'Expand'} the detail panel">${v.icon(state.splitOpen ? 'chevron-down' : 'chevron-up')}</button>`;
  box.classList.toggle('is-collapsed', !state.splitOpen);
  box.innerHTML = `<div class="c-split-h"><div><p class="eyebrow">1 selected · ${esc(p.id)} · ${esc(v.kindLabel(p.kind))}${p.source === 'booking' ? ' · booked this session' : ''} ${v.tag(p.source === 'booking' ? 'model' : 'sample')}</p>
      <h2 id="d-split-h" tabindex="-1">${esc(p.label)}</h2></div>
      <div class="c-acts">${v.statusPill(status.cls, status.text)}${detailActions(p)}${toggle}</div></div>
    <div class="c-split-b" id="d-split-b"${state.splitOpen ? '' : ' hidden'}>
      <div class="c-split-col">
        <div class="d-d-head"><p class="d-d-sub">${esc(p.region)} · ${esc(p.provider.label)}</p>${detailHeadline(p)}</div>
        ${call && live && state.exercise ? exercisePanel(p) : ''}
        ${live && state.listing && p.status !== 'listed' ? listForm(p) : ''}
        ${live && state.countering && p.bestOfferCents ? counterForm(p) : ''}
        ${live ? `<div><p class="eyebrow">90-day Dodona Value ${v.tag('model')}</p><div class="d-chart-wrap" id="d-detail-chart">${v.positionChart(p)}</div></div>` : ''}
        ${call && live ? whatIfBlock(p) : ''}
      </div>
      <div class="c-split-col"><h3 class="d-h3">Term sheet</h3>${termSheet(p)}${howComputed(p)}</div>
    </div>`;
  if (live && state.splitOpen) attachHover($('d-detail-chart'), p.history, point => [v.shortDate(point.date), `Dodona Value ${v.signedUsd(point.value)}`]);
}

function revealDetail() {
  if (window.matchMedia(PHONE).matches) $('d-detail').scrollIntoView({ block: 'start' });
}

function select(id, { scroll = false } = {}) {
  if (!byId(id)) return;
  const changed = state.selected !== id;
  state.selected = id;
  if (changed) {
    state.exercise = null;
    state.listing = false;
    state.countering = false;
    state.whatIf = 0;
  }
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
  $('d-alerts-mini').innerHTML = alerts.slice(0, 4).map(a => alertItem(a, false)).join('');
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
      <p class="fine">With the cap: premium income plus either the market rental (cap unused) or the whole block at the cap price (cap used).</p>
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
const fleetRows = () => state.data.fleets.map(f => ({ f, s: v.fleetUnderShock(f, state.shock) }));

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
    <td class="r d-num">${s.monthsToBreach === 0 ? 'In breach' : s.monthsToBreach ? `${s.monthsToBreach} mo` : 'Not within life'}</td></tr>`).join('');
}

/* ---------- CSV exports ---------- */
function saveCsv(lines, name, message) {
  const cell = value => `"${String(value).replace(/"/g, '""')}"`;
  const blob = new Blob([lines.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(message);
}

function downloadCsv() {
  const lines = [['Facility', 'GPU', 'Units', 'Installed', 'Loan balance USD', 'Fleet value USD', 'Loan-to-value', 'Status', 'Months to breach', 'Rent shock', 'Index as of', 'Method']];
  for (const { f, s } of fleetRows()) {
    lines.push([f.label, f.gpu, f.units, f.installedOn, Math.round(f.loanBalance), Math.round(s.value), s.ltv.toFixed(4), s.status, s.monthsToBreach ?? '', `-${Math.round(state.shock * 100)}%`, state.data.prices.asOf, state.data.methodVersion]);
  }
  saveCsv(lines, `dodona-facilities-${state.data.asOf}.csv`, 'CSV downloaded. Sample data for demonstration.');
}

function positionsCsv() {
  const lines = [['Position', 'Type', 'GPU', 'Count', 'Region', 'Window start UTC', 'Window end UTC', 'Price USD per GPU-hour', 'GPU-hours left', 'Dodona Value USD', 'Cents on the dollar', 'Status', 'Method']];
  for (const p of positions()) {
    const val = p.valuation;
    lines.push([p.id, v.kindLabel(p.kind), p.gpu, p.count, p.region, p.start, p.end, p.pricePerGpuHour, Math.round(val.remainingHours), p.phase === 'used' ? '' : Math.round(val.value), val.centsOnDollar == null ? '' : val.centsOnDollar.toFixed(1), v.statusText(p, state.data.asOf).text, state.data.methodVersion]);
  }
  saveCsv(lines, `dodona-positions-${state.data.asOf}.csv`, 'CSV downloaded. Sample data for demonstration.');
}

function billingCsv() {
  const lines = [['Invoice', 'Month', 'Premiums USD', 'Of which platform fee USD', 'Booking fees USD', 'Total USD', 'Status', 'Positions']];
  for (const row of v.billingMonths(positions(), state.data.asOf)) {
    lines.push([row.id, row.month, row.premiums.toFixed(2), row.platformFee.toFixed(2), row.bookingFees.toFixed(2), row.total.toFixed(2), row.status, row.positions.join(' ')]);
  }
  saveCsv(lines, `dodona-billing-${state.data.asOf}.csv`, 'Billing CSV downloaded. Demo data for demonstration.');
}

const exportCsv = () => (state.screen === 'lender' ? downloadCsv() : state.screen === 'settings' ? billingCsv() : positionsCsv());

/* ---------- settings ---------- */
function renderSettings() {
  const s = state.session;
  const domain = s.email.split('@')[1] || 'example.com';
  const kv = rows => `<dl class="d-kv">${rows.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>`;
  const now = new Date();
  const nextInvoice = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const head = (id, title, desc, action = '') => `<div class="c-ctr-h"><div><h2 id="${id}">${title}</h2>${desc ? `<p>${desc}</p>` : ''}</div>${action}</div>`;
  const smallBtn = (attrs, iconName, label) => `<button type="button" class="btn btn-sm" ${attrs}>${v.icon(iconName)}<span>${esc(label)}</span></button>`;
  $('d-settings').innerHTML = `
    <section class="c-ctr c-s6" aria-labelledby="d-set-org">${head('d-set-org', 'Organisation', 'Who this account belongs to.')}${kv([['Name', s.company], ['KYB status', s.kyb === 'verified' ? 'Verified' : 'Pending'], ['Role', ROLE_TEXT[s.role]], ['Account', `•••• ${accountDigits()}`]])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-team">${head('d-set-team', 'Team <span class="c-count">2</span>', 'People who can see and act on positions.', smallBtn('data-toast="Demo: invite not sent."', 'plus', 'Invite'))}
      <div class="d-scroll"><table class="d-table"><thead><tr><th scope="col">Member</th><th scope="col">Role</th></tr></thead><tbody>
        <tr><td>${esc(s.email)}</td><td>Admin</td></tr><tr><td>finance@${esc(domain)}</td><td>Finance</td></tr></tbody></table></div></section>
    <section class="c-ctr c-s12" aria-labelledby="d-set-bill">${head('d-set-bill', `${v.icon('receipt', 'c-h-ic')}Billing ${v.tag('demo')}`, `Invoices by ACH, no card fees · next invoice ${esc(v.shortDate(nextInvoice))} · Dodona never holds funds.`, smallBtn('data-act="billing-csv"', 'download', 'Export CSV'))}
      <div class="c-ctr-b">${v.billingPanel(positions(), state.data.asOf)}</div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-note">${head('d-set-note', 'Notifications', 'Email alerts for this account.')}<div class="d-toggles">
      <label class="d-toggle">Index moves over 3% on my GPUs<input type="checkbox" checked></label>
      <label class="d-toggle">Claim and exercise deadlines, 3 days before<input type="checkbox" checked></label>
      <label class="d-toggle">Offers on my listings<input type="checkbox"></label></div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-api">${head('d-set-api', 'API', 'Read positions and values from your own tools.', smallBtn('data-toast="Demo: key created and shown once. Nothing was stored."', 'plus', 'Create key'))}
      ${kv([['Read key', 'dod_test_••••••••7f3a'], ['Scope', 'Positions and values, read only'], ['Endpoint', '/api/portfolio']])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-terms">${head('d-set-terms', 'How terms settle', 'The words used across this console.')}
      ${kv([['Price cap', 'Settles on the average daily index over the window, never on one day. You pay the lower of that average and the cap.'], ['Window average', 'Mean of the daily Ornn index on each day of the delivery window, after region and hardware basis.'], ['Fixed price', 'A set price per GPU-hour for the window, whatever the index does.'], ['Offtake', 'Take-or-pay hours at a fixed price over several months.']])}</section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-demo">${head('d-set-demo', 'Demo scenarios', 'Scripted for the demo. They change this page only.')}<div class="d-scenarios">
      <button type="button" class="btn btn-sm" data-act="scenario" data-id="stale" aria-pressed="${state.stale}">${v.icon('clock')}<span>Stale quote · index 3 days old, quotes paused</span></button>
      <button type="button" class="btn btn-sm" data-act="scenario" data-id="shortfall" aria-pressed="${state.shortfall}">${v.icon('triangle-alert')}<span>Delivery shortfall · H3 delivered 60 of 64</span></button></div></section>
    <section class="c-ctr c-s6" aria-labelledby="d-set-session">${head('d-set-session', 'Session', '')}<div class="c-ctr-b"><p>Signed in as ${esc(s.email)} in this browser tab.</p>
      <p class="c-acts c-note">${smallBtn('data-act="sign-out"', 'log-out', 'Sign out')}</p></div></section>`;
  applyBars($('d-settings'));
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

/* ---------- events ---------- */
function confirmExercise(p) {
  const ex = v.exerciseQuote(p, p.valuation.spot * (1 + state.whatIf));
  toast(state.exercise === 'deliver'
    ? `Demo: delivery confirmed for ${p.id}. You pay ${v.dollars(ex.pay)}; the partner neocloud provisions the cluster. Nothing was sent.`
    : `Demo: you take delivery of ${p.id} at the cap price and the block is listed for resale at ${v.perHour(ex.bid)}/GPU-h, net about ${v.dollars(ex.net)}. Nothing was sent.`);
  audit('exercise_confirmed', p.id, `Exercise · ${state.exercise === 'deliver' ? 'deliver' : 'resell'} · ${p.id} · ${p.count} ${p.gpu} · ${v.perHour(p.pricePerGpuHour)}`);
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
  toast(id === 'stale' ? (state.stale ? 'Scenario on: quotes paused until the index updates.' : 'Scenario off: quotes resume.') : (state.shortfall ? 'Scenario on: delivery shortfall on H3.' : 'Scenario off: delivery shortfall cleared.'));
}

// Row and panel actions open the split panel on that position first.
function positionAction(act, button) {
  const fromRow = button.dataset.pos;
  if (fromRow) select(fromRow);
  state.splitOpen = true;
  if (act === 'ex') {
    state.exercise = fromRow ? button.dataset.mode : (state.exercise === button.dataset.mode ? null : button.dataset.mode);
    state.listing = false;
    state.countering = false;
  } else if (act === 'list') {
    state.listing = fromRow ? true : !state.listing;
    state.exercise = null;
    state.countering = false;
  } else if (act === 'counter') {
    state.countering = fromRow ? true : !state.countering;
    state.exercise = null;
    state.listing = false;
  }
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
  const p = byId(state.selected);
  switch (target.dataset.act) {
    case 'more': toggleMenu(target); break;
    case 'ex': case 'list': case 'counter': case 'view': closeMenus(); positionAction(target.dataset.act, target); break;
    case 'split-toggle': state.splitOpen = !state.splitOpen; renderDetail(); document.querySelector('[data-act="split-toggle"]')?.focus(); break;
    case 'ex-cancel': state.exercise = null; renderDetail(); break;
    case 'ex-confirm': confirmExercise(p); break;
    case 'scenario': runScenario(target.dataset.id); break;
    case 'stale-dismiss': state.stale = false; $('d-stale').hidden = true; if (state.screen === 'settings') renderSettings(); break;
    case 'read': state.read.add(target.dataset.id); writeJson(READ_KEY, [...state.read]); renderAlerts(); break;
    case 'pick': state.provider[target.dataset.key] = ['block', 'window'].includes(target.dataset.key) ? target.dataset.value : Number(target.dataset.value); renderProvider(); break;
    case 'export': exportCsv(); break;
    case 'billing-csv': billingCsv(); break;
    case 'sign-out': writeJson(SESSION_KEY, null); history.replaceState(null, '', '/dashboard'); location.reload(); break;
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
  const cents = Number($('d-counter').value);
  if (!(cents >= 50 && cents <= 150)) { toast('Enter a counter-offer between 50¢ and 150¢.'); return; }
  state.countering = false;
  renderDetail();
  audit('offer_sent', p.id, `Offer · ${p.id} · ${cents}c`);
  toast(`Demo: counter-offer of ${cents}¢ on ${p.id} recorded. Nothing was sent to the other side.`);
}

function onSubmit(event) {
  if (event.target.id === 'd-offer-form') { onCounter(event); return; }
  if (event.target.id !== 'd-list-form') return;
  event.preventDefault();
  const p = byId(state.selected);
  const ask = Number($('d-ask').value);
  const offtake = p.kind === 'offtake';
  if (offtake ? !(ask >= 50 && ask <= 150) : !(ask > 0 && ask <= 20)) {
    toast(offtake ? 'Enter an asking price between 50¢ and 150¢.' : 'Enter an asking price between $0.01 and $20 per GPU-hour.');
    return;
  }
  state.listed.set(p.id, offtake ? { askingCents: ask } : { askingPerGpuHour: ask });
  audit('listing_created', p.id, `Listing · ${p.id} · ${offtake ? `${ask}c` : `${v.perHour(ask)}/GPU-h`}`);
  state.listing = false;
  renderLedger();
  renderDetail();
  renderPanels();
  toast(`Demo: ${p.id} listed at ${offtake ? `${ask}¢` : `${v.perHour(ask)}/GPU-h`}. It would show on the board; nothing was sent.`);
}

function onInput(event) {
  if (event.target.id === 'd-whatif') {
    state.whatIf = Number(event.target.value) / 100;
    const p = byId(state.selected);
    const w = whatIfParts(p);
    $('d-whatif-label').innerHTML = w.label;
    $('d-whatif-out').innerHTML = w.out;
    const calc = document.querySelector('.d-calc[role=region]');
    if (state.exercise && calc) calc.outerHTML = exercisePanel(p);
  }
  if (event.target.id === 'd-shock-in') { state.shock = Number(event.target.value) / 100; renderLender(); }
}

/* ---------- start ---------- */
async function loadPortfolio() {
  const bookings = readJson(BOOKINGS_KEY);
  const query = Array.isArray(bookings) && bookings.length ? `?bookings=${encodeURIComponent(JSON.stringify(bookings.slice(-20)))}` : '';
  const response = await fetch(`/api/portfolio${query}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Portfolio request failed with ${response.status}.`);
  return response.json();
}

function showSignIn() {
  $('d-content').hidden = true;
  $('d-signin').hidden = false;
  $('d-demo-login').addEventListener('click', () => {
    writeJson(SESSION_KEY, { ...DEMO_SESSION, createdAt: new Date().toISOString() });
    if (!readSession()) { toast('This browser blocks session storage, so the demo account cannot open here.'); return; }
    location.reload();
  });
}

function firstSelection() {
  const fromHash = parseHash().id;
  if (fromHash && byId(fromHash)) return fromHash;
  const list = positions();
  return (list.find(p => p.source === 'booking') || list.find(p => p.kind === 'call' && p.phase !== 'used') || list[0])?.id;
}

// The phone tab bar shows four screens and a "More" sheet with the rest.
function wireNavMore() {
  $('d-nav-more').addEventListener('click', () => {
    const open = $('d-rail').classList.toggle('is-more');
    $('d-nav-more').setAttribute('aria-expanded', String(open));
  });
}

async function start() {
  document.documentElement.classList.remove('no-js');
  wireNavMore();
  state.session = readSession();
  if (!state.session) { showSignIn(); return; }
  state.read = new Set(readJson(READ_KEY) || []);
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('scroll', () => closeMenus(), { capture: true, passive: true });
  window.addEventListener('resize', () => closeMenus());
  $('d-read-all').addEventListener('click', () => { allAlerts().forEach(a => state.read.add(a.id)); writeJson(READ_KEY, [...state.read]); renderAlerts(); });
  renderAccount();
  try {
    state.data = await loadPortfolio();
  } catch {
    toast('Values could not be refreshed. Showing the figures from page load.');
    return;
  }
  renderAccount();
  state.selected = firstSelection();
  renderOverview();
  renderLedger();
  renderDetail();
  renderAlerts();
  window.addEventListener('hashchange', route);
  route();
  const booked = state.data.positions.filter(p => p.source === 'booking').length;
  if (booked) toast(`${booked} demo booking${booked === 1 ? '' : 's'} from this session added as upcoming positions.`);
  if (state.data.rejectedBookings) toast(`${state.data.rejectedBookings} demo booking${state.data.rejectedBookings === 1 ? '' : 's'} could not be read and ${state.data.rejectedBookings === 1 ? 'was' : 'were'} skipped.`);
  document.body.dataset.portfolio = 'loaded';
}

start();
