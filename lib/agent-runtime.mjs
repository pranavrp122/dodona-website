/** The agent runtime: wires the C++ kernel, the model and the platform together so one scheduler turn becomes real priced orders. */
import { get, transaction } from './db.mjs';
import { createOrder, QUOTE_TYPE } from './orders.mjs';
import { quoteFromHistory, normalCdf, ALLOWED_COUNTS } from './pricing.mjs';
import { accountPrices } from './prints.mjs';
import { recordPaid } from './payments.mjs';
import { advance } from './clock.mjs';
import { percentiles } from './kernel-client.mjs';

const DAY_MS = 86400000;
const TURN_LOG = 80;
const MAX_SYSCALLS = 4;
const EVENT_INTERRUPTS = 5;
const SAMPLE_LIMIT = 5000;

/** Ready-made agents for the demo, one per kind of customer the platform has. */
export const PRESETS = Object.freeze([
  {
    key: 'hedger', tenant: 'demo@dodona.markets', name: 'cost-hedger', weight: 2, budgetTokens: 1400,
    goal: 'you buy compute for an ai lab. protect next month\'s training run from a price spike: buy caps when the premium is small relative to volatility, lock when the forward is below the index, hold otherwise. spend premium slowly over many turns.',
    mandate: { gpu: 'H100', region: 'US East', config: 'SXM-IB', leadDays: 14, windowDays: 7 },
    limits: { max_premium_cents: 400000, max_gpu_hours: 4000, max_abs_delta_bps: 30000000, strike_band_bps: 1500, max_slippage_bps: 300, max_orders_per_turn: 2 },
  },
  {
    key: 'floor', tenant: 'ops@northwind.example', name: 'revenue-floor', weight: 1, budgetTokens: 1400,
    goal: 'you run a neocloud. protect the revenue of idle h100 capacity by buying floors a little below the forward when volatility is high. never buy caps or locks.',
    mandate: { gpu: 'H100', region: 'US East', config: 'SXM-IB', leadDays: 21, windowDays: 14 },
    limits: { max_premium_cents: 300000, max_gpu_hours: 6000, max_abs_delta_bps: 40000000, strike_band_bps: 1200, max_slippage_bps: 300, max_orders_per_turn: 1 },
  },
  {
    key: 'scout', tenant: 'demo@dodona.markets', name: 'basis-scout', weight: 1, budgetTokens: 1000,
    goal: 'you look for cheap b200 caps. buy a small cap only when the at-the-money cap premium per hour is under two percent of the strike, otherwise hold and say why in one line.',
    mandate: { gpu: 'B200', region: 'US East', config: 'SXM-IB', leadDays: 35, windowDays: 14 },
    limits: { max_premium_cents: 150000, max_gpu_hours: 1500, max_abs_delta_bps: 10000000, strike_band_bps: 2000, max_slippage_bps: 300, max_orders_per_turn: 1 },
  },
]);

const cents = dollars => Math.round(dollars * 100);
const midnight = iso => Math.floor(Date.parse(iso) / DAY_MS) * DAY_MS;

/** The option's sensitivity to the forward from the same black-76 inputs the quote used, a lock is fully exposed. */
export function black76Delta({ type, forward, strike, vol, tEffYears, tYears, rate }) {
  if (type === 'lock') return 1;
  const discount = Math.exp(-rate * tYears);
  const sd = vol * Math.sqrt(tEffYears);
  if (!(sd > 0)) return type === 'call' ? (forward > strike ? discount : 0) : (forward < strike ? -discount : 0);
  const d1 = (Math.log(forward / strike) + sd * sd / 2) / sd;
  return type === 'call' ? discount * normalCdf(d1) : discount * (normalCdf(d1) - 1);
}

// snaps a requested size in gpu-hours onto the gpu count ladder the platform actually sells
function countFor(gpuHours, windowDays) {
  const wanted = gpuHours / (windowDays * 24);
  return ALLOWED_COUNTS.reduce((best, c) => (Math.abs(c - wanted) < Math.abs(best - wanted) ? c : best), ALLOWED_COUNTS[0]);
}

function windowFor(account, mandate) {
  const start = midnight(account.demo_now) + mandate.leadDays * DAY_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + mandate.windowDays * DAY_MS).toISOString() };
}

// the stable part of the prompt, the kernel appends the hard limits and the response contract after it
function systemPrompt(preset) {
  const m = preset.mandate;
  return [
    `you are ${preset.name}, an autonomous agent trading options on gpu compute on dodona.`,
    `goal: ${preset.goal}`,
    `mandate: ${m.gpu} in ${m.region}, windows of ${m.windowDays} days starting ${m.leadDays} days ahead. strikes are integer cents per gpu-hour, premiums are integer cents in total, strike_cents 0 means at the money.`,
    'each turn you see the market, your exposure, your memory and recent history. answer with at most two syscalls.',
  ].join('\n');
}

// the model spends a few hundred tokens on hidden reasoning before the json, so the cap must leave room for both
export const DEFAULT_MAX_TOKENS = 1200;

export function createAgentRuntime({ kernel, muse, boot, prices, now = Date.now, logger = console, model, effort, maxTokens = DEFAULT_MAX_TOKENS }) {
  const turnModel = model ?? muse.model;
  const turnEffort = effort ?? muse.effort;
  const procs = new Map();
  const turns = [];
  const modelMs = [];
  let autopilot = null;

  function accountOf(db, proc) {
    const row = get(db, 'SELECT * FROM accounts WHERE id = ?', proc.accountId);
    if (!row) throw new Error(`The account behind pid ${proc.pid} is gone.`);
    return row;
  }

  // what the agent sees about the market this turn, every number an integer the kernel and the model can both read
  function snapshot(db, account, history, mandate) {
    const window = windowFor(account, mandate);
    const seen = accountPrices(db, account, history);
    const base = { gpu: mandate.gpu, count: 8, ...window, region: mandate.region, config: mandate.config };
    const cap = quoteFromHistory({ ...base, type: 'call' }, seen, { now: account.demo_now });
    const lock = quoteFromHistory({ ...base, type: 'lock' }, seen, { now: account.demo_now });
    return {
      at: account.demo_now.slice(0, 10), gpu: mandate.gpu, index_cents: cents(cap.spot), forward_cents: cents(cap.forward), vol_bps: Math.round(cap.vol * 10000),
      window: `${window.start.slice(0, 10)}/${window.end.slice(0, 10)}`, atm_strike_cents: cents(cap.strike),
      atm_cap_premium_cents_per_hour: cents(cap.premiumPerGpuHour), lock_cents: cents(lock.strike),
    };
  }

  // prices one syscall exactly as the platform would, so the kernel can check it against the limits before anything is booked
  function enrich(db, account, history, proc, sc) {
    if (sc?.call !== 'order') return { call: 'hold' };
    const kind = sc.kind;
    const type = QUOTE_TYPE[kind];
    if (!type) return { call: 'order', kind: String(kind), error: 'unknown kind' };
    const { start, end } = windowFor(account, proc.mandate);
    const count = countFor(Number(sc.gpu_hours) || 0, proc.mandate.windowDays);
    const atTheMoney = kind === 'lock' || !(Number(sc.strike_cents) > 0);
    const custom = { gpu: proc.mandate.gpu, count, start, end, kind, region: proc.mandate.region, config: proc.mandate.config, ...(atTheMoney ? {} : { strike: Number(sc.strike_cents) / 100 }) };
    let quote;
    try { quote = quoteFromHistory({ ...custom, type }, accountPrices(db, account, history), { now: account.demo_now }); }
    catch (error) { return { call: 'order', kind: 'invalid', error: error.message }; }
    const delta = black76Delta({ type, forward: quote.forward, strike: quote.strike, vol: quote.vol, tEffYears: quote.tEffYears, tYears: quote.tYears, rate: quote.inputs.rate });
    return {
      call: 'order', kind, strike_cents: cents(quote.strike), index_cents: cents(quote.forward), gpu_hours: Math.round(quote.gpuHours), asked_gpu_hours: Math.round(Number(sc.gpu_hours) || 0), premium_cents: cents(quote.premiumTotal),
      limit_premium_cents: Math.max(0, Math.round(Number(sc.limit_premium_cents) || 0)), delta_bps: Math.round(delta * quote.gpuHours * 10000), custom: { ...custom, strike: custom.strike ?? quote.strike },
    };
  }

  // books an accepted order and pays it with the demo card in one transaction, exactly like the checkout page
  function book(db, account, enriched, history) {
    return transaction(db, () => {
      const order = createOrder(db, account, { custom: enriched.custom }, history);
      recordPaid(db, order, order.pay_now > 0 ? { brand: 'Visa', last4: '4242', at: account.demo_now } : { at: account.demo_now });
      return get(db, 'SELECT * FROM orders WHERE ref = ?', order.ref);
    });
  }

  /** Spawns a preset agent under its tenant's account and wakes it with the first market snapshot. */
  async function spawn(presetOrKey) {
    const preset = typeof presetOrKey === 'string' ? PRESETS.find(p => p.key === presetOrKey) : presetOrKey;
    if (!preset) throw new Error('Unknown agent preset.');
    const db = await boot();
    const account = get(db, 'SELECT * FROM accounts WHERE email = ?', preset.tenant);
    if (!account) throw new Error(`No account for ${preset.tenant}.`);
    const reply = await kernel.call('spawn', { tenant: account.company, name: preset.name, system: systemPrompt(preset), weight: preset.weight, budget_tokens: preset.budgetTokens, limits: preset.limits });
    if (!reply.ok) throw new Error(`The kernel refused the spawn: ${reply.error}.`);
    procs.set(reply.pid, { pid: reply.pid, key: preset.key, accountId: account.id, tenant: account.company, name: preset.name, goal: preset.goal, mandate: preset.mandate, limits: preset.limits });
    await wake(reply.pid);
    return reply.pid;
  }

  /** Delivers a fresh market snapshot to one agent, which makes it ready to run. */
  async function wake(pid) {
    const proc = procs.get(pid);
    if (!proc) return 0;
    const db = await boot();
    const history = await prices();
    const account = accountOf(db, proc);
    const reply = await kernel.call('interrupt', { kind: 'market', pid, payload: snapshot(db, account, history, proc.mandate) });
    return reply.delivered ?? 0;
  }

  /** Moves every agent tenant's demo clock forward, then wakes the agents with what fired and the new market. */
  async function tick({ days = 1 } = {}) {
    const db = await boot();
    const history = await prices();
    const accounts = new Map();
    for (const proc of procs.values()) if (!accounts.has(proc.accountId)) accounts.set(proc.accountId, accountOf(db, proc));
    let fired = 0;
    for (const account of accounts.values()) {
      const result = advance(db, account, { days }, { history, nowMs: now() });
      fired += result.firedCount;
      // only the latest few events are delivered as interrupts, the rest stay in the order history
      for (const event of result.fired.slice(-EVENT_INTERRUPTS)) {
        await kernel.call('interrupt', { kind: 'event', tenant: account.company, payload: { at: event.at.slice(0, 10), type: event.type, order: event.orderRef } });
      }
    }
    let woken = 0;
    for (const pid of procs.keys()) woken += await wake(pid);
    const clocks = [...accounts.values()].map(a => ({ tenant: a.company, demoNow: get(db, 'SELECT demo_now FROM accounts WHERE id = ?', a.id).demo_now }));
    return { days, fired, woken, clocks };
  }

  // one scheduled process through the model, back through the kernel's risk gate, and into the order book
  async function finish(scheduled) {
    const proc = procs.get(scheduled.pid);
    const started = performance.now();
    let reply = null;
    let failure = null;
    try { reply = await muse.turn({ system: scheduled.system, user: scheduled.user, model: turnModel, effort: turnEffort, maxTokens }); }
    catch (error) { failure = error.message; logger.error(`[kernel] The model turn failed for pid ${scheduled.pid}.`); }
    const ms = Math.round(performance.now() - started);
    modelMs.push(ms);
    if (modelMs.length > SAMPLE_LIMIT) modelMs.shift();
    const cutOff = reply && reply.finish === 'length';
    const parsed = reply?.parsed ?? { syscalls: [], note: failure ? `model error: ${failure}` : cutOff ? `reply cut off at ${maxTokens} tokens, ${reply.usage.reasoning_tokens} of them reasoning` : 'unreadable reply' };
    const db = await boot();
    const history = await prices();
    const account = proc ? accountOf(db, proc) : null;
    const wanted = Array.isArray(parsed.syscalls) ? parsed.syscalls.slice(0, MAX_SYSCALLS) : [];
    const enriched = wanted.map(sc => (proc ? enrich(db, account, history, proc, sc) : { call: 'hold' }));
    const wire = enriched.map(({ custom, error, ...rest }) => rest);
    const sub = await kernel.call('submit', { pid: scheduled.pid, syscalls: wire, usage: reply?.usage ?? {}, note: typeof parsed.note === 'string' ? parsed.note : '' });
    const orders = [];
    for (const i of sub.accepted ?? []) {
      try {
        const row = book(db, account, enriched[i], history);
        orders.push({ ref: row.ref, kind: row.kind, count: row.count, strike: row.strike, premiumTotal: row.premium_total, status: row.status });
      } catch (error) {
        logger.error(`[kernel] Booking failed for pid ${scheduled.pid}.`);
        orders.push({ error: error.message });
      }
    }
    let gc = null;
    if (sub.needs_gc) {
      try {
        const summary = await muse.summarize({ workingSet: sub.working_set, evicted: sub.evicted });
        await kernel.call('gc', { pid: scheduled.pid, working_set: summary.text });
        gc = { usage: summary.usage, ms: summary.ms, bytes: summary.text.length };
      } catch (error) { logger.error(`[kernel] The summarizer failed for pid ${scheduled.pid}.`); }
    }
    const turn = {
      at: new Date(now()).toISOString(), pid: scheduled.pid, tenant: scheduled.tenant, name: scheduled.name,
      contextTokens: scheduled.tokens, dropped: scheduled.dropped, truncated: scheduled.truncated, modelMs: ms, model: reply?.model ?? turnModel,
      kernelNs: (scheduled.ns ?? 0) + (sub.ns ?? 0), usage: reply?.usage ?? null, finish: reply?.finish ?? null, note: typeof parsed.note === 'string' ? parsed.note : '',
      syscalls: enriched.map(e => ({ call: e.call, kind: e.kind, strike_cents: e.strike_cents, gpu_hours: e.gpu_hours, asked_gpu_hours: e.asked_gpu_hours, premium_cents: e.premium_cents, limit_premium_cents: e.limit_premium_cents, delta_bps: e.delta_bps, error: e.error })),
      accepted: sub.accepted ?? [], rejected: sub.rejected ?? [], orders, gc, state: sub.state, error: failure,
    };
    turns.push(turn);
    if (turns.length > TURN_LOG) turns.shift();
    return turn;
  }

  /** Runs up to maxTurns scheduler turns with several model calls in flight at once, stopping early when nothing is ready. */
  async function run({ maxTurns = 6, concurrency = 3 } = {}) {
    const done = [];
    while (done.length < maxTurns) {
      const batch = [];
      while (batch.length < concurrency && done.length + batch.length < maxTurns) {
        const scheduled = await kernel.call('schedule');
        if (!scheduled.pid) break;
        batch.push(scheduled);
      }
      if (!batch.length) break;
      done.push(...await Promise.all(batch.map(finish)));
    }
    return done;
  }

  async function kill(pid) {
    await kernel.call('kill', { pid });
    procs.delete(pid);
  }

  async function ps() {
    const reply = await kernel.call('ps');
    const rows = (reply.procs ?? []).map(row => {
      const meta = procs.get(row.pid);
      return { ...row, meta: meta ? { key: meta.key, goal: meta.goal, gpu: meta.mandate.gpu, accountId: meta.accountId } : null };
    });
    return { procs: rows };
  }

  async function stats() {
    const reply = await kernel.call('stats');
    const totals = { microcents: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, orders: 0, rejected: 0, modelErrors: 0 };
    for (const t of turns) {
      for (const key of ['microcents', 'prompt_tokens', 'cached_tokens', 'completion_tokens', 'reasoning_tokens']) totals[key] += t.usage?.[key] ?? 0;
      totals.orders += t.orders.filter(o => o.ref).length;
      totals.rejected += t.rejected.length;
      if (t.error) totals.modelErrors += 1;
    }
    // each tenant's demo clock, read without touching the kernel so polling never wakes an agent
    const db = await boot();
    const seen = new Set();
    const clocks = [];
    for (const proc of procs.values()) {
      if (seen.has(proc.accountId)) continue;
      seen.add(proc.accountId);
      const row = get(db, 'SELECT company, demo_now FROM accounts WHERE id = ?', proc.accountId);
      if (row) clocks.push({ tenant: row.company, demoNow: row.demo_now });
    }
    return { kernel: reply, pipeMs: kernel.latency(), modelMs: percentiles(modelMs), turns: turns.length, totals, clocks, autopilot: autopilot !== null, model: turnModel, effort: turnEffort, gcModel: muse.gcModel ?? null };
  }

  /** A timer that ticks the clock and runs the scheduler, so the console can show agents trading on their own. */
  function startAutopilot({ intervalMs = 15000, days = 1, maxTurns = 6 } = {}) {
    if (autopilot) return;
    const loop = async () => {
      try { await tick({ days }); await run({ maxTurns }); }
      catch (error) { logger.error(`[kernel] Autopilot round failed: ${error.message}`); }
    };
    autopilot = setInterval(loop, intervalMs);
    autopilot.unref?.();
    void loop();
  }

  function stopAutopilot() {
    if (autopilot) clearInterval(autopilot);
    autopilot = null;
  }

  return { spawn, wake, tick, run, finish, kill, ps, stats, turns: () => [...turns].reverse(), replay: limit => kernel.call('replay', { limit }), startAutopilot, stopAutopilot, procs };
}
