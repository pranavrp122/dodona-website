import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';
import { openDatabase, all } from '../lib/db.mjs';
import { verifyPassword } from '../lib/auth.mjs';
import { luhn, brandOf } from '../lib/payments.mjs';
import { applySchema, SCHEMA_VERSION } from '../lib/schema.mjs';
import { DatabaseSync } from 'node:sqlite';

const BUYER = 'demo@dodona.markets';
const card = (number = '4242 4242 4242 4242') => ({ number, expMonth: 12, expYear: 2030, cvc: '123', name: 'Sam Sample' });

async function setup(t, options) {
  const f = await platformFixture(options);
  t.after(() => f.cleanup());
  return f;
}

async function firstOffer(client, kind = 'cap') {
  const { data } = await client.get(`/api/offers?kind=${kind}`);
  return data.offers[0];
}

test('seeded accounts sign in and are routed to their console by role', async t => {
  const f = await setup(t);
  const homes = { 'demo@dodona.markets': '/dashboard', 'credit@meridian.example': '/dashboard', 'ops@northwind.example': '/provider', 'admin@dodona.markets': '/admin' };
  for (const [email, home] of Object.entries(homes)) {
    const response = await f.anonymous.post('/api/auth/sign-in', { email, password: 'demo-dodona-2026' });
    assert.equal(response.status, 200, email);
    assert.equal(response.data.ok, true);
    assert.equal(response.data.home, home);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^dodona_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/, 'no Secure outside production');
  }
  const buyer = await f.as(BUYER);
  const { data } = await buyer.get('/api/account');
  assert.deepEqual(Object.keys(data.account).sort(), ['autoConfirm', 'company', 'createdAt', 'demoNow', 'email', 'home', 'id', 'kyb', 'lastActiveAt', 'neocloud', 'phone', 'role', 'scenario', 'stage']);
  assert.equal(data.account.company, 'Sample Labs');
  assert.equal(data.account.kyb, 'verified');
  assert.equal(data.account.demoNow, '2026-10-23T12:00:00.000Z');
  const provider = await f.as('ops@northwind.example');
  const nw = (await provider.get('/api/account')).data.account;
  assert.deepEqual(nw.neocloud.name, 'Northwind Compute');
  assert.equal(nw.autoConfirm, true);
});

test('sign-in failures, sign-out and the signed-out state', async t => {
  const f = await setup(t);
  const bad = await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.data, { ok: false, error: { code: 'bad_credentials', message: 'That email and password do not match an account.' } });
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'whatever1' })).status, 401);
  assert.equal((await f.anonymous.get('/api/account')).status, 401);
  const buyer = await f.as(BUYER);
  const out = await buyer.post('/api/auth/sign-out');
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await buyer.get('/api/account')).status, 401, 'the session row is gone');
});

test('sign-in is rate limited to ten tries per ten minutes per address', async t => {
  const f = await setup(t);
  for (let i = 0; i < 10; i++) await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'wrong-password' });
  const limited = await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'demo-dodona-2026' });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('sign-up validates input, sets the cookie and gives a provider its own neocloud', async t => {
  const f = await setup(t);
  const cases = [
    [{ email: 'not-an-email', password: 'longenough', company: 'Acme', role: 'buyer' }, 'invalid_email'],
    [{ email: 'a@acme.example', password: 'short', company: 'Acme', role: 'buyer' }, 'invalid_password'],
    [{ email: 'a@acme.example', password: 'longenough', company: 'Acme', role: 'admin' }, 'invalid'],
    [{ email: 'a@acme.example', password: 'longenough', company: '', role: 'buyer' }, 'invalid'],
  ];
  for (const [body, code] of cases) {
    const response = await f.anonymous.post('/api/auth/sign-up', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.data.error.code, code);
  }
  const made = await f.anonymous.post('/api/auth/sign-up', { email: 'Ops@Acme.example', password: 'longenough', company: 'Acme GPU', role: 'provider' });
  assert.equal(made.status, 201);
  assert.equal(made.data.account.email, 'ops@acme.example');
  assert.equal(made.data.account.neocloud.name, 'Acme GPU');
  assert.equal(made.data.account.home, '/provider');
  assert.ok(!('password' in made.data.account) && !('passwordHash' in made.data.account));
  const again = await f.anonymous.post('/api/auth/sign-up', { email: 'ops@acme.example', password: 'longenough', company: 'Acme', role: 'buyer' });
  assert.equal(again.status, 409);
  const acme = f.client(made.headers.get('set-cookie').split(';')[0]);
  const emails = (await acme.get('/api/emails')).data.emails;
  assert.deepEqual(emails.map(e => e.subject), ['Welcome to Dodona']);
});

test('passwords are scrypt hashes with their own salts and compare in constant time', async () => {
  const { hashPassword } = await import('../lib/auth.mjs');
  const [a, b] = [await hashPassword('same-password'), await hashPassword('same-password')];
  assert.match(a, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(a, b, 'per-user salt');
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('other-password', a), false);
  assert.equal(await verifyPassword('same-password', undefined), false, 'unknown account still runs scrypt and fails');
});

test('every platform POST refuses another origin and a cross-site fetch', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const evil = await buyer.post('/api/orders', { offerId: 'x', count: 8 }, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.error.code, 'bad_origin');
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'demo-dodona-2026' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const text = await buyer.post('/api/orders', 'offerId=x', { 'Content-Type': 'text/plain' });
  assert.equal(text.status, 415, 'a simple form post cannot create an order');
});

test('the offer board lists caps, floors and locks from both neoclouds with filters', async t => {
  const f = await setup(t);
  const { data } = await f.anonymous.get('/api/offers');
  assert.equal(data.offers.length, 14);
  assert.deepEqual(new Set(data.offers.map(o => o.kind)), new Set(['cap', 'floor', 'lock']));
  assert.deepEqual(new Set(data.offers.map(o => o.neocloud.name)), new Set(['Northwind Compute', 'Helix Cloud']));
  assert.deepEqual(new Set(data.offers.map(o => o.gpu)), new Set(['H100', 'H200', 'B200', 'A100']));
  for (const offer of data.offers) {
    assert.ok(Date.parse(offer.start) >= Date.parse('2026-10-30T00:00:00Z') && Date.parse(offer.start) <= Date.parse('2027-01-15T00:00:00Z'), offer.start);
    if (offer.kind === 'lock') assert.equal(offer.premiumPerGpuHour, 0);
    else assert.ok(offer.premiumPerGpuHour >= 0.01, `${offer.kind} premium`);
    assert.ok(offer.availableGpus > 0 && offer.availableGpus <= offer.maxGpus);
  }
  assert.ok(data.offers.filter(o => o.kind === 'floor').every(o => /usually bought by providers/i.test(o.note)));
  const h100 = (await f.anonymous.get('/api/offers?gpu=H100&kind=cap')).data.offers;
  assert.ok(h100.length >= 3 && h100.every(o => o.gpu === 'H100' && o.kind === 'cap'));
  const one = await f.anonymous.get(`/api/offers/${h100[0].id}`);
  assert.equal(one.data.offer.id, h100[0].id);
  assert.equal((await f.anonymous.get('/api/offers/of_missing')).status, 404);
});

test('an order from an offer carries the full breakdown; a cap pays its premium now and a lock pays nothing now', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const offer = await firstOffer(buyer, 'cap');
  const created = await buyer.post('/api/orders', { offerId: offer.id, count: 16 });
  assert.equal(created.status, 201);
  const order = created.data.order;
  const hours = 16 * (Date.parse(offer.end) - Date.parse(offer.start)) / 3600000;
  assert.equal(order.status, 'pending_payment');
  assert.equal(order.gpuHours, hours);
  assert.equal(order.breakdown.premiumTotal, Math.round(offer.premiumPerGpuHour * hours * 100) / 100);
  assert.equal(order.breakdown.platformFee, Math.round(order.breakdown.premiumTotal * 0.15 * 100) / 100);
  assert.ok(!('bookingFee' in order.breakdown), 'no flat per-order fee');
  assert.equal(order.breakdown.payNow, order.breakdown.premiumTotal, 'a cap pays the premium up front and nothing else');
  assert.equal(order.breakdown.breakEven, Math.round((offer.strike + offer.premiumPerGpuHour) * 100) / 100);
  assert.equal(order.payNow, order.breakdown.payNow, 'flat copy of the breakdown');
  const lock = await buyer.post('/api/orders', { offerId: (await firstOffer(buyer, 'lock')).id, count: 8 });
  assert.equal(lock.data.order.premiumTotal, 0);
  assert.equal(lock.data.order.payNow, 0);
  assert.equal(lock.data.order.breakEven, null);
  for (const [body, status] of [[{ offerId: offer.id, count: 4 }, 400], [{ offerId: offer.id, count: 129 }, 400], [{ offerId: 'of_nope', count: 8 }, 404], [{ offerId: offer.id, count: 8, extra: 1 }, 400]]) {
    assert.equal((await buyer.post('/api/orders', body)).status, status, JSON.stringify(body));
  }
  const listed = (await buyer.get('/api/orders')).data.orders;
  assert.equal(listed[0].status, 'pending_payment');
});

test('a custom order is priced like /api/quote at the demo clock and checked at the boundary', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const custom = { gpu: 'H100', count: 8, start: '2026-11-20T00:00:00Z', end: '2026-11-27T00:00:00Z', kind: 'floor', strike: 2.5 };
  const made = await buyer.post('/api/orders', { custom });
  assert.equal(made.status, 201);
  assert.equal(made.data.order.kind, 'floor');
  assert.equal(made.data.order.neocloud.name, 'Northwind Compute');
  assert.equal(made.data.order.breakEven, Math.round((2.5 - made.data.order.premiumPerGpuHour) * 100) / 100);
  assert.equal((await buyer.post('/api/orders', { custom: { ...custom, count: 7 } })).status, 400);
  assert.equal((await buyer.post('/api/orders', { custom: { ...custom, start: '2026-10-24T00:00:00Z' } })).status, 400, 'inside 48 hours');
  assert.equal((await buyer.post('/api/orders', { custom: { ...custom, kind: 'swap' } })).status, 400);
  assert.equal((await buyer.post('/api/orders', { custom: { ...custom, region: 'Europe', gpu: 'A100' } })).status, 409, 'no A100 in Europe');
  const admin = await f.as('admin@dodona.markets');
  assert.equal((await admin.post('/api/orders', { custom })).status, 403, 'admins do not buy');
});

test('mock payment: success reserves capacity, declines answer 402 and leave the order unpaid', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const offer = await firstOffer(buyer, 'cap');
  const order = (await buyer.post('/api/orders', { offerId: offer.id, count: 8 })).data.order;
  const declined = await buyer.post(`/api/orders/${order.ref}/pay`, { card: card('4000000000000002') });
  assert.equal(declined.status, 402);
  assert.equal(declined.data.error.code, 'card_declined');
  assert.equal((await buyer.post(`/api/orders/${order.ref}/pay`, { card: card('4000000000009995') })).data.error.code, 'insufficient_funds');
  assert.equal((await buyer.post(`/api/orders/${order.ref}/pay`, { card: card('4242424242424241') })).data.error.code, 'invalid_card');
  assert.equal((await buyer.post(`/api/orders/${order.ref}/pay`, { card: { ...card(), expYear: 2025 } })).data.error.code, 'invalid_card');
  assert.equal((await buyer.get(`/api/orders/${order.ref}`)).data.order.status, 'pending_payment');
  const paid = await buyer.post(`/api/orders/${order.ref}/pay`, { card: card() });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.order.status, 'reserving');
  assert.deepEqual(paid.data.order.payment, { method: 'card', brand: 'Visa', last4: '4242' });
  assert.equal((await buyer.post(`/api/orders/${order.ref}/pay`, { card: card() })).status, 409, 'cannot pay twice');
  const detail = (await buyer.get(`/api/orders/${order.ref}`)).data;
  assert.deepEqual(detail.events.map(e => [e.type, e.direction]), [['reservation.requested', 'dodona_to_neocloud']]);
  assert.deepEqual(detail.payouts.map(p => p.direction).sort(), ['premium_to_dodona', 'premium_to_neocloud']);
  const split = Object.fromEntries(detail.payouts.map(p => [p.direction, p.amount]));
  assert.equal(Math.round((split.premium_to_neocloud + split.premium_to_dodona) * 100) / 100, order.premiumTotal);
  assert.deepEqual(detail.emails.map(e => e.subject), [`Receipt for ${order.ref}`]);
  const other = await f.as('credit@meridian.example');
  assert.equal((await other.get(`/api/orders/${order.ref}`)).status, 404, 'other accounts cannot see it');
  assert.equal((await other.post(`/api/orders/${order.ref}/pay`, { card: card() })).status, 404);
});

test('a lock confirms with nothing to pay and moves on exactly like a paid cap', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const cap = (await buyer.post('/api/orders', { offerId: (await firstOffer(buyer, 'cap')).id, count: 8 })).data.order;
  const capPaid = await buyer.post(`/api/orders/${cap.ref}/pay`, { card: card() });
  const lock = (await buyer.post('/api/orders', { offerId: (await firstOffer(buyer, 'lock')).id, count: 8 })).data.order;
  assert.equal(lock.payNow, 0);
  const confirmed = await buyer.post(`/api/orders/${lock.ref}/pay`, {});
  assert.equal(confirmed.status, 200, 'no card is needed when nothing is due');
  assert.equal(confirmed.data.order.status, capPaid.data.order.status, 'same post-payment status as a paid cap');
  assert.equal(confirmed.data.order.status, 'reserving');
  assert.deepEqual(confirmed.data.order.payment, { method: 'none', brand: null, last4: null });
  assert.equal((await buyer.post(`/api/orders/${lock.ref}/pay`, {})).status, 409, 'cannot confirm twice');
  const detail = (await buyer.get(`/api/orders/${lock.ref}`)).data;
  assert.deepEqual(detail.events.map(e => [e.type, e.direction]), [['reservation.requested', 'dodona_to_neocloud']]);
  assert.deepEqual(detail.payouts, [], 'no premium to split');
  const receipt = detail.emails.find(e => e.subject === `Receipt for ${lock.ref}`);
  assert.ok(receipt.body.includes('Nothing was charged now') && receipt.body.includes('compute bill comes at settlement'));
  assert.ok(!/payment of \$/.test(receipt.body));
  const still = (await buyer.post('/api/orders', { offerId: (await firstOffer(buyer, 'cap')).id, count: 8 })).data.order;
  assert.equal((await buyer.post(`/api/orders/${still.ref}/pay`, {})).data.error.code, 'invalid_card', 'a cap still needs a card');
});

test('no card number or CVC is stored or logged anywhere', async t => {
  const db = openDatabase(':memory:');
  const f = await setup(t, { db });
  const buyer = await f.as(BUYER);
  const offer = await firstOffer(buyer, 'cap');
  for (const number of ['4000000000000002', '4242424242424242', '5555555555554444']) {
    const order = (await buyer.post('/api/orders', { offerId: offer.id, count: 8 })).data.order;
    await buyer.post(`/api/orders/${order.ref}/pay`, { card: { ...card(number), cvc: '987' } });
  }
  const dump = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map(({ name }) => JSON.stringify(all(db, `SELECT * FROM ${name}`))).join('\n');
  for (const secret of ['4000000000000002', '4242424242424242', '5555555555554444', '"987"']) assert.ok(!dump.includes(secret), `database holds ${secret}`);
  assert.ok(dump.includes('"last4":"4444"') && dump.includes('"brand":"Mastercard"'), 'brand and last4 are kept');
  assert.ok(!f.logs.join('\n').match(/\d{12,19}/), 'nothing card-like in the logs');
});

test('Luhn check and card brands', () => {
  assert.equal(luhn('4242424242424242'), true);
  assert.equal(luhn('4242424242424241'), false);
  assert.deepEqual(['4242424242424242', '5555555555554444', '2223003122003222', '378282246310005', '6011111111111117'].map(brandOf), ['Visa', 'Mastercard', 'Mastercard', 'Amex', 'Card']);
});

test('GET /api/portfolio reads the signed-in account’s paid orders from the database', async t => {
  const f = await setup(t);
  assert.equal((await f.anonymous.get('/api/portfolio')).status, 401);
  const buyer = await f.as(BUYER);
  const { status, data } = await buyer.get('/api/portfolio');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  for (const key of ['asOf', 'prices', 'account', 'kpis', 'positions', 'history', 'alerts', 'fleets', 'provider']) assert.ok(key in data, key);
  assert.equal(data.asOf, '2026-10-23');
  assert.deepEqual(data.positions.map(p => p.id), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']);
  for (const p of data.positions) assert.match(p.orderRef, /^DOD-[A-Z]{6}$/);
  assert.deepEqual(data.positions.map(p => p.kind), ['lock', 'call', 'lock', 'offtake', 'offtake', 'lock', 'call']);
  assert.ok(data.positions.every(p => typeof p.orderStatus === 'string' && p.deliveryChoice === 'deliver'));
  assert.equal(data.account.organisation, 'Sample Labs');
  assert.equal(data.fleets.length, 0, 'buyers carry no lender facilities');
  const floor = await buyer.post('/api/orders', { offerId: (await firstOffer(buyer, 'floor')).id, count: 8 });
  await buyer.post(`/api/orders/${floor.data.order.ref}/pay`, { card: card() });
  const after = (await buyer.get('/api/portfolio')).data;
  const put = after.positions.find(p => p.orderRef === floor.data.order.ref);
  assert.equal(put.kind, 'put');
  assert.ok(put.valuation.value >= 0 && put.valuation.breakEven < put.pricePerGpuHour);
  assert.equal(after.kpis.putCount, 1);
  const lender = await f.as('credit@meridian.example');
  const book = (await lender.get('/api/portfolio')).data;
  assert.equal(book.fleets.length, 3);
  assert.equal(book.positions.length, 0);
});

test('GET /api/index flags synthetic prints after the real as-of date and stops at the demo clock', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const { data } = await buyer.get('/api/index?gpu=H100&from=2026-10-10');
  assert.equal(data.points.at(-1).date, '2026-10-23');
  assert.deepEqual(data.points.filter(p => p.synthetic).map(p => p.date), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
  const again = (await buyer.get('/api/index?gpu=H100&from=2026-10-10')).data;
  assert.deepEqual(again.points, data.points, 'prints are stored and reused');
  assert.equal((await buyer.get('/api/index?gpu=TPU')).status, 400);
  assert.ok((await f.anonymous.get('/api/index?gpu=H100')).data.points.every(p => !p.synthetic), 'signed out sees real prints only');
});

test('with the platform off every platform route and page is a 404 and the dashboard says so', async t => {
  const f = await setup(t, { platform: false });
  for (const path of ['/api/auth/sign-in', '/api/orders', '/api/demo/advance', '/api/provider/overview', '/api/admin/accounts']) {
    assert.equal((await f.anonymous.post(path, {})).status, 404, path);
  }
  for (const path of ['/api/offers', '/api/account', '/api/emails', '/api/statements', '/api/statements.csv', '/api/integration/events', '/api/portfolio', '/sign-in', '/offers', '/orders/DOD-ABCDEF', '/provider', '/admin', '/docs/neocloud-api']) {
    assert.equal((await f.anonymous.get(path)).status, 404, path);
  }
  const page = await f.anonymous.get('/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.data, /The demo platform is off\./);
  assert.equal((await f.anonymous.get('/')).status, 200, 'the public site is untouched');
});

test('the platform is on by default outside production and needs DEMO_PLATFORM=1 in production', async () => {
  const { platformEnabled } = await import('../lib/platform.mjs');
  assert.equal(platformEnabled({ production: false, environment: {} }), true);
  assert.equal(platformEnabled({ production: true, environment: {} }), false);
  assert.equal(platformEnabled({ production: true, environment: { DEMO_PLATFORM: '1' } }), true);
  assert.equal(platformEnabled({ production: false, environment: { DEMO_PLATFORM: '0' } }), false);
});

test('an older database loses the flat fee column once, keeps its rows and amounts, and a second run changes nothing', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db, '2026-10-01T00:00:00.000Z');
  db.exec("ALTER TABLE orders ADD COLUMN booking_fee REAL NOT NULL DEFAULT 2");
  db.exec("UPDATE schema_version SET version = 2");
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare(`INSERT INTO orders (ref, account_id, neocloud_id, gpu, config, region, kind, count, start, end, strike, premium_per_gpu_hour, premium_total, platform_fee, pay_now, gpu_hours, status, ordered_at, created_at, updated_at)
    VALUES ('DOD-OLD', 'acc_1', 'nc_1', 'H100', 'SXM-IB', 'US East', 'cap', 8, '2026-11-01', '2026-11-08', 2.5, 0.1, 134.4, 20.16, 136.4, 1344, 'paid', '2026-10-01', '2026-10-01', '2026-10-01')`).run();
  db.prepare("INSERT INTO payments (id, order_ref, account_id, amount, brand, last4, status, at, created_at, updated_at) VALUES ('pay_old', 'DOD-OLD', 'acc_1', 136.4, 'Visa', '4242', 'succeeded', '2026-10-01', '2026-10-01', '2026-10-01')").run();
  db.exec('PRAGMA foreign_keys = ON');
  const columns = () => db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  assert.ok(columns().includes('booking_fee'));
  applySchema(db, '2026-10-24T00:00:00.000Z');
  assert.ok(!columns().includes('booking_fee'), 'the column is dropped');
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(db.prepare("SELECT pay_now FROM orders WHERE ref = 'DOD-OLD'").get().pay_now, 136.4, 'recorded amounts stay as they were');
  assert.equal(db.prepare("SELECT amount FROM payments WHERE id = 'pay_old'").get().amount, 136.4);
  applySchema(db, '2026-10-25T00:00:00.000Z');
  assert.deepEqual(columns().filter(c => c === 'booking_fee'), [], 'running again is a no-op');
  db.close();
});
