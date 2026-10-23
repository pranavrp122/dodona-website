/** Seeds the demo platform idempotently: two mock neoclouds, the offer board, the four demo logins and Sample Labs' orders. */
import samples from '../data/sample-portfolio.json' with { type: 'json' };
import { all, get, insert, update, newId, newRef, transaction, getMeta, setMeta } from './db.mjs';
import { createNeocloud } from './neocloud.mjs';
import { createAccount, hashPasswordSync } from './auth.mjs';
import { recordPaid } from './payments.mjs';
import { breakdown } from './orders.mjs';
import { quoteCap, quotePut, atTheMoneyStrike } from './pricing.mjs';

export const DEMO_PASSWORD = 'demo-dodona-2026';
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const SEED_FLAG = 'seeded_v1';
const split = (gpu, total) => [[gpu, 'US East', total / 2], [gpu, 'US West', total / 2]];

export const NEOCLOUDS = Object.freeze([
  { id: 'nc_northwind', name: 'Northwind Compute', capacity: [...split('H100', 2048), ...split('H200', 512), ...split('B200', 256), ...split('A100', 1024)] },
  // Helix also holds a small H200 block in Europe so the Sample Labs H200 order has a home.
  { id: 'nc_helix', name: 'Helix Cloud', capacity: [['H100', 'Europe', 1024], ['B200', 'Europe', 256], ['H200', 'Europe', 64]] },
]);

export const SEEDED_ACCOUNTS = Object.freeze([
  { seedKey: 'demo-buyer', email: 'demo@dodona.markets', company: 'Sample Labs', role: 'buyer', kyb: 'verified', stage: 'demo' },
  { seedKey: 'demo-lender', email: 'credit@meridian.example', company: 'Meridian Credit', role: 'lender', kyb: 'verified', stage: 'demo' },
  { seedKey: 'demo-provider', email: 'ops@northwind.example', company: 'Northwind Compute', role: 'provider', kyb: 'verified', stage: 'active', neocloudId: 'nc_northwind' },
  { seedKey: 'demo-admin', email: 'admin@dodona.markets', company: 'Dodona', role: 'admin', kyb: 'verified', stage: 'active' },
]);

// [neocloud, gpu, region, kind, days until start, window days]
const OFFER_PLAN = Object.freeze([
  ['nc_northwind', 'H100', 'US East', 'cap', 7, 7], ['nc_northwind', 'H100', 'US West', 'cap', 14, 14], ['nc_northwind', 'H100', 'US East', 'lock', 10, 7],
  ['nc_northwind', 'H200', 'US East', 'cap', 21, 14], ['nc_northwind', 'H200', 'US West', 'lock', 28, 28], ['nc_northwind', 'B200', 'US East', 'cap', 35, 14],
  ['nc_northwind', 'A100', 'US West', 'lock', 7, 28], ['nc_northwind', 'A100', 'US East', 'cap', 42, 28], ['nc_helix', 'H100', 'Europe', 'cap', 14, 14],
  ['nc_helix', 'H100', 'Europe', 'lock', 21, 28], ['nc_helix', 'B200', 'Europe', 'cap', 56, 28], ['nc_northwind', 'H100', 'US East', 'floor', 28, 28],
  ['nc_helix', 'H100', 'Europe', 'floor', 49, 28], ['nc_northwind', 'A100', 'US East', 'floor', 70, 14],
]);
const NOTES = Object.freeze({
  cap: 'Caps what you pay at the strike; you pay the lower of the window average and the cap.',
  floor: 'Usually bought by providers: pays the difference when the window average falls below the floor.',
  lock: 'One fixed price per GPU-hour for the whole window, whatever the index does.',
});

function priceOffer({ gpu, region, kind, start, end }, series, nowMs) {
  const input = { gpu, count: 8, start, end, region, config: 'SXM-IB' };
  if (kind === 'lock') return { strike: quoteCap({ ...input, type: 'lock' }, series, { now: nowMs }).strike, premium: 0 };
  const { forward } = quoteCap({ ...input, type: 'call' }, series, { now: nowMs });
  const strike = atTheMoneyStrike(forward * (kind === 'cap' ? 1.05 : 0.95));
  const quote = kind === 'cap' ? quoteCap({ ...input, type: 'call', strike }, series, { now: nowMs }) : quotePut({ ...input, strike }, series, { now: nowMs });
  return { strike, premium: quote.premiumPerGpuHour };
}

/** One batch of fourteen offers with windows one to ten weeks after `nowMs`, priced on the real series. */
export function seedOffers(db, history, nowMs) {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const at = new Date(nowMs).toISOString();
  for (const [neocloudId, gpu, region, kind, lead, length] of OFFER_PLAN) {
    const start = new Date(midnight + lead * DAY_MS).toISOString();
    const end = new Date(midnight + (lead + length) * DAY_MS).toISOString();
    const { strike, premium } = priceOffer({ gpu, region, kind, start, end }, history.data[gpu], nowMs);
    insert(db, 'offers', { id: newId('of'), neocloud_id: neocloudId, gpu, config: 'SXM-IB', region, kind, start, end, strike, premium_per_gpu_hour: premium, min_gpus: 8, max_gpus: 128, note: NOTES[kind] }, at);
  }
}

/** Adds a fresh batch when every offer on the board starts within a week (a long-running server keeps a live board). */
export function refreshOffers(db, history, nowMs) {
  const horizon = new Date(nowMs + 7 * DAY_MS).toISOString();
  if (!get(db, 'SELECT 1 AS x FROM offers WHERE start > ? LIMIT 1', horizon)) transaction(db, () => seedOffers(db, history, nowMs));
}

const ORDER_KIND = Object.freeze({ call: 'cap', lock: 'lock', offtake: 'lock' });

function sampleOrder(account, p, nowMs) {
  const kind = ORDER_KIND[p.kind];
  const gpuHours = p.count * (Date.parse(p.end) - Date.parse(p.start)) / HOUR_MS;
  const terms = breakdown({ kind, premiumPerGpuHour: p.premiumPerGpuHour, strike: p.pricePerGpuHour, gpuHours });
  const paidAt = p.boughtOn ? `${p.boughtOn}T12:00:00.000Z` : new Date(Math.min(nowMs - 7 * DAY_MS, Date.parse(p.start) - 30 * DAY_MS)).toISOString();
  const meta = { positionId: p.id, positionKind: p.kind, label: p.label, provider: p.provider, termType: p.termType, status: p.status, askingCents: p.askingCents ?? null,
    bestOfferCents: p.bestOfferCents ?? null, indexAtPurchase: p.indexAtPurchase, utilisation: p.utilisation, note: p.note };
  return {
    ref: newRef(), account_id: account.id, offer_id: null, neocloud_id: p.region === 'Europe' ? 'nc_helix' : 'nc_northwind', gpu: p.gpu, config: p.config, region: p.region,
    kind, count: p.count, start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString(), strike: p.pricePerGpuHour,
    premium_per_gpu_hour: terms.premiumPerGpuHour, premium_total: terms.premiumTotal, platform_fee: terms.platformFee, booking_fee: terms.bookingFee,
    pay_now: terms.payNow, gpu_hours: gpuHours, compute_cost_if_used: terms.computeCostIfUsed, break_even: terms.breakEven,
    status: 'pending_payment', meta_json: JSON.stringify(meta), ordered_at: paidAt,
  };
}

/**
 * Sample Labs' seven sample positions as paid orders. Each is paid on its purchase date; `settle` (from the clock)
 * then runs every due transition up to now so statuses, settlements and emails are real.
 */
export function seedSampleOrders(db, account, { nowMs, settle }) {
  const rows = samples.positions.map(p => sampleOrder(account, p, nowMs));
  for (const row of rows) {
    insert(db, 'orders', row, row.ordered_at);
    recordPaid(db, row, { brand: 'Visa', last4: '4242', at: row.ordered_at });
  }
  const earliest = rows.map(r => r.ordered_at).sort()[0];
  update(db, 'accounts', { id: account.id }, { demo_now: earliest });
  settle?.(get(db, 'SELECT * FROM accounts WHERE id = ?', account.id), new Date(nowMs).toISOString());
  update(db, 'accounts', { id: account.id }, { demo_now: new Date(nowMs).toISOString() });
}

/** Seeds everything once; later calls only top up the offer board. `settle(account, toIso)` advances seeded orders. */
export function seedPlatform(db, { history, nowMs = Date.now(), settle, password = DEMO_PASSWORD } = {}) {
  if (getMeta(db, SEED_FLAG)) return refreshOffers(db, history, nowMs);
  const at = new Date(nowMs).toISOString();
  transaction(db, () => {
    for (const nc of NEOCLOUDS) if (!get(db, 'SELECT 1 AS x FROM neoclouds WHERE id = ?', nc.id)) createNeocloud(db, { ...nc, at });
    const passwordHash = hashPasswordSync(password);
    for (const seed of SEEDED_ACCOUNTS) {
      if (get(db, 'SELECT 1 AS x FROM accounts WHERE email = ?', seed.email)) continue;
      const account = createAccount(db, { ...seed, passwordHash, at });
      if (seed.seedKey === 'demo-buyer') seedSampleOrders(db, account, { nowMs, settle });
    }
    seedOffers(db, history, nowMs);
    setMeta(db, SEED_FLAG, at, at);
  });
}

/** Clears an account's demo state (orders, prints, emails, events, clock) and reseeds Sample Labs' orders when it is that account. */
export function reseedAccount(db, account, { nowMs, settle }) {
  const at = new Date(nowMs).toISOString();
  transaction(db, () => {
    for (const { ref } of all(db, 'SELECT ref FROM orders WHERE account_id = ?', account.id)) db.prepare('DELETE FROM events WHERE order_ref = ?').run(ref);
    db.prepare('DELETE FROM orders WHERE account_id = ?').run(account.id);
    db.prepare('DELETE FROM prints WHERE account_id = ?').run(account.id);
    db.prepare('DELETE FROM emails WHERE account_id = ?').run(account.id);
    update(db, 'accounts', { id: account.id }, { demo_now: at, scenario: 'market' }, at);
    if (account.neocloud_id) update(db, 'neoclouds', { id: account.neocloud_id }, { auto_confirm: 1 }, at);
    if (account.seed_key === 'demo-buyer') seedSampleOrders(db, get(db, 'SELECT * FROM accounts WHERE id = ?', account.id), { nowMs, settle });
  });
  return get(db, 'SELECT * FROM accounts WHERE id = ?', account.id);
}
