import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCrmMirror, mirrorSettings, MIRROR_TABLES } from '../lib/crm-mirror.mjs';

const KEY = 'test-only-service-role-key';
const ENV = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: KEY, DEMO_SUPABASE_MIRROR: '1' };
const T1 = '2026-10-20T10:00:00.000Z', T2 = '2026-10-21T10:00:00.000Z';

// A stand-in demo database with the secret columns the mirror must never read.
function demoDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT, company TEXT, role TEXT, kyb TEXT, stage TEXT, phone TEXT, neocloud_id TEXT, demo_now TEXT, scenario TEXT, last_active_at TEXT, password_hash TEXT, salt TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, account_id TEXT, author TEXT, text TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE orders (ref TEXT PRIMARY KEY, account_id TEXT, offer_id TEXT, neocloud_id TEXT, gpu TEXT, count INTEGER, region TEXT, kind TEXT, strike REAL, start TEXT, "end" TEXT, status TEXT, delivery_choice TEXT, premium_per_gpu_hour REAL, premium_total REAL, platform_fee REAL, booking_fee REAL, pay_now REAL, created_at TEXT, updated_at TEXT);
    CREATE TABLE payments (id TEXT PRIMARY KEY, order_ref TEXT, account_id TEXT, amount REAL, status TEXT, outcome TEXT, brand TEXT, last4 TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE settlements (order_ref TEXT PRIMARY KEY, account_id TEXT, kind TEXT, window_avg REAL, strike REAL, hours REAL, compute_bill REAL, saving REAL, resale_proceeds REAL, premium_paid REAL, net_result REAL, computed_at TEXT, updated_at TEXT);
  `);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('acc_1', 'demo@dodona.markets', 'Sample Labs', 'buyer', 'verified', 'demo', null, null, T1, 'market', T1, 'scrypt$secret-hash', 'secret-salt', T1, T1);
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('a'.repeat(64), 'acc_1', T1, T1);
  db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run('note_1', 'acc_1', 'admin@dodona.markets', 'Walked through caps.', T1, T1);
  db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('DOD-1', 'acc_1', 'off_1', 'nc_1', 'H100', 8, 'US East', 'cap', 2.5, T1, T2, 'paid', 'deliver', 0.1234, 1000, 150, 2, 1002, T1, T1);
  db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?,?,?,?,?)').run('pay_1', 'DOD-1', 'acc_1', 1002, 'succeeded', 'approved', 'Visa', '4242', T1, T1);
  db.prepare('INSERT INTO settlements VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('DOD-1', 'acc_1', 'cap', 2.7, 2.5, 1344, 3360, 268.8, 0, 1000, -731.2, T2, T2);
  return db;
}

function fakePostgrest({ status = 201 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(null, { status });
  };
  return { calls, fetchImpl };
}

const quiet = { log() {}, error() {} };

test('the mirror stays off and says so honestly until all three settings are present', async () => {
  assert.deepEqual(mirrorSettings({}).missing, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DEMO_SUPABASE_MIRROR']);
  assert.deepEqual(mirrorSettings({ ...ENV, DEMO_SUPABASE_MIRROR: '0' }).missing, ['DEMO_SUPABASE_MIRROR']);
  assert.equal(mirrorSettings({ ...ENV, SUPABASE_URL: 'http://evil.example' }).configured, false);
  const fake = fakePostgrest();
  const mirror = createCrmMirror({ db: demoDb(), environment: {}, fetchImpl: fake.fetchImpl, logger: quiet });
  const result = await mirror.run();
  assert.equal(result.ran, false);
  assert.match(result.message, /not configured/);
  assert.equal(fake.calls.length, 0);
  const status = mirror.status();
  assert.equal(status.configured, false);
  assert.equal(status.lastRunAt, null);
  assert.deepEqual(status.tables, { accounts: 1, notes: 1, orders: 1, payments: 1, settlements: 1 });
});

test('a sync upserts every table with merge-duplicates and never sends secrets or card data', async () => {
  const fake = fakePostgrest();
  const mirror = createCrmMirror({ db: demoDb(), environment: ENV, fetchImpl: fake.fetchImpl, logger: quiet });
  const result = await mirror.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.pushed, { accounts: 1, notes: 1, orders: 1, payments: 1, settlements: 1 });
  assert.deepEqual(fake.calls.map(c => new URL(c.url).pathname + new URL(c.url).search), MIRROR_TABLES.map(t => `/rest/v1/${t.remote}?on_conflict=${t.key}`));
  for (const call of fake.calls) {
    assert.equal(new URL(call.url).origin, 'https://test-project.supabase.co');
    assert.equal(call.headers.apikey, KEY);
    assert.equal(call.headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  }
  const sent = JSON.stringify(fake.calls.map(c => c.body));
  for (const secret of ['secret-hash', 'secret-salt', 'scrypt', 'a'.repeat(64), '4242', 'Visa', 'password', 'last4', 'brand', 'token', 'cvc']) assert.equal(sent.includes(secret), false, secret);
  assert.deepEqual(fake.calls[0].body[0], { id: 'acc_1', email: 'demo@dodona.markets', company: 'Sample Labs', role: 'buyer', kyb: 'verified', stage: 'demo', phone: null, neocloud_id: null, demo_now: T1, scenario: 'market', last_active_at: T1, created_at: T1, updated_at: T1 });
  assert.deepEqual(fake.calls[3].body[0], { id: 'pay_1', order_ref: 'DOD-1', account_id: 'acc_1', amount: 1002, status: 'succeeded', outcome: 'approved', created_at: T1, updated_at: T1 });
  assert.equal(fake.calls[2].body[0].window_end, T2);
});

test('later runs send only rows changed since the last successful run', async () => {
  const db = demoDb();
  const fake = fakePostgrest();
  const mirror = createCrmMirror({ db, environment: ENV, fetchImpl: fake.fetchImpl, logger: quiet });
  await mirror.run();
  fake.calls.length = 0;
  assert.deepEqual((await mirror.run()).pushed, { accounts: 0, notes: 0, orders: 0, payments: 0, settlements: 0 });
  assert.equal(fake.calls.length, 0);
  db.prepare('UPDATE accounts SET stage = ?, updated_at = ? WHERE id = ?').run('active', T2, 'acc_1');
  const third = await mirror.run();
  assert.equal(third.pushed.accounts, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body[0].stage, 'active');
});

test('a Supabase failure is recorded, logged in one line and retried next run, never thrown', async () => {
  const lines = [];
  let status = 404;
  const fetchImpl = async () => new Response(null, { status });
  const mirror = createCrmMirror({ db: demoDb(), environment: ENV, fetchImpl, logger: { log: l => lines.push(l), error: l => lines.push(l) } });
  const failed = await mirror.run();
  assert.equal(failed.ok, false);
  assert.match(failed.message, /demo_accounts.*demo-crm\.sql/);
  assert.equal(mirror.status().lastResult.ok, false);
  assert.ok(mirror.status().lastRunAt);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[crm-mirror\] failed/);
  assert.equal(lines[0].includes(KEY), false);
  status = 201;
  assert.equal((await mirror.run()).pushed.accounts, 1);
  const thrown = createCrmMirror({ db: demoDb(), environment: ENV, fetchImpl: async () => { throw new TypeError('network'); }, logger: quiet });
  assert.match((await thrown.run()).message, /could not read the demo database or reach Supabase/);
});

test('the timer only starts when configured and stops cleanly', async () => {
  const fake = fakePostgrest();
  const off = createCrmMirror({ db: demoDb(), environment: {}, fetchImpl: fake.fetchImpl, logger: quiet });
  off.start();
  off.stop();
  assert.equal(fake.calls.length, 0);
  const on = createCrmMirror({ db: demoDb(), environment: ENV, fetchImpl: fake.fetchImpl, logger: quiet, intervalMs: 20 });
  on.start();
  await new Promise(resolve => setTimeout(resolve, 70));
  on.stop();
  assert.ok(fake.calls.length >= MIRROR_TABLES.length);
});
