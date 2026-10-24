import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';
import { openDatabase, get } from '../lib/db.mjs';
import { recordActivity, clientEvent, cleanPath, ACCOUNT_CAP } from '../lib/activity.mjs';

const ADMIN = 'admin@dodona.markets';
const BUYER = 'demo@dodona.markets';
const DECLINED = '4000000000000002';
const ENV = { SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-role-key', DEMO_SUPABASE_MIRROR: '1' };
const card = number => ({ number, expMonth: 12, expYear: 2030, cvc: '123', name: 'Sam Sample' });

async function setup(t, options) {
  const f = await platformFixture(options);
  t.after(() => f.cleanup());
  return f;
}

async function people(f) {
  const buyer = await f.as(BUYER);
  const admin = await f.as(ADMIN);
  const buyerId = (await buyer.get('/api/account')).data.account.id;
  const log = async (query = '') => {
    const response = await admin.get(`/api/admin/accounts/${buyerId}/activity${query ? '?' + query : ''}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  };
  return { buyer, admin, buyerId, log };
}

async function declinedPayment(buyer) {
  const offer = (await buyer.get('/api/offers?kind=cap')).data.offers[0];
  const order = (await buyer.post('/api/orders', { offerId: offer.id, count: 8 })).data.order;
  const paid = await buyer.post(`/api/orders/${order.ref}/pay`, { card: card(DECLINED) });
  assert.equal(paid.status, 402);
  return order.ref;
}

test('an API call by a signed-in account becomes an api row with its status, path keys and an 8-character session id', async t => {
  const f = await setup(t);
  const { buyer, log } = await people(f);
  assert.equal((await buyer.get('/api/offers?gpu=H100&kind=cap')).status, 200);
  const { rows } = await log('kind=api');
  const row = rows.find(r => r.detail.path === '/api/offers?gpu&kind');
  assert.ok(row, JSON.stringify(rows.map(r => r.detail.path)));
  assert.equal(row.kind, 'api');
  assert.equal(row.ok, true);
  assert.equal(row.detail.method, 'GET');
  assert.equal(row.detail.status, 200);
  assert.ok(Number.isInteger(row.detail.ms));
  assert.match(row.sessionId, /^[a-f0-9]{8}$/);
  assert.equal(buyer.cookie.includes(row.sessionId), false, 'the session id is not part of the token');
  assert.equal(JSON.stringify(rows).includes('H100'), false, 'query values are not kept');
});

test('a declined card payment is a failed api row with card_declined, and no card data is stored', async t => {
  const f = await setup(t);
  const { buyer, log } = await people(f);
  const ref = await declinedPayment(buyer);
  const { rows } = await log('failed=1');
  const row = rows.find(r => r.detail.path === `/api/orders/${ref}/pay`);
  assert.ok(row);
  assert.equal(row.ok, false);
  assert.equal(row.detail.method, 'POST');
  assert.equal(row.detail.status, 402);
  assert.equal(row.detail.code, 'card_declined');
  assert.match(row.detail.message, /declined/);
  const everything = JSON.stringify((await log()).rows);
  for (const secret of [DECLINED, '"123"', 'Sam Sample', 'expMonth']) assert.equal(everything.includes(secret), false, secret);
});

test('page views are page rows, and sign-ins are auth rows under the account the email names', async t => {
  const f = await setup(t);
  const { buyer, admin, buyerId, log } = await people(f);
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'not-the-password' })).status, 401);
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: 'nobody@example.com', password: 'not-the-password' })).status, 401);
  await fetch(f.origin + '/offers', { headers: { Cookie: buyer.cookie } });
  await fetch(f.origin + '/dashboard', { headers: { Cookie: buyer.cookie } });
  const { rows } = await log();
  assert.ok(rows.some(r => r.kind === 'page' && r.page === '/offers'));
  assert.ok(rows.some(r => r.kind === 'page' && r.page === '/dashboard'));
  const auth = rows.filter(r => r.kind === 'auth');
  assert.ok(auth.some(r => r.ok && r.detail.path === '/api/auth/sign-in'), 'the successful sign-in');
  const failed = auth.find(r => !r.ok);
  assert.equal(failed.detail.message, 'wrong password');
  assert.equal(failed.detail.code, 'bad_credentials');
  const failures = (await admin.get('/api/admin/activity/failures?limit=50')).data.rows;
  assert.ok(failures.some(r => r.account?.id === buyerId && r.kind === 'auth'));
  assert.equal(JSON.stringify(failures).includes('nobody@example.com'), false, 'an unknown email logs nothing');
  assert.equal(JSON.stringify(rows).includes('not-the-password'), false);
});

test('a batch of browser events is stored, and malformed or oversize events are dropped', async t => {
  const f = await setup(t);
  const { buyer, log } = await people(f);
  const events = [
    { kind: 'click', page: '/dashboard#positions', target: 'Positions', detail: { tag: 'a', nav: 'positions', href: '/dashboard#positions' } },
    { kind: 'nav', page: '/dashboard#overview' },
    { kind: 'error', page: '/offers', detail: { message: 'x is not defined', source: 'http://127.0.0.1/offers.js?v=2', line: 12 } },
    { kind: 'click', page: '/dashboard', target: 'x'.repeat(121) },
    { kind: 'api', page: '/dashboard' },
    { kind: 'click', page: '/dashboard', extra: true },
    { kind: 'click', page: 'dashboard' },
    { kind: 'click', page: '/dashboard', detail: { tag: 'A B' } },
    { kind: 'click', page: '/dashboard', detail: { value: 'typed text' } },
    { kind: 'click', page: '/dashboard', detail: { act: 'y'.repeat(290), nav: 'y'.repeat(290), id: 'y'.repeat(290) }, target: 'z'.repeat(119) },
    'not an event',
  ];
  const response = await buyer.post('/api/activity', { events });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual([response.data.stored, response.data.dropped], [3, 8]);
  const { rows } = await log('kind=click,nav,error');
  assert.equal(rows.length, 3);
  assert.equal(rows.find(r => r.kind === 'click').target, 'Positions');
  const error = rows.find(r => r.kind === 'error');
  assert.equal(error.ok, false);
  assert.equal(error.detail.source, '/offers.js?v');
  assert.equal(JSON.stringify(rows).includes('typed text'), false);
  assert.equal((await buyer.post('/api/activity', { events: 'nope' })).status, 400);
  assert.equal((await buyer.post('/api/activity', '{"events":[]}', { 'Content-Type': 'text/plain;charset=UTF-8' })).status, 200, 'sendBeacon bodies are accepted');
  assert.equal((await buyer.post('/api/activity', '{"events":[]}', { 'Content-Type': 'text/html' })).status, 415);
  const tooMany = await buyer.post('/api/activity', { events: Array.from({ length: 60 }, () => ({ kind: 'nav', page: '/orders' })) });
  assert.equal(tooMany.data.stored, 50);
});

test('a click whose label is a card number is stored with the digits removed', async t => {
  const f = await setup(t);
  const { buyer, log } = await people(f);
  await buyer.post('/api/activity', { events: [{ kind: 'click', page: '/checkout', target: `Pay with ${DECLINED}`, detail: { tag: 'button', id: '4000 0000 0000 0002' } }] });
  const { rows } = await log('kind=click');
  assert.equal(rows[0].target, 'Pay with [number removed]');
  const text = JSON.stringify(rows);
  assert.equal(text.includes(DECLINED), false);
  assert.equal(text.includes('4000 0000 0000 0002'), false);
});

test('signed-out batches are ignored, and no account can read the log except an admin', async t => {
  const f = await setup(t);
  const { buyer, buyerId } = await people(f);
  const anonymous = await f.anonymous.post('/api/activity', { events: [{ kind: 'nav', page: '/dashboard' }] });
  assert.equal(anonymous.status, 200);
  assert.deepEqual([anonymous.data.stored, anonymous.data.signedIn], [0, false]);
  for (const path of [`/api/admin/accounts/${buyerId}/activity`, `/api/admin/accounts/${buyerId}/activity.csv`, '/api/admin/activity/failures']) {
    assert.equal((await buyer.get(path)).status, 403, path);
    assert.equal((await f.anonymous.get(path)).status, 401, path);
  }
  assert.equal((await buyer.get('/api/activity')).status, 405, 'there is no read route for accounts');
});

test('the admin filters, pages and exports the log as CSV', async t => {
  const f = await setup(t);
  const { buyer, admin, buyerId, log } = await people(f);
  await declinedPayment(buyer);
  for (let batch = 0; batch < 3; batch++) {
    const events = Array.from({ length: 50 }, (_, i) => ({ kind: 'click', page: '/offers', target: `Offer ${batch * 50 + i}`, detail: { tag: 'button', act: 'pick' } }));
    assert.equal((await buyer.post('/api/activity', { events })).data.stored, 50);
  }
  const first = await log('kind=click');
  assert.equal(first.rows.length, 100);
  assert.ok(first.nextBefore);
  const second = await log(`kind=click&before=${first.nextBefore}`);
  assert.equal(second.rows.length, 50);
  assert.equal(second.nextBefore, null);
  assert.equal(new Set([...first.rows, ...second.rows].map(r => r.id)).size, 150);
  assert.ok((await log('q=Offer%2012')).rows.every(r => r.target.includes('Offer 12')));
  assert.ok((await log('failed=1')).rows.every(r => !r.ok));
  assert.equal((await log('since=2000-01-01&until=2000-01-02')).rows.length, 0);
  assert.ok((await log('since=2000-01-01T00:00')).rows.length > 0);
  assert.equal((await admin.get(`/api/admin/accounts/${buyerId}/activity?kind=bogus`)).status, 400);
  assert.equal((await admin.get(`/api/admin/accounts/${buyerId}/activity?since=yesterday`)).status, 400);
  assert.equal((await admin.get('/api/admin/accounts/acc_nobody/activity')).status, 404);
  const csv = await admin.get(`/api/admin/accounts/${buyerId}/activity.csv?failed=1`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.data.trim().split('\n');
  assert.equal(lines[0], 'at,kind,result,page,target,status,code,session,detail');
  assert.ok(lines.slice(1).every(line => line.includes(',failed,')));
  assert.ok(lines.some(line => line.includes('card_declined')));
});

test('a demo reset clears the account log', async t => {
  const f = await setup(t);
  const { buyer, admin, buyerId, log } = await people(f);
  await buyer.post('/api/activity', { events: [{ kind: 'nav', page: '/orders' }] });
  assert.ok((await log()).rows.length > 0);
  assert.equal((await admin.post(`/api/admin/accounts/${buyerId}/reset`, {})).status, 200);
  assert.equal((await log()).rows.length, 0);
});

test('each account keeps only its newest rows past the cap', () => {
  const db = openDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  const base = Date.parse('2026-10-01T00:00:00Z');
  for (let i = 0; i < ACCOUNT_CAP + 3; i++) recordActivity(db, { accountId: 'acc_cap', at: new Date(base + i * 1000).toISOString(), kind: 'nav', page: `/p${i}` });
  recordActivity(db, { accountId: 'acc_other', at: new Date(base).toISOString(), kind: 'nav', page: '/other' });
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM activity WHERE account_id = 'acc_cap'").n, ACCOUNT_CAP);
  assert.equal(get(db, "SELECT MIN(page) AS p FROM activity WHERE account_id = 'acc_cap' AND page IN ('/p0', '/p1', '/p2', '/p3')").p, '/p3');
  assert.equal(get(db, "SELECT COUNT(*) AS n FROM activity WHERE account_id = 'acc_other'").n, 1);
});

test('client events keep their own time only when it is recent, and paths lose query values', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  assert.equal(clientEvent({ kind: 'nav', page: '/x', at: '2026-10-23T11:59:58.000Z' }, now).at, '2026-10-23T11:59:58.000Z');
  assert.equal(clientEvent({ kind: 'nav', page: '/x', at: '2020-01-01T00:00:00.000Z' }, now).at, '2026-10-23T12:00:00.000Z');
  assert.equal(cleanPath('/orders/DOD-ABC?email=a%40b.com&gpu=H100#detail'), '/orders/DOD-ABC?email&gpu#detail');
});

test('the Supabase mirror sends failure rows only, with no card data or secrets', async t => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : [] }); return new Response(null, { status: 201 }); };
  const f = await setup(t, { crmMirror: { environment: ENV, fetchImpl, intervalMs: 3600000 } });
  const { buyer, admin } = await people(f);
  await buyer.post('/api/activity', { events: [{ kind: 'click', page: '/checkout', target: 'Pay now', detail: { tag: 'button' } }] });
  await declinedPayment(buyer);
  assert.equal((await admin.post('/api/admin/sync', {})).status, 200);
  const sent = calls.filter(c => c.url.includes('/rest/v1/demo_activity_failures')).flatMap(c => c.body);
  assert.ok(sent.length > 0);
  assert.ok(sent.every(row => ['api', 'error', 'auth'].includes(row.kind)), 'no clicks or page views');
  const declined = sent.find(row => row.detail.code === 'card_declined');
  assert.ok(declined);
  assert.equal(typeof declined.detail, 'object');
  assert.deepEqual(Object.keys(declined).sort(), ['account_id', 'at', 'created_at', 'detail', 'id', 'kind', 'page', 'session_id', 'target']);
  const body = JSON.stringify(sent);
  for (const secret of [DECLINED, '0002', 'cvc', 'Sam Sample', 'demo-dodona-2026', ENV.SUPABASE_SERVICE_ROLE_KEY, buyer.cookie.split('=')[1]]) assert.equal(body.includes(secret), false, secret);
});
