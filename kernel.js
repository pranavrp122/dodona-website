// agent kernel console: polls the kernel api and renders the process table, the latency ladder, the turn feed and the replay log
(() => {
  const POLL_MS = 2500;
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const fmt = {
    int: n => (n == null ? '–' : Number(n).toLocaleString('en-US')),
    cents: micro => `${(Number(micro || 0) / 1000000).toFixed(3)}¢`,
    dollars: c => `$${(Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    ms: v => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 1 ? `${v.toFixed(v < 10 ? 2 : 0)} ms` : `${(v * 1000).toFixed(0)} µs`),
    ns: v => (v == null ? '–' : v >= 1e6 ? `${(v / 1e6).toFixed(2)} ms` : v >= 1000 ? `${(v / 1000).toFixed(1)} µs` : `${v} ns`),
    pct: (n, d) => (d ? `${Math.round(100 * n / d)}%` : '–'),
  };
  let busy = false;
  let autopilot = false;
  let signedOut = false;

  // the api answers {ok, ...} or {ok:false, error:{code, message}} and 401 when nobody is signed in
  async function api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const response = await fetch(path, init);
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { signedOut = true; throw new Error('Sign in on /sign-in first, then come back to /kernel.'); }
    if (!response.ok || data.ok === false) throw new Error(data.error?.message || `Request failed (${response.status}).`);
    return data;
  }

  function toast(message, bad = false) {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast${bad ? ' bad' : ''}`;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, bad ? 7000 : 3500);
  }

  function meter(value, max, { text, warnAt = 0.75, badAt = 0.95 } = {}) {
    const wrap = el('span', 'meter');
    const track = el('span', 'track');
    const fill = el('span', 'fill');
    const share = max ? Math.min(1, value / max) : 0;
    fill.style.width = `${Math.round(share * 100)}%`;
    if (share >= badAt) fill.classList.add('bad'); else if (share >= warnAt) fill.classList.add('warn');
    track.append(fill);
    wrap.append(track, el('small', null, text));
    return wrap;
  }

  function renderProcs({ procs }) {
    const body = $('#procs tbody');
    body.replaceChildren();
    $('#procs-empty').hidden = procs.length > 0;
    for (const p of procs) {
      const tr = el('tr', p.state);
      const cell = (content, cls) => { const td = el('td', cls); if (content instanceof Node) td.append(content); else td.textContent = content; tr.append(td); };
      cell(String(p.pid), 'pid');
      cell(p.tenant);
      cell(p.name);
      cell(el('span', `state ${p.state}`, p.state));
      cell(String(p.weight), 'num');
      cell(fmt.int(p.vruntime), 'num');
      cell(String(p.turns), 'num');
      const ctx = meter(p.last_context_tokens, p.budget_tokens, { text: `${p.last_context_tokens} / ${p.budget_tokens}` });
      if (p.last_dropped) ctx.append(el('small', 'dropped', ` −${p.last_dropped}`));
      cell(ctx);
      cell(`${fmt.int(p.prompt_tokens)} / ${fmt.int(p.completion_tokens)}`, 'num');
      cell(fmt.cents(p.microcents), 'num');
      cell(fmt.dollars(p.premium_spent_cents), 'num');
      cell(fmt.int(p.gpu_hours), 'num');
      // delta is kept in basis points of one gpu-hour, shown as delta-weighted gpu-hours
      cell((p.net_delta_bps / 10000).toFixed(1), 'num');
      cell(String(p.orders), 'num');
      const kill = el('button', 'kill', p.state === 'terminated' ? 'gone' : 'kill');
      kill.type = 'button';
      kill.disabled = p.state === 'terminated';
      kill.addEventListener('click', () => act(() => api('/api/kernel/kill', { pid: p.pid }), `killed pid ${p.pid}`));
      cell(kill);
      body.append(tr);
    }
  }

  // one ladder, log scale from 100 ns to 10 s, so the kernel and the model sit on the same axis
  const LOG_MIN = Math.log10(100);
  const LOG_MAX = Math.log10(1e10);
  function rung(key, ns, text) {
    const li = $(`#scale li[data-key="${key}"]`);
    if (!li) return;
    const share = ns == null || ns <= 0 ? 0 : Math.max(0, Math.min(1, (Math.log10(ns) - LOG_MIN) / (LOG_MAX - LOG_MIN)));
    $('.bar i', li).style.width = `${Math.round(share * 100)}%`;
    $('.value', li).textContent = text;
  }

  function renderStats(stats) {
    const ops = stats.kernel.ops || {};
    // the risk check alone is below the 100 ns timer resolution, the benchmark measured it directly
    rung('risk', ops.submit ? 100 : null, ops.submit ? '< 0.1 µs' : '–');
    rung('schedule', ops.schedule?.avg_ns, fmt.ns(ops.schedule?.avg_ns));
    rung('submit', ops.submit?.avg_ns, fmt.ns(ops.submit?.avg_ns));
    rung('pipe', stats.pipeMs.p50 == null ? null : stats.pipeMs.p50 * 1e6, stats.pipeMs.p50 == null ? '–' : `${fmt.ms(stats.pipeMs.p50)} p50`);
    rung('model', stats.modelMs.p50 == null ? null : stats.modelMs.p50 * 1e6, stats.modelMs.p50 == null ? '–' : `${fmt.ms(stats.modelMs.p50)} p50`);
    const t = stats.totals;
    const kpi = (key, text) => { $(`#kpis [data-kpi="${key}"]`).textContent = text; };
    kpi('turns', fmt.int(stats.turns));
    kpi('orders', fmt.int(t.orders));
    kpi('rejected', fmt.int(t.rejected));
    kpi('spend', fmt.cents(t.microcents));
    kpi('reasoning', fmt.pct(t.reasoning_tokens, t.completion_tokens));
    kpi('cached', fmt.pct(t.cached_tokens, t.prompt_tokens));
    $('#model-chip').textContent = `${stats.model} · ${stats.effort}${stats.gcModel && stats.gcModel !== stats.model ? ` · gc ${stats.gcModel}` : ''}`;
    $('#clock-chip').textContent = stats.clocks.length ? stats.clocks.map(c => `${c.tenant} ${c.demoNow.slice(0, 10)}`).join(' · ') : 'clock: no agents';
    autopilot = stats.autopilot;
    const button = $('#autopilot');
    button.textContent = autopilot ? 'autopilot on' : 'autopilot off';
    button.classList.toggle('on', autopilot);
  }

  function callText(sc) {
    if (sc.call === 'hold') return 'hold';
    if (sc.error) return `${sc.kind}: ${sc.error}`;
    return `${sc.kind} @ ${(sc.strike_cents / 100).toFixed(2)} × ${fmt.int(sc.gpu_hours)} h = ${fmt.dollars(sc.premium_cents)}`;
  }

  function renderTurns({ turns }) {
    const list = $('#turns');
    list.replaceChildren();
    $('#turns-empty').hidden = turns.length > 0;
    for (const t of turns) {
      const li = el('li', `turn${t.error ? ' error' : ''}`);
      const head = el('div', 'turn-head');
      head.append(el('span', 'who', `pid ${t.pid} · ${t.name}`), el('span', null, t.tenant), el('span', null, `${t.contextTokens} ctx tok${t.dropped ? ` · ${t.dropped} dropped` : ''}`),
        el('span', null, `${fmt.ms(t.modelMs)} model · ${fmt.ns(t.kernelNs)} kernel`), el('span', 'cost', `${fmt.cents(t.usage?.microcents)} · ${t.usage?.reasoning_tokens ?? 0} reasoning tok`));
      li.append(head, el('p', 'note', t.note || '(no note)'));
      const calls = el('div', 'calls');
      t.syscalls.forEach((sc, i) => {
        const rejected = t.rejected.find(r => r.i === i);
        const cls = sc.call === 'hold' ? 'hold' : rejected ? 'rejected' : t.accepted.includes(i) ? 'accepted' : '';
        const chip = el('span', `call ${cls}`, callText(sc));
        if (rejected) chip.append(el('span', 'why', ` · ${rejected.reason}`));
        calls.append(chip);
      });
      if (t.gc) calls.append(el('span', 'call hold', `gc → ${t.gc.bytes} bytes working set`));
      li.append(calls);
      const booked = t.orders.filter(o => o.ref);
      if (booked.length) {
        const row = el('div', 'orders');
        for (const o of booked) { const a = el('a', null, `${o.ref} · ${o.kind} ${o.count}× @ ${o.strike} · ${o.status}`); a.href = `/orders/${o.ref}`; row.append(a); }
        li.append(row);
      }
      list.append(li);
    }
  }

  function renderReplay({ entries }) {
    const list = $('#replay');
    list.replaceChildren();
    for (const e of [...entries].reverse()) {
      const li = el('li');
      const detail = e.op === 'submit' ? `pid ${e.pid} accepted ${JSON.stringify(e.accepted ?? [])} rejected ${(e.rejected ?? []).map(r => r.reason).join(',') || 'none'}`
        : e.op === 'interrupt' ? `${e.req?.kind} → ${e.req?.pid ? `pid ${e.req.pid}` : e.req?.tenant || 'all'}`
          : e.op === 'schedule' ? (e.pid ? `pid ${e.pid} picked` : 'idle')
            : e.op === 'spawn' ? `${e.req?.tenant} / ${e.req?.name} → pid ${e.pid}`
              : e.op === 'gc' ? `pid ${e.pid} working set replaced` : `pid ${e.pid ?? '–'}`;
      li.append(el('span', 'seq', `#${e.seq}`), el('span', `op${e.ok ? '' : ' bad'}`, e.op), el('span', null, detail), el('span', 'ns', fmt.ns(e.ns)));
      list.append(li);
    }
  }

  async function refresh() {
    try {
      const [procs, stats, turns, replay] = await Promise.all([api('/api/kernel/ps'), api('/api/kernel/stats'), api('/api/kernel/turns'), api('/api/kernel/replay?limit=60')]);
      renderProcs(procs);
      renderStats(stats);
      renderTurns(turns);
      renderReplay(replay);
      const live = $('#live-chip');
      live.textContent = 'live';
      live.classList.remove('off');
      signedOut = false;
    } catch (error) {
      const live = $('#live-chip');
      live.textContent = signedOut ? 'signed out' : 'offline';
      live.classList.add('off');
      if (!refresh.warned) { toast(error.message, true); refresh.warned = true; }
    }
  }

  // every control disables the bar while it runs and refreshes when it is done
  async function act(fn, done) {
    if (busy) return;
    busy = true;
    for (const b of document.querySelectorAll('.actions button')) b.disabled = true;
    try {
      const result = await fn();
      if (done) toast(typeof done === 'function' ? done(result) : done);
    } catch (error) {
      toast(error.message, true);
    } finally {
      busy = false;
      for (const b of document.querySelectorAll('.actions button')) b.disabled = false;
      await refresh();
    }
  }

  for (const b of document.querySelectorAll('[data-spawn]')) b.addEventListener('click', () => act(() => api('/api/kernel/spawn', { preset: b.dataset.spawn }), r => `spawned pid ${r.pid}`));
  for (const b of document.querySelectorAll('[data-tick]')) b.addEventListener('click', () => act(() => api('/api/kernel/tick', { days: Number(b.dataset.tick) }), r => `advanced ${r.days} day(s): ${r.fired} events fired, ${r.woken} agents woken`));
  for (const b of document.querySelectorAll('[data-run]')) b.addEventListener('click', () => act(() => api('/api/kernel/run', { turns: Number(b.dataset.run) }), r => `${r.turns.length} turn(s) ran, ${r.turns.reduce((n, t) => n + t.orders.filter(o => o.ref).length, 0)} order(s) booked`));
  $('#autopilot').addEventListener('click', () => act(() => api('/api/kernel/autopilot', { on: !autopilot }), r => (r.autopilot ? 'autopilot on: the clock ticks and the scheduler runs every 15 s' : 'autopilot off')));

  refresh();
  setInterval(() => { if (!busy) refresh(); }, POLL_MS);
})();
