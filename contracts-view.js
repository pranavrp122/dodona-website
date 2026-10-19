/** Shared HTML renderers for the contract values pages; imported by the server and by the browser scripts. */

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REGIONS = ['US East', 'US West', 'Europe'];
const PIN_SPOTS = { 'US West': [118, 178], 'US East': [292, 166], 'Europe': [592, 132] };
const ARROW = '<span aria-hidden="true">→</span>';

export function usd(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
export const perHour = value => (value == null ? '—' : `$${value.toFixed(2)}`);
export const gpuHours = h => (h >= 1e6 ? `${(h / 1e6).toFixed(2)}M` : h >= 1e3 ? `${Math.round(h / 1e3)}K` : String(Math.round(h)));
export const cents = c => (c == null || !Number.isFinite(c) ? '—' : `${c.toFixed(1)}¢`);
export const centsTone = c => (c == null ? 'is-flat' : c >= 100 ? 'is-up' : 'is-down');
const percent = x => `${(x * 100).toFixed(1)}%`;
const signedPerHour = x => (x == null ? '—' : `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`);

export function shortDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
const lastDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
const termLabel = type => (type === 'usage-with-cancel' ? 'Usage with cancel' : 'Take-or-pay');

function statusPill(contract) {
  return contract.status === 'listed'
    ? `<span class="c-pill is-listed">Listed · asking ${escapeHtml(contract.askingCents)}¢</span>`
    : '<span class="c-pill">Held</span>';
}

export function pricesLine(prices, methodVersion) {
  const state = prices.live ? '<span class="c-live is-live">Live</span>' : '<span class="c-live">Cached</span>';
  return `Ornn GPU index as of ${escapeHtml(shortDate(prices.asOf))} ${state} · method ${escapeHtml(methodVersion)}`;
}

export function kpis(board) {
  const tiles = [
    ['Contracts tracked', String(board.kpis.contractsTracked), 'Sample book'],
    ['Remaining GPU-hours', gpuHours(board.kpis.remainingHours), 'Across all windows'],
    ['Avg. cents on the dollar', cents(board.kpis.centsOnDollar), 'Weighted by remaining cost'],
    ['Prices as of', shortDate(board.prices.asOf), board.prices.live ? 'Live Ornn index' : 'Cached Ornn index'],
  ];
  return tiles.map(([label, value, note]) => `<div class="c-kpi"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd><p>${escapeHtml(note)}</p></div>`).join('');
}

export function regionMap(board, active) {
  const maxHours = Math.max(...board.regions.map(r => r.remainingHours), 1);
  const pins = board.regions.map(r => {
    const [x, y] = PIN_SPOTS[r.region];
    const radius = 9 + 22 * Math.sqrt(r.remainingHours / maxHours);
    const label = `${r.region}: ${r.contracts} contracts, ${gpuHours(r.remainingHours)} GPU-hours, ${cents(r.centsOnDollar)} on the dollar. Show only ${r.region}.`;
    return `<a class="map-pin ${centsTone(r.centsOnDollar)}${active === r.region ? ' is-active' : ''}" href="/contracts?region=${encodeURIComponent(r.region)}" data-region-filter="${escapeHtml(r.region)}" aria-label="${escapeHtml(label)}">
      <circle class="map-pin-halo" cx="${x}" cy="${y}" r="${(radius + 7).toFixed(1)}"/>
      <circle class="map-pin-dot" cx="${x}" cy="${y}" r="${radius.toFixed(1)}"/>
      <text class="map-pin-name" x="${x}" y="${(y - radius - 22).toFixed(1)}" text-anchor="middle">${escapeHtml(r.region)}</text>
      <text class="map-pin-cents" x="${x}" y="${(y - radius - 6).toFixed(1)}" text-anchor="middle">${escapeHtml(cents(r.centsOnDollar))} · ${escapeHtml(gpuHours(r.remainingHours))} GPU-h</text>
    </a>`;
  }).join('');
  return `<svg class="region-map${active ? ' has-active' : ''}" viewBox="0 0 720 330" role="group" aria-label="Schematic map of sample contracts by region. Pin size shows remaining GPU-hours.">
    <defs><pattern id="map-dots" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" class="map-dot"/></pattern></defs>
    <rect class="map-sea" x="0" y="0" width="720" height="330" rx="20"/>
    <rect x="0" y="0" width="720" height="330" rx="20" fill="url(#map-dots)"/>
    <path class="map-land" d="M44 112 92 74 168 58 246 56 318 74 362 108 356 140 330 168 318 204 286 226 250 236 226 270 204 300 190 290 196 258 168 238 128 230 94 206 66 172 50 140Z"/>
    <path class="map-land" d="M318 34 372 26 404 40 396 66 360 80 330 66Z"/>
    <path class="map-land" d="M548 92 586 72 636 70 684 88 700 118 680 146 652 168 616 186 580 184 560 166 572 146 548 132Z"/>
    <path class="map-land" d="M520 98 536 86 546 104 538 122 522 120Z"/>
    <text class="map-sea-label" x="440" y="250" text-anchor="middle">Atlantic</text>
    ${pins}
  </svg>`;
}

export function regionFilters(active) {
  const options = [['All regions', null], ...REGIONS.map(r => [r, r])];
  return options.map(([label, region]) => {
    const href = region ? `/contracts?region=${encodeURIComponent(region)}` : '/contracts';
    const current = (active || null) === region;
    return `<a class="c-filter${current ? ' is-active' : ''}" href="${href}" data-region-filter="${escapeHtml(region || '')}"${current ? ' aria-current="true"' : ''}>${escapeHtml(label)}</a>`;
  }).join('');
}

export function boardRows(board, active) {
  return board.contracts.map(c => {
    const v = c.valuation;
    const hidden = active && c.region !== active ? ' hidden' : '';
    return `<li class="c-row" data-region="${escapeHtml(c.region)}"${hidden}>
      <div class="c-row-main">
        <p class="c-row-meta">${escapeHtml(c.gpu)} · ${escapeHtml(c.config)} · ${escapeHtml(termLabel(c.termType))} · ${escapeHtml(c.provider.label)}</p>
        <h3><a href="/contracts/${escapeHtml(c.id)}">${escapeHtml(c.label)}</a></h3>
        <p class="c-row-terms">Contract ${perHour(c.pricePerGpuHour)} vs index ${perHour(v.spot)} per GPU-hour · ${gpuHours(v.remainingHours)} GPU-hours left</p>
      </div>
      <div class="c-row-value"><span class="c-k">Dodona Value</span><strong>${usd(v.value)}</strong><span class="c-row-range">${usd(v.low)} to ${usd(v.high)}</span></div>
      <div class="c-row-cents ${centsTone(v.centsOnDollar)}"><strong>${cents(v.centsOnDollar)}</strong><span>on the dollar</span></div>
      <div class="c-row-status">${statusPill(c)}<a class="text-link" href="/contracts/${escapeHtml(c.id)}">View ${ARROW}</a></div>
    </li>`;
  }).join('');
}

export function fleetRows(board) {
  return board.fleets.map(f => {
    const m = f.mark;
    return `<tr>
      <th scope="row">${escapeHtml(f.label)}</th>
      <td>${escapeHtml(f.units.toLocaleString('en-US'))} ${escapeHtml(f.gpu)}</td>
      <td>${Math.round(m.remainingLifeMonths)} mo</td>
      <td>${usd(m.fleetValue)}</td>
      <td>${usd(m.loanBalance)}</td>
      <td>${m.ltv == null || !Number.isFinite(m.ltv) ? '—' : percent(m.ltv)}</td>
      <td><span class="c-pill is-${escapeHtml(m.ltvStatus)}">${escapeHtml(m.ltvStatus === 'ok' ? 'OK' : m.ltvStatus === 'watch' ? 'Watch' : 'Breach')}</span></td>
    </tr>`;
  }).join('');
}

export function contractSummary(detail) {
  const c = detail.contract;
  const v = c.valuation;
  return `<p class="eyebrow">Dodona Value · Sample contract</p>
    <p class="c-big ${centsTone(v.centsOnDollar)}">${usd(v.value)}</p>
    <p class="c-range">Range ${usd(v.low)} to ${usd(v.high)} · <strong class="${centsTone(v.centsOnDollar)}">${cents(v.centsOnDollar)}</strong> on the dollar · ${statusPill(c)}</p>
    <p class="fine">Value to the holder of the remaining ${gpuHours(v.remainingHours)} GPU-hours, as of ${escapeHtml(shortDate(detail.today))}. ${pricesLine(detail.prices, detail.methodVersion)}.</p>`;
}

export function valueChart(history) {
  if (!history.length) return '<p class="fine">No value history yet.</p>';
  const [w, h, left, right, top, bottom] = [720, 240, 70, 16, 18, 30];
  const values = history.map(p => p.value);
  let [min, max] = [Math.min(...values, 0), Math.max(...values, 0)];
  if (max === min) max = min + 1;
  const x = i => left + (i / Math.max(history.length - 1, 1)) * (w - left - right);
  const y = value => top + (max - value) / (max - min) * (h - top - bottom);
  const line = history.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(history.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)}Z`;
  const last = history.at(-1);
  const label = `Dodona Value over the last ${history.length} days, from ${usd(history[0].value)} on ${shortDate(history[0].date)} to ${usd(last.value)} on ${shortDate(last.date)}.`;
  return `<svg class="value-chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeHtml(label)}">
    <line class="chart-grid" x1="${left}" x2="${w - right}" y1="${y(max).toFixed(1)}" y2="${y(max).toFixed(1)}"/>
    <line class="chart-grid" x1="${left}" x2="${w - right}" y1="${y(min).toFixed(1)}" y2="${y(min).toFixed(1)}"/>
    <line class="chart-zero" x1="${left}" x2="${w - right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
    <path class="chart-area" d="${area}"/>
    <path class="chart-line" d="${line}"/>
    <circle class="chart-dot" cx="${x(history.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="5"/>
    <text class="chart-label" x="${left - 10}" y="${(y(max) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(usd(max))}</text>
    <text class="chart-label" x="${left - 10}" y="${(y(min) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(usd(min))}</text>
    <text class="chart-label" x="${left - 10}" y="${(y(0) + 4).toFixed(1)}" text-anchor="end">$0</text>
    <text class="chart-label" x="${left}" y="${h - 8}">${escapeHtml(shortDate(history[0].date))}</text>
    <text class="chart-label" x="${w - right}" y="${h - 8}" text-anchor="end">${escapeHtml(shortDate(last.date))}</text>
  </svg>`;
}

const termRow = (term, value, note = '') => `<div><dt>${escapeHtml(term)}${note ? `<br><span>${escapeHtml(note)}</span>` : ''}</dt><dd>${escapeHtml(value)}</dd></div>`;

export function termSheet(detail) {
  const c = detail.contract;
  const v = c.valuation;
  const gap = v.forwardAvg == null ? null : v.forwardAvg - c.pricePerGpuHour;
  const contractSide = [
    termRow('GPU', c.gpu),
    termRow('Count', c.count.toLocaleString('en-US')),
    termRow('Configuration', c.config),
    termRow('Region', c.region),
    termRow('Window', `${shortDate(c.start)} – ${shortDate(lastDay(c.end))}`),
    termRow('Remaining GPU-hours', gpuHours(v.remainingHours), `${usd(v.remainingCost)} still to pay`),
    termRow('Contract price', `${perHour(c.pricePerGpuHour)}/h`),
    termRow('Term type', termLabel(c.termType)),
  ].join('');
  const marketSide = [
    termRow('Index today', `${perHour(v.spot)}/h`, `Ornn ${c.gpu} index`),
    termRow('Forward average', `${perHour(v.forwardAvg)}/h`, `After ×${v.inputs.basis.toFixed(2)} region and config basis`),
    termRow('Price gap', `${signedPerHour(gap)}/h`, 'Forward average minus contract price'),
    termRow('Volatility', percent(v.vol), 'Annualised, trailing window'),
    termRow('Provider', `${c.provider.creditTier} · ${c.provider.bondPriceCents}c bonds`, c.provider.label),
    termRow('Default hazard', `${percent(v.hazard)}/yr`, 'Implied by the bond price'),
    termRow('Discount rate', `${percent(v.inputs.discountRate)}/yr`),
  ].join('');
  return `<div class="example-terms c-terms"><h3>Contract</h3><dl>${contractSide}</dl></div>
    <div class="example-terms c-terms"><h3>Market and credit</h3><dl>${marketSide}</dl></div>`;
}

export function contractActions(detail) {
  const c = detail.contract;
  const v = c.valuation;
  const listed = c.status === 'listed';
  const [button, field, submit] = listed
    ? ['Make an offer', 'Your offer', 'Preview offer']
    : ['List for sale', 'Asking price', 'Preview listing'];
  const valueCents = v.centsOnDollar ?? 100;
  return `<details class="c-action">
    <summary class="btn btn-ink btn-sm">${button}</summary>
    <form class="c-form" data-kind="${listed ? 'offer' : 'list'}" data-remaining-cost="${v.remainingCost.toFixed(2)}" data-value-cents="${valueCents.toFixed(1)}" novalidate>
      <div class="field"><label for="c-cents">${field} <span class="optional">cents on the dollar</span></label>
        <input id="c-cents" name="cents" type="number" inputmode="decimal" min="1" max="200" step="0.5" value="${Math.round(valueCents)}" required></div>
      <button class="btn btn-ink btn-sm" type="submit">${submit}</button>
      <p class="c-confirm" role="status" aria-live="polite"></p>
    </form>
  </details>
  <p class="fine c-action-note">Demo only. Nothing is listed, offered, sent or stored. Dodona never holds funds.</p>`;
}

// Plain-language result of a listing or offer at a cents-on-the-dollar price.
export function demoConfirmation(kind, askedCents, remainingCost, valueCents) {
  const payment = Math.abs(askedCents - 100) / 100 * remainingCost;
  const who = askedCents >= 100
    ? `the buyer would pay the seller about ${usd(payment)}`
    : `the seller would pay the buyer about ${usd(payment)}`;
  const action = kind === 'offer' ? 'An offer' : 'A listing';
  return `Demo confirmation: nothing was ${kind === 'offer' ? 'sent' : 'listed'}. ${action} at ${askedCents.toFixed(1)}¢ means ${who} to take over the remaining ${usd(remainingCost)} commitment. Today's Dodona Value is ${valueCents.toFixed(1)}¢.`;
}
