/** Console charts in the browser: the hover and keyboard read-out on line charts, and the what-if payoff on the window average. */
import * as v from '/dashboard-view.js';

const esc = v.escapeHtml;
const SLIDER_STEP = 0.01;

/* ---------- chart hover layer ---------- */
export function attachHover(wrap, points, describe) {
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

/* ---------- what-if on the window average ---------- */
const round05 = value => Math.max(0.05, Math.round(value / 0.05) * 0.05);
const lockLike = kind => kind === 'lock' || kind === 'offtake';

/** Inputs for one position's payoff: strike, hours, premium paid, the expected window average and a slider range around them. */
export function whatIfModel(p) {
  const val = p.valuation;
  const hours = lockLike(p.kind) ? val.remainingHours : val.totalHours ?? val.remainingHours;
  const strike = p.pricePerGpuHour;
  const expected = Number.isFinite(val.forwardAvg) ? val.forwardAvg : strike;
  return {
    kind: p.kind, strike, hours, expected,
    premiumPerHour: p.premiumPerGpuHour || 0,
    premiumPaid: lockLike(p.kind) ? 0 : val.premiumPaid ?? (p.premiumPerGpuHour || 0) * hours,
    lo: round05(Math.min(strike, expected) * 0.5), hi: round05(Math.max(strike, expected) * 1.5),
  };
}

function outputs(m, avg) {
  const r = v.payoffAt(m.kind, avg, m);
  const atExpected = v.payoffAt(m.kind, m.expected, m).net;
  if (lockLike(m.kind)) {
    return [['Saving against the window average', v.signedUsd(r.net), 'Negative when the average ends below the fixed price'],
      ['Compute bill at the fixed price', v.usd(m.strike * m.hours), 'Whatever the index does'],
      ['At the expected average', v.signedUsd(atExpected), `${v.perHour(m.expected)}/GPU-h`]];
  }
  const cap = m.kind === 'call';
  return [[cap ? 'Cap payoff' : 'Floor payout', v.usd(r.payoff), 'Never below zero'],
    ['Net after the fee', v.signedUsd(r.net), `Down to ${v.usd(-m.premiumPaid)} when it is not needed`],
    ['At the expected average', v.signedUsd(atExpected), `Net, at ${v.perHour(m.expected)}/GPU-h`]];
}

/** The slider label, the payoff chart and the three read-outs for window average `avg`. */
export function whatIfParts(p, avg) {
  const m = whatIfModel(p);
  const value = Math.min(Math.max(avg ?? m.expected, m.lo), m.hi);
  const move = (value / m.expected - 1) * 100;
  return {
    value, m,
    label: `${esc(v.perHour(value))}/GPU-h <span class="d-muted">(${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(0)}% on the expected ${esc(v.perHour(m.expected))})</span>`,
    chart: v.payoffChart({ ...m, current: value }),
    out: outputs(m, value).map(([t, d, note]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd><small>${esc(note)}</small></div>`).join(''),
  };
}

export function whatIfBlock(p, avg) {
  const w = whatIfParts(p, avg);
  const key = lockLike(w.m.kind) ? '<li><i></i>Saving against the window average</li>'
    : `<li><i></i>${w.m.kind === 'call' ? 'Cap payoff' : 'Floor payout'}</li><li><i class="is-net"></i>Net after the fee</li>`;
  return `<div class="d-whatif" data-tour="what-if"><label for="d-whatif">If the window average ends at <span id="d-whatif-label">${w.label}</span></label>
    <input type="range" id="d-whatif" min="${w.m.lo.toFixed(2)}" max="${w.m.hi.toFixed(2)}" step="${SLIDER_STEP}" value="${w.value.toFixed(2)}" aria-describedby="d-whatif-out">
    <div id="d-whatif-chart">${w.chart}</div>
    <ul class="p-key">${key}<li><i class="is-be"></i>Break-even</li></ul>
    <dl id="d-whatif-out" aria-live="polite">${w.out}</dl></div>`;
}
