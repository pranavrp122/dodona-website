import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';

const ADMIN = 'admin@dodona.markets';
const BUYER = 'demo@dodona.markets';
const ENV = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key', DEMO_SUPABASE_MIRROR: '1' };

async function setup(t, options) {
  const f = await platformFixture(options);
  t.after(() => f.cleanup());
  return f;
}

function fakePostgrest() {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : [] }); return new Response(null, { status: 201 }); } };
}

test('the admin page and its assets are served without inline scripts or style attributes', async t => {
  const f = await setup(t);
  const page = await fetch(f.origin + '/admin');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const html = await page.text();
  assert.match(html, /<title>Admin · Demo accounts — Dodona<\/title>/);
  assert.match(html, /<script type="module" src="\/admin\.js"><\/script>/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'no inline script');
  assert.equal(/\sstyle=|\son[a-z]+=/i.test(html), false, 'no style attributes or inline handlers');
  assert.match(html, /Sign in as an admin/);
  assert.match(html, /<b>Demo<\/b>/);
  for (const [path, type] of [['/admin.js', 'text/javascript'], ['/admin-view.js', 'text/javascript'], ['/admin.css', 'text/css']]) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), new RegExp(type));
  }
  for (const path of ['/admin', '/admin.js', '/admin-view.js']) {
    const text = (await (await fetch(f.origin + path)).text()).toLowerCase();
    for (const word of ['buyback', 'book-out', 'cash settlement', 'sell back', 'rating', 'offshore']) assert.equal(text.includes(word), false, `${word} in ${path}`);
  }
});

test('with the platform off, the admin page, its assets and the sync API are not found', async t => {
  const f = await setup(t, { platform: false });
  for (const path of ['/admin', '/admin.js', '/admin.css', '/api/admin/sync']) assert.equal((await fetch(f.origin + path)).status, 404, path);
});

test('the sync status needs an admin: signed out is 401 and a buyer is 403', async t => {
  const f = await setup(t);
  const anonymous = await f.anonymous.get('/api/admin/sync');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.data.error.code, 'signed_out');
  const buyer = await f.as(BUYER);
  assert.equal((await buyer.get('/api/admin/sync')).status, 403);
  assert.equal((await buyer.post('/api/admin/sync', {})).status, 403);
});

test('unconfigured, the status is honest and Sync now explains what is missing without sending anything', async t => {
  const f = await setup(t, { crmMirror: { environment: {} } });
  const admin = await f.as(ADMIN);
  const status = await admin.get('/api/admin/sync');
  assert.equal(status.status, 200);
  assert.equal(status.data.ok, true);
  assert.equal(status.data.configured, false);
  assert.equal(status.data.lastRunAt, null);
  assert.deepEqual(status.data.missing, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DEMO_SUPABASE_MIRROR']);
  assert.ok(status.data.tables.accounts >= 4);
  assert.ok(status.data.tables.orders >= 7);
  for (const name of ['notes', 'payments', 'settlements']) assert.equal(typeof status.data.tables[name], 'number', name);
  const run = await admin.post('/api/admin/sync', {});
  assert.equal(run.status, 409);
  assert.equal(run.data.error.code, 'mirror_not_configured');
  assert.match(run.data.error.message, /not configured/);
  assert.equal((await admin.post('/api/admin/sync', {}, { Origin: 'https://evil.example' })).status, 403);
});

test('a configured Sync now upserts the seeded CRM rows with no password hashes, session tokens or card data', async t => {
  const fake = fakePostgrest();
  const f = await setup(t, { crmMirror: { environment: ENV, fetchImpl: fake.fetchImpl, intervalMs: 3600000 } });
  const buyer = await f.as(BUYER);
  const { data: offers } = await buyer.get('/api/offers?kind=cap');
  const { data: created } = await buyer.post('/api/orders', { offerId: offers.offers[0].id, count: 8 });
  const paid = await buyer.post(`/api/orders/${created.order.ref}/pay`, { card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '987', name: 'Sam Sample' } });
  assert.equal(paid.status, 200);
  const admin = await f.as(ADMIN);
  const run = await admin.post('/api/admin/sync', {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.ok, true);
  // The configured mirror already ran once at startup; Sync now sends what changed since, including the new payment.
  assert.ok(run.data.pushed.payments >= 1);
  const accountIds = new Set(fake.calls.filter(c => c.url.includes('demo_accounts')).flatMap(c => c.body.map(row => row.id)));
  assert.ok(accountIds.size >= 4);
  const remote = new Set(fake.calls.map(c => new URL(c.url).pathname));
  for (const table of ['demo_accounts', 'demo_orders', 'demo_payments']) assert.ok(remote.has(`/rest/v1/${table}`), table);
  const rows = fake.calls.flatMap(c => c.body);
  const keys = new Set(rows.flatMap(Object.keys));
  for (const banned of ['password_hash', 'token_hash', 'brand', 'last4', 'card', 'cvc', 'number', 'api_key_hash', 'seed_key']) assert.equal(keys.has(banned), false, banned);
  const sent = JSON.stringify(rows);
  assert.equal(sent.includes('scrypt$'), false, 'no password hash');
  for (const client of [buyer, admin]) assert.equal(sent.includes(client.cookie.split('=')[1]), false, 'no session token');
  assert.equal(sent.includes('4242424242424242'), false, 'no card number');
  assert.equal(rows.some(row => Object.values(row).includes('987') || Object.values(row).includes('Visa')), false, 'no CVC or brand');
  const payment = fake.calls.filter(c => c.url.includes('demo_payments')).flatMap(c => c.body).find(row => row.order_ref === created.order.ref);
  assert.deepEqual(Object.keys(payment).sort(), ['account_id', 'amount', 'created_at', 'id', 'order_ref', 'outcome', 'status', 'updated_at']);
  const status = await admin.get('/api/admin/sync');
  assert.equal(status.data.configured, true);
  assert.equal(status.data.lastResult.ok, true);
  assert.ok(status.data.lastRunAt);
});
