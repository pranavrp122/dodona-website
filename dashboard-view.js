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
const KIND_LABEL = { lock: 'Fixed price', call: 'Price cap', offtake: 'Offtake' };
const MINUS = '−';
const ARROW = '<span aria-hidden="true">→</span>';

/* ---------- formatting ---------- */
// Provenance tag beside a number: live (Ornn index), model (Dodona Value and arithmetic), sample (illustrative data).
export const tag = kind => `<span class="tag d-tag-${kind}">${kind}</span>`;
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

// Exercising a call at a given index: deliver at the cap, or take delivery and resell the block on the board.
export function exerciseQuote(position, index) {
  const v = position.valuation;
  const K = position.pricePerGpuHour;
  const hours = v.remainingHours;
  const regional = index * v.basis;
  const bid = Math.max(regional * (position.utilisation ?? 1) - RESALE_SPREAD, 0);
  const gross = Math.max(bid - K, 0) * hours;
  const fee = gross * RESALE_FEE;
  return { hours, regional, pay: K * hours, atIndex: regional * hours, saving: (regional - K) * hours, bid, gross, fee, net: gross - fee };
}

// Intrinsic value of a call if the index were `index` today: max(F·b − K, 0) × hours × discount.
export function intrinsicAt(position, index) {
  const v = position.valuation;
  const forward = index * v.forwardFactor * v.basis;
  return Math.max(forward - position.pricePerGpuHour, 0) * v.remainingHours * v.discountFactor;
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

function moneyLine(position) {
  const m = position.valuation.moneyness;
  return m > 0
    ? `<span class="is-gain">+${perHour(m)} in the money</span>`
    : `<span class="d-oom">${MINUS}${perHour(-m)} · not needed yet</span>`;
}

export function ledgerRow(position, { selected = false, today } = {}) {
  const v = position.valuation;
  const call = position.kind === 'call';
  const used = position.phase === 'used';
  const status = statusText(position, today);
  const listedLink = position.status === 'listed' ? ` <a class="d-board-link" href="/contracts">On the board ${ARROW}</a>` : '';
  const valueCell = used
    ? '<td class="r d-num d-muted">n/a<span class="d-sub">window used</span></td><td class="r d-num d-muted">—</td>'
    : `<td class="r d-num ${call ? (v.moneyness > 0 ? 'is-gain' : 'd-oom') : tone(v.value)}">${signedUsd(v.value)}<span class="d-sub">${signedUsd(v.low)} to ${signedUsd(v.high)}</span></td>
      <td class="r d-num ${call ? 'd-oom' : tone(v.centsOnDollar - 100)}">${call ? '—<span class="d-sub">price cap</span>' : cents(v.centsOnDollar)}</td>`;
  return `<tr data-row="${escapeHtml(position.id)}" tabindex="0" aria-selected="${selected}">
    <td><div class="d-pos"><span class="d-gpu d-gpu-${escapeHtml(position.gpu)}">${escapeHtml(position.gpu)}</span><div>
      <a class="d-pos-l" href="#positions/${escapeHtml(position.id)}">${escapeHtml(kindLabel(position.kind))} · ${escapeHtml(position.count.toLocaleString('en-US'))} ${escapeHtml(position.gpu)} · ${escapeHtml(windowLabel(position.start, position.end))}</a>
      <span class="d-pos-s">${escapeHtml(position.id)} · ${escapeHtml(position.region)} · ${escapeHtml(position.provider.label)}</span></div></div></td>
    <td class="r d-num">${used ? '—' : escapeHtml(gpuHours(v.remainingHours))}</td>
    <td class="r d-num">${perHour(position.pricePerGpuHour)}${call ? ' cap' : ''}<span class="d-sub">index ${perHour(v.spot * v.basis)}</span>${call && !used ? `<span class="d-sub">${moneyLine(position)}</span>` : ''}</td>
    ${valueCell}
    <td><span class="d-status st-${status.cls}">${escapeHtml(status.text)}</span>${listedLink}${position.warning ? `<span class="d-warn-pill">${escapeHtml(position.warning)}</span>` : ''}</td>
  </tr>`;
}

export const ledgerRows = (portfolio, selectedId) =>
  portfolio.positions.map(p => ledgerRow(p, { selected: p.id === selectedId, today: portfolio.asOf })).join('');

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
  const months = points.map((p, i) => [p, i]).filter(([p]) => p.date.endsWith('-01'))
    .map(([p, i]) => `<text class="d-axis" x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="middle">${MONTHS[Number(p.date.slice(5, 7)) - 1]}</text>`).join('');
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
