/** Shared arithmetic and HTML renderers for the customer dashboard; imported by the server and by the browser script. */
import { escapeHtml, usd, perHour, gpuHours, cents, shortDate } from './contracts-view.js';

export { escapeHtml, usd, perHour, gpuHours, cents, shortDate };

export const RESALE_SPREAD = 0.1;
export const RESALE_FEE = 0.01;
export const PLACEHOLDER_PREMIUM = 0.1;
export const LTV_WATCH = 0.6;
export const LTV_BREACH = 0.75;
export const HOURS_PER_MONTH = 720;
export const FOOTER_LINE = 'Index data: Ornn daily index, demonstration only; not licensed for commercial valuation. Dodona Value is an estimate, not an appraisal, offer or advice.';
export const BANNER_LINE = 'Demo account · sample data · nothing here is a live price, order or account';

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KIND_LABEL = { lock: 'Fixed price', call: 'Price cap', put: 'Price floor', offtake: 'Offtake' };
const MINUS = '−';

/* ---------- formatting ---------- */
// Provenance tag beside a number: live (Ornn index), model (Dodona Value and arithmetic), sample (illustrative data), demo (simulated for the demo).
const TAG_TEXT = { demo: 'demo data' };
export const tag = kind => `<span class="tag d-tag-${kind}">${TAG_TEXT[kind] || kind}</span>`;
// Inline icon from the Lucide sprite at the top of dashboard.html.
export const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
export const kindLabel = kind => KIND_LABEL[kind] || kind;
export const signedUsd = v => (v == null || !Number.isFinite(v) ? '—' : v > 0 ? '+' + usd(v) : usd(v));
export const dollars = v => `${v < 0 ? MINUS : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
export const hoursText = h => `${Math.round(h).toLocaleString('en-US')} h`;
export const percent = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const tone = v => (v == null || Math.abs(v) < 0.5 ? 'is-flat' : v > 0 ? 'is-gain' : 'is-loss');
export const dayMonth = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const utcStamp = iso => `${shortDate(iso)}, ${new Date(iso).toISOString().slice(11, 16)} UTC`;
export const deadlineOf = position => new Date(Date.parse(position.start) - DAY_MS).toISOString();
export const roundTo = (value, step) => Math.round(value / step) * step;

// "3–17 Nov 2026", "1 Dec 2026 – 31 Jan 2027" (UTC, inclusive of the last day).
export function windowLabel(start, end) {
  const s = new Date(start);
  const e = new Date(Date.parse(end) - 1);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  if (sameYear && s.getUTCMonth() === e.getUTCMonth()) return `${s.getUTCDate()}–${e.getUTCDate()} ${MONTHS[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  return `${shortDate(s.toISOString())} – ${shortDate(e.toISOString())}`;
}

/* ---------- arithmetic shared by server and browser ---------- */

// Caps settle on the average daily index over the window. Expected average if the index were `index` today:
// the forward for the days still to come, blended by days with the average already printed inside the window.
export function windowAverageAt(position, index) {
  const v = position.valuation;
  const forward = index * v.forwardFactor;
  const w = v.windowAverage;
  return w && w.realised != null ? w.realised * w.realisedWeight + forward * (1 - w.realisedWeight) : forward;
}

// Exercising a call at a given index. Deliver: take the hours, billed at the lower of the window average and the cap.
// Resell: take delivery and sell the block on the board at a bid from today's index.
export function exerciseQuote(position, index) {
  const v = position.valuation;
  const K = position.pricePerGpuHour;
  const hours = v.remainingHours;
  const regional = index * v.basis;
  const average = windowAverageAt(position, index) * v.basis;
  const bid = Math.max(regional * (position.utilisation ?? 1) - RESALE_SPREAD, 0);
  const gross = Math.max(bid - K, 0) * hours;
  const fee = gross * RESALE_FEE;
  return { hours, regional, average, pay: Math.min(average, K) * hours, atAverage: average * hours, saving: (average - K) * hours, bid, gross, fee, net: gross - fee };
}

// Intrinsic value of a call if the index were `index` today: max(Ā·b − K, 0) × hours × discount on the expected window average Ā.
export function intrinsicAt(position, index) {
  const v = position.valuation;
  return Math.max(windowAverageAt(position, index) * v.basis - position.pricePerGpuHour, 0) * v.remainingHours * v.discountFactor;
}

// Provider selling a cap on idle hours: market-only revenue against premium plus (if used) the block rented at the cap.
export function providerScenarios({ index, strike, premium, gpuHours: hours }) {
  return [['Quiet', 0.8, 0.5, false], ['Moderate', 1, 0.7, true], ['Spike', 1.15, 0.9, true]].map(([name, move, fill, used]) => {
    const price = index * move;
    const market = price * fill * hours;
    const income = premium * hours;
    const withCap = used ? strike * hours + income : market + income;
    return { name, price, fill, used, market, withCap, winner: withCap >= market ? 'cap' : 'market' };
  });
}

// Collar: buy a floor (put) and pay for it partly by selling a cap (call).
export function collar({ floor, putPremium, callPremium, gpuHours: hours, units }) {
  const netPerHour = putPremium - callPremium;
  return { netPerHour, netTotal: netPerHour * hours, protectedPerMonth: floor * units * HOURS_PER_MONTH };
}

export const ltvStatus = ltv => (ltv < LTV_WATCH ? 'ok' : ltv < LTV_BREACH ? 'watch' : 'breach');

// Fleet value under a rent shock (income scales with the index), with straight-line loan and value run-off for months to breach.
export function fleetUnderShock(fleet, shock) {
  const m = fleet.mark;
  const value = m.fleetValue * (1 - shock);
  const ltv = value > 0 ? fleet.loanBalance / value : Infinity;
  let monthsToBreach = ltv >= LTV_BREACH ? 0 : null;
  for (let month = 1; monthsToBreach === null && month < m.remainingLifeMonths; month++) {
    const valueThen = value * (m.remainingLifeMonths - month) / m.remainingLifeMonths;
    const balanceThen = fleet.loanBalance * Math.max(0, 1 - month / fleet.amortisationMonths);
    if (balanceThen / valueThen >= LTV_BREACH) monthsToBreach = month;
  }
  return { value, ltv, status: ltvStatus(ltv), monthsToBreach };
}

/* ---------- ledger ---------- */

export function statusText(position, today) {
  if (position.phase === 'used') return { cls: 'used', text: `Used · saved about ${usd(position.used.saving)}` };
  if (position.status === 'listed') return { cls: 'listed', text: `Listed at ${position.kind === 'offtake' ? cents(position.askingCents) : perHour(position.askingPerGpuHour) + '/GPU-h'}` };
  if (position.phase === 'window') {
    const days = Math.max(1, Math.ceil((Date.parse(position.end) - Date.parse(today)) / DAY_MS));
    return { cls: 'window', text: `In window · ${days} day${days === 1 ? '' : 's'} left` };
  }
  if (position.kind === 'offtake') return { cls: 'held', text: 'Held · offtake' };
  return { cls: 'upcoming', text: `Upcoming · ${position.kind === 'call' ? 'exercise' : 'claim'} by ${dayMonth(deadlineOf(position))}` };
}

// Status is always an icon plus a word, never colour alone.
const STATUS_LOOK = {
  upcoming: ['clock', 'info'], window: ['circle-play', 'success'], listed: ['tag', 'accent'], used: ['circle-check', 'neutral'], held: ['calendar', 'neutral'],
  ok: ['circle-check', 'success'], watch: ['triangle-alert', 'warning'], breach: ['circle-x', 'error'],
};
const TYPE_ICON = { call: 'arrow-up-to-line', put: 'arrow-down-to-line', lock: 'lock', offtake: 'package' };
const CHOICE_OPEN = ['paid', 'reserving', 'reserved'];

export const pill = (iconName, toneName, text) => `<span class="pill tone-${toneName}">${icon(iconName)}<span>${escapeHtml(text)}</span></span>`;
export const statusPill = (cls, text) => pill(...(STATUS_LOOK[cls] || ['info', 'neutral']), text);
export const typePill = kind => pill(TYPE_ICON[kind] || 'layers', 'neutral', kindLabel(kind));

// Row and split-panel actions: one primary by status, the rest outlined; a third and later action goes under "More".
export function positionActions(position) {
  const view = { act: 'view', label: 'View', icon: 'eye' };
  if (position.phase === 'used') return [{ ...view, primary: true }];
  if (position.status === 'listed') {
    if (position.bestBid) return [{ act: 'accept', label: 'Accept the bid', icon: 'check', primary: true }, { act: 'counter', label: 'Counter', icon: 'message-square' }, view];
    return position.bestOfferCents ? [{ act: 'counter', label: 'Counter offer', icon: 'message-square', primary: true }, view] : [{ ...view, primary: true }];
  }
  // Demo platform orders: the delivery choice and listing stay open from payment until the window starts.
  if (position.orderRef && !CHOICE_OPEN.includes(position.status)) return [{ ...view, primary: true }];
  const list = { act: 'list', label: 'List for sale', icon: 'tag' };
  if (position.kind === 'call' || position.kind === 'put') {
    return [{ act: 'ex', mode: 'deliver', label: 'Exercise', icon: 'zap', primary: true }, list, { act: 'ex', mode: 'resell', label: 'Resell the hours', icon: 'zap' }, { ...view, label: 'View details' }];
  }
  return [{ ...view, primary: true }, list];
}

const actionAttrs = (a, id) => `data-act="${escapeHtml(a.act)}"${a.mode ? ` data-mode="${escapeHtml(a.mode)}"` : ''}${id ? ` data-pos="${escapeHtml(id)}"` : ''}${a.pressed == null ? '' : ` aria-pressed="${a.pressed}"`}${a.expanded == null ? '' : ` aria-expanded="${a.expanded}"`}`;

export function actionBar(actions, { id = '', menuId, label = 'More actions' } = {}) {
  const button = a => `<button type="button" class="btn btn-sm${a.primary ? ' btn-primary' : ''}" ${actionAttrs(a, id)}>${icon(a.icon)}<span>${escapeHtml(a.label)}</span></button>`;
  const inline = actions.slice(0, 2).map(button).join('');
  const rest = actions.slice(2);
  const more = rest.length
    ? `<div class="c-more"><button type="button" class="btn btn-sm btn-icon" data-act="more" aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeHtml(menuId)}" aria-label="${escapeHtml(label)}">${icon('ellipsis')}</button>
      <div class="c-menu" id="${escapeHtml(menuId)}" role="menu" hidden>${rest.map(a => `<button type="button" role="menuitem" class="c-menu-item" ${actionAttrs(a, id)}>${icon(a.icon)}<span>${escapeHtml(a.label)}</span></button>`).join('')}</div></div>`
    : '';
  return `<div class="c-acts">${inline}${more}</div>`;
}

// How far the expected window average sits on the paying side of the strike: above a cap, below a floor.
export const optionGap = p => (p.kind === 'put' ? p.pricePerGpuHour - p.valuation.forwardAvg : p.valuation.moneyness);
export const isOption = p => p.kind === 'call' || p.kind === 'put';

function moneyLine(position) {
  const m = optionGap(position);
  const put = position.kind === 'put';
  return m > 0
    ? `<span class="is-gain">window avg ${put ? MINUS : '+'}${perHour(m)} ${put ? 'under floor' : 'over cap'}</span>`
    : `<span class="d-oom">window avg ${put ? '+' : MINUS}${perHour(-m)} · not needed yet</span>`;
}

export function ledgerRow(position, { selected = false, today } = {}) {
  const v = position.valuation;
  const call = isOption(position);
  const used = position.phase === 'used';
  const status = statusText(position, today);
  const id = escapeHtml(position.id);
  const valueCell = used
    ? '<td class="r d-num d-muted">n/a<span class="d-sub">window used</span></td>'
    : `<td class="r d-num"><span class="${call ? (optionGap(position) > 0 ? 'is-gain' : 'd-oom') : tone(v.value)}">${signedUsd(v.value)}</span><span class="d-sub">${signedUsd(v.low)} to ${signedUsd(v.high)}</span>${call ? '' : `<span class="d-sub ${tone(v.centsOnDollar - 100)}">${cents(v.centsOnDollar)} on the dollar</span>`}</td>`;
  return `<tr data-row="${id}" tabindex="0" aria-selected="${selected}">
    <td><div class="d-pos"><span class="d-gpu d-gpu-${escapeHtml(position.gpu)}">${escapeHtml(position.gpu)}</span><div>
      <span class="d-pos-l">${escapeHtml(position.count.toLocaleString('en-US'))} ${escapeHtml(position.gpu)} · ${escapeHtml(windowLabel(position.start, position.end))}</span>
      <span class="d-pos-s">${id} · ${escapeHtml(position.region)}</span></div></div></td>
    <td>${typePill(position.kind)}</td>
    <td class="r d-num">${used ? '—' : escapeHtml(gpuHours(v.remainingHours))}</td>
    <td class="r d-num">${perHour(position.pricePerGpuHour)}${call ? ' cap' : ''}<span class="d-sub">index ${perHour(v.spot * v.basis)}</span>${call && !used ? `<span class="d-sub">${moneyLine(position)}</span>` : ''}</td>
    ${valueCell}
    <td>${statusPill(status.cls, status.text)}${position.warning ? `<span class="d-warn-pill">${icon('triangle-alert')}${escapeHtml(position.warning)}</span>` : ''}</td>
    <td class="c-act-cell">${actionBar(positionActions(position), { id: position.id, menuId: `d-menu-${position.id}`, label: `More actions for ${position.id}` })}</td>
  </tr>`;
}

export const ledgerRows = (portfolio, selectedId) =>
  portfolio.positions.map(p => ledgerRow(p, { selected: p.id === selectedId, today: portfolio.asOf })).join('');

// Compact list for the overview: each row links to the position on the Positions screen.
export function positionSummary(portfolio) {
  return portfolio.positions.map(p => {
    const status = statusText(p, portfolio.asOf);
    const used = p.phase === 'used';
    const value = used ? `<span class="d-muted">${escapeHtml(signedUsd(p.used.saving))} saved</span>` : `<span class="${isOption(p) ? (optionGap(p) > 0 ? 'is-gain' : 'd-oom') : tone(p.valuation.value)}">${escapeHtml(signedUsd(p.valuation.value))}</span>`;
    return `<li><a class="c-mini-row" href="#positions/${escapeHtml(p.id)}"><span class="d-gpu d-gpu-${escapeHtml(p.gpu)}">${escapeHtml(p.gpu)}</span>
      <span class="c-mini-main"><span class="d-pos-l">${escapeHtml(p.count.toLocaleString('en-US'))} ${escapeHtml(p.gpu)} · ${escapeHtml(kindLabel(p.kind))}</span>${statusPill(status.cls, status.text)}</span>
      <span class="c-mini-val d-num">${value}</span>${icon('arrow-right', 'c-mini-go')}</a></li>`;
  }).join('');
}

/* ---------- console panels: coverage, savings, upcoming dates, billing ---------- */
export const PLANNED_GPUS = 300;
export const BOOKING_FEE = 2;
export const PLATFORM_SHARE = 0.15;
const HOUR_MS = 3600000;
const noonOf = asOf => Date.parse(asOf.slice(0, 10) + 'T12:00:00Z');
const sumOf = (items, pick) => items.reduce((total, item) => total + pick(item), 0);

// Committed GPU-hours that fall in the next `days`, against a planned use of PLANNED_GPUS running around the clock (demo assumption).
export function coverage(positions, asOf, days) {
  const from = noonOf(asOf);
  const to = from + days * DAY_MS;
  const inRange = p => p.count * Math.max(0, Math.min(Date.parse(p.end), to) - Math.max(Date.parse(p.start), from)) / HOUR_MS;
  const live = positions.filter(p => p.phase !== 'used');
  const fixed = sumOf(live.filter(p => p.kind !== 'call'), inRange);
  const capped = sumOf(live.filter(p => p.kind === 'call'), inRange);
  const planned = PLANNED_GPUS * days * 24;
  return { days, planned, fixed, capped, open: Math.max(planned - fixed - capped, 0), excess: Math.max(fixed + capped - planned, 0), share: (fixed + capped) / planned };
}

// How far through its window each in-window position is.
export const windowProgress = (positions, asOf) => positions.filter(p => p.phase === 'window').map(p => {
  const [start, end] = [Date.parse(p.start), Date.parse(p.end)];
  return { id: p.id, gpu: p.gpu, count: p.count, share: Math.min(Math.max((noonOf(asOf) - start) / (end - start), 0), 1) };
});

// Saving against the index on finished windows (from the daily index) and on hours already used in open windows (today's index).
export function savingsToDate(positions, asOf) {
  const rows = positions.filter(p => p.phase === 'used' || p.phase === 'window').map(p => {
    if (p.phase === 'used') return { id: p.id, gpu: p.gpu, count: p.count, kind: p.kind, saving: p.used.saving, basis: 'Window finished · daily index' };
    const hours = p.count * Math.max(0, noonOf(asOf) - Date.parse(p.start)) / HOUR_MS;
    const gap = isOption(p) ? optionGap(p) : p.valuation.spot * p.valuation.basis - p.pricePerGpuHour;
    return { id: p.id, gpu: p.gpu, count: p.count, kind: p.kind, saving: (isOption(p) ? Math.max(gap, 0) : gap) * hours, basis: isOption(p) ? 'In window · hours used so far at the expected window average' : "In window · hours used so far at today's index" };
  });
  return { rows, total: sumOf(rows, r => r.saving) };
}

// Dated events in the next `days`: exercise and claim deadlines, windows opening and closing.
export function upcomingEvents(positions, asOf, days = 30) {
  const from = noonOf(asOf);
  const to = from + days * DAY_MS;
  const events = [];
  for (const p of positions.filter(x => x.phase !== 'used')) {
    const name = `${p.count.toLocaleString('en-US')} ${p.gpu} ${kindLabel(p.kind).toLowerCase()}`;
    if (p.phase === 'upcoming' && p.kind !== 'offtake' && p.status !== 'listed') {
      events.push({ at: deadlineOf(p), id: p.id, icon: 'clock', tone: 'warning', text: `${p.kind === 'call' ? 'Exercise' : 'Claim'} deadline · ${name}` });
    }
    if (p.phase === 'upcoming') events.push({ at: p.start, id: p.id, icon: 'circle-play', tone: 'info', text: `Window opens · ${name}` });
    events.push({ at: p.end, id: p.id, icon: 'flag', tone: 'neutral', text: `Window closes · ${name}` });
  }
  return events.filter(e => Date.parse(e.at) >= from && Date.parse(e.at) <= to).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// Premiums and fees by month of purchase. Fixed prices carry no Dodona fee; price caps carry a booking fee, and the platform share sits inside the premium.
export function billingMonths(positions, asOf) {
  const months = new Map();
  for (const p of positions.filter(x => x.kind === 'call' && x.boughtOn)) {
    const month = p.boughtOn.slice(0, 7);
    const row = months.get(month) || { month, premiums: 0, bookingFees: 0, positions: [] };
    months.set(month, { ...row, premiums: row.premiums + p.valuation.premiumPaid, bookingFees: row.bookingFees + BOOKING_FEE, positions: [...row.positions, p.id] });
  }
  const current = asOf.slice(0, 7);
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month)).map(row => ({
    ...row, id: `INV-${row.month.replace('-', '')}`, platformFee: row.premiums * PLATFORM_SHARE, total: row.premiums + row.bookingFees,
    status: row.month < current ? 'paid' : 'due',
  }));
}

export const monthLabel = month => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const pct = share => `${Math.round(share * 100)}%`;
const short = amount => (Math.abs(amount) >= 1000 ? `$${(amount / 1000).toFixed(amount >= 100000 ? 0 : 1)}k` : dollars(amount));
const positionName = p => `${p.count.toLocaleString('en-US')} ${p.gpu} ${kindLabel(p.kind).toLowerCase()}`;

// Bars carry their share in data-w / data-h; the browser turns it into a CSS custom property (no inline styles under the CSP).
export function coveragePanel(positions, asOf) {
  const bar = c => {
    const scale = Math.max(c.planned, c.fixed + c.capped);
    return `<div class="c-bar" role="img" aria-label="${escapeHtml(`${gpuHours(c.fixed)} fixed, ${gpuHours(c.capped)} capped, ${gpuHours(c.open)} open`)}"><i class="is-fixed" data-w="${(c.fixed / scale * 100).toFixed(1)}"></i><i class="is-cap" data-w="${(c.capped / scale * 100).toFixed(1)}"></i></div>`;
  };
  const rows = [30, 90].map(days => coverage(positions, asOf, days)).map(c => `<div class="c-cov-row">
      <div class="c-cov-top"><span>Next ${c.days} days</span><b>${pct(Math.min(c.share, 9.99))} covered</b></div>${bar(c)}
      <p class="fine">${escapeHtml(gpuHours(c.fixed + c.capped))} committed of ${escapeHtml(gpuHours(c.planned))} planned · ${c.excess
        ? escapeHtml(`${gpuHours(c.excess)} more than planned, worth listing`)
        : escapeHtml(`${gpuHours(c.open)} open to the index`)}</p></div>`).join('');
  const use = windowProgress(positions, asOf).map(w => `<div class="c-use-row"><span>${escapeHtml(w.id)} · ${escapeHtml(`${w.count} ${w.gpu}`)}</span><div class="c-bar" role="img" aria-label="${pct(w.share)} of the window used"><i data-w="${(w.share * 100).toFixed(1)}"></i></div><b class="d-num">${pct(w.share)}</b></div>`).join('');
  return `<div class="c-cov">${rows}
    <ul class="c-key"><li><i class="is-fixed"></i>Fixed price and offtake</li><li><i class="is-cap"></i>Price cap</li><li><i class="is-open"></i>Open</li></ul>
    ${use ? `<div class="c-use"><p class="eyebrow">In window now · share of the window used</p>${use}</div>` : ''}</div>
    <p class="c-note">${tag('demo')} Planned use assumes ${PLANNED_GPUS} GPUs running around the clock. Committed hours come from your positions.</p>`;
}

export function savingsPanel(positions, asOf, netValue) {
  const s = savingsToDate(positions, asOf);
  const rows = s.rows.map(r => `<li><span>${escapeHtml(`${r.id} · ${positionName(r)}`)}<small>${escapeHtml(r.basis)}</small></span><span class="${tone(r.saving)}">${escapeHtml(signedUsd(r.saving))}</span></li>`).join('');
  return `<p class="c-big-num ${tone(s.total)}">${escapeHtml(signedUsd(s.total))}</p>
    <p class="fine">Saved against the index on finished windows and on hours already used ${tag('model')}</p>
    <ul class="c-list">${rows || '<li><span>No windows have started yet.</span><span></span></li>'}</ul>
    <p class="c-note">Still to come on open positions: <b class="${tone(netValue)}">${escapeHtml(signedUsd(netValue))}</b> of Dodona Value. In-window figures use today's index, not each day's.</p>`;
}

export function upcomingPanel(positions, asOf) {
  const today = noonOf(asOf);
  const items = upcomingEvents(positions, asOf).map(e => {
    const d = new Date(e.at);
    const days = Math.max(0, Math.ceil((Date.parse(e.at) - today) / DAY_MS));
    return `<li><span class="c-day"><b>${d.getUTCDate()}</b><small>${MONTHS[d.getUTCMonth()]}</small></span>
      <span class="c-date-text tone-${e.tone}">${icon(e.icon)}<span>${escapeHtml(e.text)}<small>${escapeHtml(`${d.toISOString().slice(11, 16)} UTC · in ${days} day${days === 1 ? '' : 's'}`)}</small></span></span>
      <a class="btn btn-sm btn-icon" href="#positions/${escapeHtml(e.id)}" aria-label="${escapeHtml(`Open ${e.id}`)}">${icon('arrow-right')}</a></li>`;
  }).join('');
  return items || '<li class="d-muted">Nothing due in the next 30 days.</li>';
}

export function billingPanel(positions, asOf) {
  const invoices = billingMonths(positions, asOf);
  const end = new Date(noonOf(asOf));
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7));
  const byMonth = new Map(invoices.map(row => [row.month, row]));
  const top = Math.max(1, ...invoices.map(row => row.total));
  const bars = months.map(m => { const total = byMonth.get(m)?.total || 0; return `<div><span>${total ? escapeHtml(short(total)) : ''}</span><i data-h="${(total / top * 100).toFixed(1)}"></i></div>`; }).join('');
  const rows = invoices.map(row => `<tr><th scope="row">${escapeHtml(row.id)}</th><td>${escapeHtml(monthLabel(row.month))}</td><td class="r d-num">${escapeHtml(dollars(row.premiums))}</td><td class="r d-num">${escapeHtml(dollars(row.platformFee))}</td><td class="r d-num">${escapeHtml(dollars(row.bookingFees))}</td><td class="r d-num">${escapeHtml(dollars(row.total))}</td>
    <td>${row.status === 'paid' ? pill('circle-check', 'success', 'Paid') : pill('clock', 'warning', 'Due')}</td>
    <td><button type="button" class="btn btn-sm btn-icon" data-toast="Demo: invoice ${escapeHtml(row.id)} is not generated. Nothing was downloaded." aria-label="${escapeHtml(`Download ${row.id}`)}">${icon('download')}</button></td></tr>`).join('');
  return `<div class="c-billing"><div><p class="eyebrow">Premiums and fees by month</p><div class="c-bars" role="img" aria-label="Monthly totals for the last six months">${bars}</div>
      <div class="c-bars-x">${months.map(m => `<span>${MONTHS[Number(m.slice(5, 7)) - 1]}</span>`).join('')}</div></div>
    <div class="d-scroll"><table class="d-table"><caption class="visually-hidden">Invoices</caption><thead><tr><th scope="col">Invoice</th><th scope="col">Month</th><th scope="col" class="r">Premiums</th><th scope="col" class="r">of which platform fee</th><th scope="col" class="r">Booking fees</th><th scope="col" class="r">Total</th><th scope="col">Status</th><th scope="col"><span class="visually-hidden">Download</span></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="d-muted">No premiums or fees yet.</td></tr>'}</tbody></table></div></div>
    <p class="c-note">${tag('demo')} Price caps carry a ${dollars(BOOKING_FEE)} booking fee, and Dodona's platform fee is ${Math.round(PLATFORM_SHARE * 100)}% of the cap premium, shown inside it. Fixed prices carry no Dodona fee. Paid by ACH, no card fees; Dodona never holds funds.</p>`;
}

// Severity icon per alert: move arrow, deadline clock, offer, warning triangle, error, info circle.
export function alertLook(alert) {
  const toneOf = { gain: 'success', loss: 'error', warn: 'warning', offer: 'accent', info: 'info' }[alert.severity] || 'neutral';
  if (alert.kind === 'Index move') return [alert.severity === 'loss' ? 'trending-down' : 'trending-up', toneOf];
  if (alert.kind === 'Deadline') return ['clock', toneOf];
  if (alert.kind === 'Offer') return ['message-square', toneOf];
  return [{ loss: 'circle-x', warn: 'triangle-alert', gain: 'circle-check' }[alert.severity] || 'info', toneOf];
}

export function kpiRows(kpis) {
  const next = kpis.nextDeadline;
  const rows = [
    ['Remaining committed cost', usd(kpis.remainingCommittedCost), `Fixed prices and offtakes · plus ${usd(kpis.optionalAtStrike)} optional at cap prices`, 'sample'],
    ['Premiums paid', usd(kpis.premiumsPaid), `${kpis.callCount} price caps · paid to the provider`, 'model'],
    ['GPU-hours remaining', gpuHours(kpis.gpuHoursRemaining), `${kpis.openPositions} open positions`, 'sample'],
    ['Net Dodona Value', signedUsd(kpis.netValue), `${signedUsd(kpis.change.d7)} this week`, 'model'],
    ['Average, cents on the dollar', cents(kpis.centsOnDollar), 'Fixed prices and offtakes · above 100 = below market', 'model'],
    ['Next deadline', next ? dayMonth(next.date) : 'None', next ? `${next.action} ${next.label} · ${next.days} days` : 'Nothing to claim'],
  ];
  return rows.map(([term, value, note, kind]) => `<div class="d-kpi"><dt>${escapeHtml(term)}${kind ? ' ' + tag(kind) : ''}</dt><dd>${escapeHtml(value)}<small>${escapeHtml(note)}</small></dd></div>`).join('');
}

export const changeChips = change => [['1D', change.d1], ['7D', change.d7], ['30D', change.d30]]
  .map(([k, v]) => `<span class="d-chip"><b>${k}</b><span class="${tone(v)}">${escapeHtml(signedUsd(v))}</span></span>`).join('');

export function pricesLine(prices, methodVersion) {
  const state = prices.live ? tag('live') : '<span class="tag">cached</span>';
  return `Ornn daily index as of ${escapeHtml(shortDate(prices.asOf))} ${state} · method ${escapeHtml(methodVersion)}`;
}

/* ---------- chart ranges ---------- */
const SHORT_RANGE_POINTS = 45;
export const RANGES = [['1d', '1D'], ['1w', '1W'], ['1m', '1M'], ['1y', '1Y'], ['ytd', 'YTD'], ['all', 'All']];
const RANGE_WORDS = { '1d': 'the last day', '1w': 'the last week', '1m': 'the last month', '1y': 'the last year', ytd: 'this year', all: 'all history' };
const dayMs = date => Date.parse(date.slice(0, 10) + 'T00:00:00Z');

// Start of a range, counted back from the last point's date (UTC days, calendar months and years).
function rangeStart(range, lastDate) {
  const d = new Date(dayMs(lastDate));
  if (range === '1d') d.setUTCDate(d.getUTCDate() - 1);
  else if (range === '1w') d.setUTCDate(d.getUTCDate() - 7);
  else if (range === '1m') d.setUTCMonth(d.getUTCMonth() - 1);
  else if (range === '1y') d.setUTCFullYear(d.getUTCFullYear() - 1);
  else if (range === 'ytd') return Date.UTC(d.getUTCFullYear(), 0, 1);
  else return -Infinity;
  return d.getTime();
}

/**
 * Points of a daily history inside a range ending at its last point, the change over them, and whether
 * the history starts after the range would (then the caption says "since" the first point).
 */
export function historyRange(history, range, key = 'value') {
  const words = RANGE_WORDS[range] || RANGE_WORDS.all;
  if (!history?.length) return { points: [], change: 0, since: null, partial: false, words };
  const from = rangeStart(range, history.at(-1).date);
  let points = history.filter(p => dayMs(p.date) >= from);
  if (points.length < 2) points = history.slice(-2);
  const partial = range !== 'all' && dayMs(history[0].date) > from;
  return { points, change: points.at(-1)[key] - points[0][key], since: points[0].date, partial, words };
}

export const rangeButtons = (selected, scope) => RANGES.map(([value, label]) => `<button type="button" data-range="${value}" data-scope="${escapeHtml(scope)}" aria-pressed="${value === selected}">${label}</button>`).join('');

export function rangeCaption(r) {
  if (!r.since) return 'No history yet.';
  return r.partial ? `History starts ${shortDate(r.since)}, so this shows everything since then.` : `Change over ${r.words}, since ${shortDate(r.since)}.`;
}

export const rangeChip = (label, value) => `<span class="d-chip"><b>${escapeHtml(label)}</b><span class="${tone(value)}">${escapeHtml(signedUsd(value))}</span></span>`;

/* ---------- what-if payoff on the window average ---------- */

// Result at window average `avg`. Cap: payoff max(avg − K, 0) × hours, never below zero; net subtracts the premium paid
// and goes down to −premium. Floor: the mirror, max(K − avg, 0). Fixed price: saving (avg − K) × hours, negative below K.
export function payoffAt(kind, avg, { strike, hours, premiumPaid = 0 }) {
  if (kind === 'lock' || kind === 'offtake') { const saving = (avg - strike) * hours; return { payoff: saving, net: saving }; }
  const gap = kind === 'put' ? Math.max(strike - avg, 0) : Math.max(avg - strike, 0);
  return { payoff: gap * hours, net: gap * hours - premiumPaid };
}

export const payoffBreakEven = (kind, strike, premiumPerHour = 0) => (kind === 'put' ? strike - premiumPerHour : kind === 'call' ? strike + premiumPerHour : strike);

function payoffLabel(kind, { strike, premiumPaid, be, lo, hi, first, last }) {
  if (kind === 'lock' || kind === 'offtake') return `Saving against the window average, from ${usd(first)} at ${perHour(lo)} to ${usd(last)} at ${perHour(hi)}; negative below the fixed price ${perHour(strike)}.`;
  return `${kind === 'put' ? 'Floor' : 'Cap'} payoff, never below zero, and the net result after the ${usd(premiumPaid)} premium, down to ${usd(-premiumPaid)}. Break-even at a window average of ${perHour(be)}.`;
}

// Payoff and net lines against the window average, the break-even marked, the current slider value as a cross-hair.
export function payoffChart({ kind, strike, hours, premiumPaid, premiumPerHour, current, lo, hi, width = 560, height = 210 }) {
  const fixed = kind === 'lock' || kind === 'offtake';
  const [left, right, top, bottom] = [64, 14, 14, 38];
  const pts = Array.from({ length: 41 }, (_, i) => lo + (hi - lo) * i / 40).map(avg => ({ avg, ...payoffAt(kind, avg, { strike, hours, premiumPaid }) }));
  const ticks = niceTicks(Math.min(0, ...pts.map(p => p.net)), Math.max(0, ...pts.map(p => p.payoff)));
  const [yLo, yHi] = [ticks[0], ticks.at(-1) === ticks[0] ? ticks[0] + 1 : ticks.at(-1)];
  const x = avg => left + (avg - lo) / (hi - lo) * (width - left - right);
  const y = v => top + (yHi - v) / (yHi - yLo) * (height - top - bottom);
  const path = key => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.avg).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const grid = ticks.map(t => `<line class="d-grid" x1="${left}" x2="${width - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="d-axis" x="${left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(usd(t))}</text>`).join('');
  const xTicks = [lo, strike, hi].map(v => `<text class="d-axis" x="${x(v).toFixed(1)}" y="${height - 22}" text-anchor="middle">${escapeHtml(perHour(v))}</text>`).join('');
  const be = payoffBreakEven(kind, strike, premiumPerHour);
  const beLine = be >= lo && be <= hi ? `<line class="p-be" x1="${x(be).toFixed(1)}" x2="${x(be).toFixed(1)}" y1="${top}" y2="${height - bottom}"/><text class="p-be-lbl" x="${(x(be) + 4).toFixed(1)}" y="${top + 10}">break-even ${escapeHtml(perHour(be))}</text>` : '';
  const now = payoffAt(kind, current, { strike, hours, premiumPaid });
  const lines = fixed ? [['net', 'is-payoff']] : [['payoff', 'is-payoff'], ['net', 'is-net']];
  const lossZone = yLo < 0 ? `<rect class="p-loss-zone" x="${left}" y="${y(0).toFixed(1)}" width="${width - left - right}" height="${(y(yLo) - y(0)).toFixed(1)}"/>` : '';
  const label = payoffLabel(kind, { strike, premiumPaid, be, lo, hi, first: pts[0].net, last: pts.at(-1).net });
  return `<svg class="p-payoff" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">
    ${lossZone}${grid}<line class="d-zero" x1="${left}" x2="${width - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${xTicks}
    <text class="d-axis" x="${((left + width - right) / 2).toFixed(1)}" y="${height - 4}" text-anchor="middle">window average, $ per GPU-hour</text>
    ${beLine}${lines.map(([key, cls]) => `<path class="d-line ${cls}" d="${path(key)}"/>`).join('')}
    <line class="p-cur" x1="${x(current).toFixed(1)}" x2="${x(current).toFixed(1)}" y1="${top}" y2="${height - bottom}"/>
    ${lines.map(([key, cls]) => `<circle class="p-cur-dot ${cls}" cx="${x(current).toFixed(1)}" cy="${y(now[key]).toFixed(1)}" r="4.5"/>`).join('')}
  </svg>`;
}

/* ---------- charts ---------- */

function niceTicks(min, max, count = 4) {
  const raw = (max - min || Math.abs(max) || 1) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * power).find(s => s >= raw);
  const ticks = [];
  for (let t = Math.floor(min / step) * step; t <= max + step / 2; t += step) ticks.push(t);
  return ticks;
}

// One-axis line chart. `lines` = [{ key, cls, label }]; optional `band` = { upper, lower } fills between two lines,
// or `zeroArea` fills from the first line to zero. Geometry goes in data attributes for the browser's hover layer.
export function lineChart(points, { lines, band, zeroArea = false, label, width = 720, height = 240, includeZero = false }) {
  if (!points.length) return '<p class="d-muted">No history yet.</p>';
  const [left, right, top, bottom] = [64, 12, 12, 26];
  const values = points.flatMap(p => lines.map(l => p[l.key]));
  const ticks = niceTicks(Math.min(...values, ...(includeZero ? [0] : [])), Math.max(...values, ...(includeZero ? [0] : [])));
  const [lo, hi] = [ticks[0], ticks.at(-1) === ticks[0] ? ticks[0] + 1 : ticks.at(-1)];
  const x = i => left + (i / Math.max(points.length - 1, 1)) * (width - left - right);
  const y = v => top + (hi - v) / (hi - lo) * (height - top - bottom);
  const path = key => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const grid = ticks.map(t => `<line class="d-grid" x1="${left}" x2="${width - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="d-axis" x="${left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(usd(t))}</text>`).join('');
  // Month starts on long ranges; on short ones (a week or a month) the first, middle and last day.
  const firsts = points.map((p, i) => [p, i]).filter(([p]) => p.date.endsWith('-01'));
  const marks = points.length > SHORT_RANGE_POINTS && firsts.length ? firsts.map(([p, i]) => [MONTHS[Number(p.date.slice(5, 7)) - 1], i])
    : [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].map(i => [dayMonth(points[i].date), i]);
  const months = marks.map(([text, i]) => `<text class="d-axis" x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 && points.length > 1 ? 'start' : i === points.length - 1 && i > 0 ? 'end' : 'middle'}">${escapeHtml(text)}</text>`).join('');
  let fill = '';
  if (band) {
    const upper = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[band.upper]).toFixed(1)}`).join(' ');
    const lower = points.map((p, i) => [p, i]).reverse().map(([p, i]) => `L${x(i).toFixed(1)} ${y(p[band.lower]).toFixed(1)}`).join(' ');
    fill = `<path class="d-band" d="${upper} ${lower}Z"/>`;
  } else if (zeroArea) {
    const key = lines[0].key;
    fill = `<path class="d-band ${points.at(-1)[key] >= 0 ? 'is-gain' : 'is-loss'}" d="${path(key)} L${x(points.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z"/><line class="d-zero" x1="${left}" x2="${width - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>`;
  }
  const last = points.length - 1;
  const ends = lines.map(l => `<circle class="d-end ${l.cls}" cx="${x(last).toFixed(1)}" cy="${y(points[last][l.key]).toFixed(1)}" r="4"/>`).join('');
  return `<svg class="d-chart" viewBox="0 0 ${width} ${height}" role="img" tabindex="0" aria-label="${escapeHtml(label)}"
    data-left="${left}" data-right="${width - right}" data-top="${top}" data-bottom="${height - bottom}" data-lo="${lo}" data-hi="${hi}">
    ${grid}${months}${fill}${lines.map(l => `<path class="d-line ${l.cls}" d="${path(l.key)}"/>`).join('')}${ends}
    <g class="d-cross" visibility="hidden"><line class="d-cross-line" y1="${top}" y2="${height - bottom}"/>${lines.map(l => `<circle class="d-cross-dot ${l.cls}" r="4.5" data-key="${l.key}"/>`).join('')}</g>
    <rect class="d-hit" x="${left}" y="0" width="${width - left - right}" height="${height}"/>
  </svg>`;
}

export function portfolioChart(history) {
  const last = history.at(-1);
  return lineChart(history, {
    lines: [{ key: 'marketValue', cls: 'is-market', label: 'Market value of your hours' }, { key: 'committedCost', cls: 'is-cost', label: 'Committed cost' }],
    band: { upper: 'marketValue', lower: 'committedCost' },
    label: `Last ${history.length} days. Market value of your remaining hours ${usd(last?.marketValue)} against committed cost ${usd(last?.committedCost)} today; the gap is your Dodona Value.`,
  });
}

export function positionChart(position) {
  const last = position.history.at(-1);
  return lineChart(position.history, {
    lines: [{ key: 'value', cls: 'is-market', label: 'Dodona Value' }], zeroArea: true, includeZero: true, height: 190,
    label: `Dodona Value of ${position.id} over the last ${position.history.length} days, ${signedUsd(last?.value)} today.`,
  });
}
