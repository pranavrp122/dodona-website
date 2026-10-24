import test from 'node:test';
import assert from 'node:assert/strict';
import { platformFixture } from './fixture.mjs';
import { computeSettlement } from '../lib/settlement.mjs';
import { openDatabase, all } from '../lib/db.mjs';

const BUYER = 'demo@dodona.markets';
const PROVIDER = 'ops@northwind.example';
const ADMIN = 'admin@dodona.markets';
const card = (number = '4242424242424242') => ({ number, expMonth: 12, expYear: 2030, cvc: '123', name: 'Sam Sample' });
const cents = v => Math.round(v * 100) / 100;

async function setup(t, options) {
  const f = await platformFixture(options);
  t.after(() => f.cleanup());
  return f;
}

async function buy(client, { kind = 'cap', gpu, region, count = 8 } = {}) {
  const query = new URLSearchParams({ kind, ...(gpu ? { gpu } : {}), ...(region ? { region } : {}) });
  const offer = (await client.get(`/api/offers?${query}`)).data.offers[0];
  const order = (await client.post('/api/orders', { offerId: offer.id, count })).data.order;
  const paid = await client.post(`/api/orders/${order.ref}/pay`, { card: card() });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  return { offer, order: paid.data.order };
}

const detail = async (client, ref) => (await client.get(`/api/orders/${ref}`)).data;

test('settlement math: caps, floors and locks on the window average, including negative results', () => {
  const order = (kind, extra = {}) => ({ kind, strike: 2.5, gpu_hours: 1000, premium_total: kind === 'lock' ? 0 : 120, resold_to_json: null, ...extra });
  const capAbove = computeSettlement(order('cap'), 2.9, 'T');
  assert.deepEqual([capAbove.computeBill, capAbove.saving, capAbove.netResult, capAbove.billedTo], [2500, 400, 280, 'holder'], 'pays the cap, saves the difference');
  const capBelow = computeSettlement(order('cap'), 2.2, 'T');
  assert.deepEqual([capBelow.computeBill, capBelow.saving, capBelow.netResult], [2200, 0, -120], 'pays the lower average; the premium is the loss');
  const floorBelow = computeSettlement(order('floor'), 2.1, 'T');
  assert.deepEqual([floorBelow.payout, floorBelow.netResult, floorBelow.computeBill], [400, 280, null]);
  assert.equal(computeSettlement(order('floor'), 2.8, 'T').netResult, -120, 'a floor above the average pays nothing');
  const lockUp = computeSettlement(order('lock'), 2.9, 'T');
  assert.deepEqual([lockUp.computeBill, lockUp.saving, lockUp.netResult], [2500, 400, 400]);
  const lockDown = computeSettlement(order('lock'), 2.3, 'T');
  assert.deepEqual([lockDown.computeBill, lockDown.saving, lockDown.netResult], [2500, -200, -200], 'a lock pays its fixed price even when the index is lower');
  const resold = computeSettlement(order('cap', { resold_to_json: JSON.stringify({ pricePerHour: 2.75 }) }), 2.9, 'T');
  assert.deepEqual([resold.resaleProceeds, resold.billedTo, resold.netResult], [250, 'resale buyer', 130], '(bid − min(avg, K)) × hours');
  const resoldLow = computeSettlement(order('cap', { resold_to_json: JSON.stringify({ pricePerHour: 2.3 }) }), 2.2, 'T');
  assert.equal(resoldLow.netResult, cents((2.3 - 2.2) * 1000 - 120));
});

test('full flow: sign in, order, pay, reserve, deliver, settle on the window average, pay out and state it', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const { offer, order } = await buy(buyer);
  assert.equal(order.status, 'reserving');
  let step = await buyer.post('/api/demo/advance', { until: 'next-event' });
  assert.equal(step.data.demoNow, '2026-10-23T13:00:00.000Z', 'auto-confirm one hour after the request');
  assert.ok(step.data.fired.some(e => e.type === 'reservation.confirmed' && e.orderRef === order.ref));
  assert.equal((await detail(buyer, order.ref)).order.status, 'reserved');
  const into = new Date(Date.parse(offer.start) + 36 * 3600000).toISOString();
  step = await buyer.post('/api/demo/advance', { to: into });
  assert.equal(step.status, 200);
  let d = await detail(buyer, order.ref);
  assert.equal(d.order.status, 'delivering');
  assert.equal(d.events.filter(e => e.type === 'usage.reported').length, 1, 'one day of usage reported');
  assert.equal(d.events.find(e => e.type === 'usage.reported').payload.gpuHours, 8 * 24);
  step = await buyer.post('/api/demo/advance', { until: 'settlement' });
  assert.equal(step.data.demoNow, offer.end);
  d = await detail(buyer, order.ref);
  assert.equal(d.order.status, 'settled');
  const points = (await buyer.get(`/api/index?gpu=H100&from=${offer.start.slice(0, 10)}&to=${offer.end.slice(0, 10)}`)).data.points.filter(p => p.date < offer.end.slice(0, 10));
  const average = points.reduce((s, p) => s + p.price, 0) / points.length;
  const s = d.settlement;
  assert.equal(points.length, 7);
  assert.equal(s.windowAvg, Math.round(average * 10000) / 10000, 'settles on the window average of the daily index');
  assert.equal(s.computeBill, cents(Math.min(s.windowAvg, offer.strike) * order.gpuHours));
  assert.equal(s.saving, cents(Math.max(s.windowAvg - offer.strike, 0) * order.gpuHours));
  assert.equal(s.netResult, cents(s.saving - order.premiumTotal));
  assert.deepEqual(d.payouts.filter(p => p.direction === 'buyer_to_neocloud').map(p => p.status), ['scheduled']);
  await buyer.post('/api/demo/advance', { days: 1 });
  d = await detail(buyer, order.ref);
  assert.ok(d.payouts.every(p => p.status === 'paid'), 'compute bill paid one simulated day later');
  const types = d.events.map(e => e.type);
  for (const type of ['reservation.requested', 'reservation.confirmed', 'delivery.started', 'usage.reported', 'window.closed', 'settlement.computed', 'invoice.issued', 'payout.issued']) assert.ok(types.includes(type), type);
  assert.deepEqual(d.emails.map(e => e.subject.split(':')[0].split(' for ')[0].split(' on ')[0]), ['Receipt', 'Capacity reserved', 'Your window starts tomorrow', 'Your window has started', 'Statement']);
  const statement = (await buyer.get('/api/statements')).data;
  const rows = statement.rows.filter(r => r.orderRef === order.ref);
  assert.deepEqual(rows.map(r => r.type).sort(), ['booking_fee', 'compute_bill', 'premium']);
  assert.equal(rows.find(r => r.type === 'compute_bill').amount, -s.computeBill);
  const month = statement.months.find(m => m.month === offer.end.slice(0, 7));
  assert.ok(month.computeBills >= s.computeBill);
  const csv = await fetch(f.origin + '/api/statements.csv', { headers: { Cookie: buyer.cookie } });
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(await csv.text(), new RegExp(`^date,orderRef,type,description,amount\\n[\\s\\S]*${order.ref},compute_bill,Compute bill,-${s.computeBill.toFixed(2)}`));
  const audit = await (await fetch(`${f.origin}/api/audit?kind=settlement&limit=1000`)).json();
  assert.ok(audit.entries.some(e => e.ref === order.ref), 'settlement audited');
  assert.ok((await (await fetch(`${f.origin}/api/audit?kind=payment&limit=1000`)).json()).entries.some(e => e.ref === order.ref), 'payment audited');
});

test('a floor pays the holder when the window average falls below it, from the matched buyer pool (simulated)', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  assert.equal((await buyer.post('/api/demo/scenario', { scenario: 'fall' })).data.scenario, 'fall');
  const { offer, order } = await buy(buyer, { kind: 'floor', gpu: 'H100', region: 'US East' });
  await buyer.post('/api/demo/advance', { to: offer.end });
  await buyer.post('/api/demo/advance', { days: 1 });
  const d = await detail(buyer, order.ref);
  assert.ok(d.settlement.windowAvg < offer.strike, 'the fall scenario takes the index below the floor');
  assert.equal(d.settlement.payout, cents((offer.strike - d.settlement.windowAvg) * order.gpuHours));
  assert.equal(d.settlement.netResult, cents(d.settlement.payout - order.premiumTotal));
  assert.deepEqual(d.payouts.filter(p => p.direction === 'floor_to_holder').map(p => [p.amount, p.status]), [[d.settlement.payout, 'paid']]);
  assert.ok(d.emails.some(e => e.subject.startsWith('Payout issued')));
  assert.equal((await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3 })).status, 409, 'floors have no hours to resell');
});

test('a provider with auto-confirm off confirms or declines in the portal; a decline refunds through the escrow agent', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const provider = await f.as(PROVIDER);
  assert.equal((await provider.post('/api/provider/settings', { autoConfirm: false })).data.neocloud.autoConfirm, false);
  const first = await buy(buyer, { kind: 'cap', region: 'US East', gpu: 'H100' });
  const second = await buy(buyer, { kind: 'lock', region: 'US East', gpu: 'H100' });
  await buyer.post('/api/demo/advance', { days: 1 });
  assert.equal((await detail(buyer, first.order.ref)).order.status, 'reserving', 'waits for the provider');
  const incoming = (await provider.get('/api/provider/orders')).data.incoming;
  assert.deepEqual(incoming.map(o => o.ref).sort(), [first.order.ref, second.order.ref].sort());
  assert.equal(incoming[0].buyer, 'Sample Labs');
  assert.equal((await provider.get('/api/provider/overview')).data.pendingConfirmations, 2);
  const confirmed = await provider.post(`/api/provider/orders/${first.order.ref}/confirm`);
  assert.equal(confirmed.data.order.status, 'reserved');
  const declined = await provider.post(`/api/provider/orders/${second.order.ref}/decline`);
  assert.equal(declined.data.order.status, 'declined');
  assert.equal((await provider.post(`/api/provider/orders/${second.order.ref}/confirm`)).status, 409);
  const d = await detail(buyer, second.order.ref);
  assert.ok(d.events.some(e => e.type === 'reservation.declined' && e.direction === 'neocloud_to_dodona'));
  assert.ok(d.emails.some(e => e.subject.startsWith('Reservation declined')));
  assert.ok((await buyer.get('/api/statements')).data.rows.some(r => r.type === 'refund' && r.orderRef === second.order.ref));
  assert.ok(!(await buyer.get('/api/portfolio')).data.positions.some(p => p.orderRef === second.order.ref), 'declined orders leave the book');
  const helix = await buy(buyer, { kind: 'cap', region: 'Europe' });
  assert.equal((await provider.post(`/api/provider/orders/${helix.order.ref}/confirm`)).status, 404, 'not visible on another neocloud');
});

test('listing unused hours: the market bids a day later, raises on a counter, and an accepted bid resells the hours', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const { offer, order } = await buy(buyer, { kind: 'cap', gpu: 'H100', region: 'US West' });
  await buyer.post('/api/demo/advance', { until: 'next-event' });
  const listed = await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3.5 });
  assert.equal(listed.status, 200);
  assert.deepEqual([listed.data.order.listing.status, listed.data.order.deliveryChoice], ['open', 'resell']);
  assert.equal((await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3.4 })).status, 409, 'already listed');
  const step = await buyer.post('/api/demo/advance', { days: 1 });
  assert.ok(step.data.fired.some(e => e.type === 'bid.received'));
  let d = await detail(buyer, order.ref);
  const [bid] = d.bids;
  assert.equal(bid.bidder, 'Halden Research');
  assert.equal(bid.status, 'open');
  const portfolio = (await buyer.get('/api/portfolio')).data;
  assert.equal(portfolio.positions.find(p => p.orderRef === order.ref).status, 'listed');
  const countered = await buyer.post(`/api/orders/${order.ref}/counter`, { bidId: bid.id, askPerHour: 3.4 });
  assert.equal(countered.status, 200);
  assert.ok(countered.data.bid.pricePerHour >= bid.pricePerHour && countered.data.bid.pricePerHour <= cents(bid.pricePerHour + 0.05), 'raised by at most five cents');
  assert.equal((await buyer.post(`/api/orders/${order.ref}/accept-bid`, { bidId: bid.id })).status, 409, 'a countered bid is closed');
  const accepted = await buyer.post(`/api/orders/${order.ref}/accept-bid`, { bidId: countered.data.bid.id });
  assert.equal(accepted.data.order.resoldTo.pricePerHour, countered.data.bid.pricePerHour);
  assert.equal(accepted.data.order.listing.status, 'accepted');
  await buyer.post('/api/demo/advance', { to: offer.end });
  await buyer.post('/api/demo/advance', { days: 1 });
  d = await detail(buyer, order.ref);
  const s = d.settlement;
  assert.equal(s.billedTo, 'resale buyer');
  assert.equal(s.resaleProceeds, cents((countered.data.bid.pricePerHour - Math.min(s.windowAvg, offer.strike)) * order.gpuHours));
  assert.equal(d.events.find(e => e.type === 'delivery.started').payload.deliverTo, 'resale buyer');
  assert.ok(d.events.some(e => e.type === 'resale.completed'));
  const rows = (await buyer.get('/api/statements')).data.rows.filter(r => r.orderRef === order.ref);
  assert.ok(!rows.some(r => r.type === 'compute_bill'), 'the resale buyer pays the compute bill');
  if (s.resaleProceeds > 0) assert.ok(rows.some(r => r.type === 'resale_proceeds' && r.amount === s.resaleProceeds));
});

test('withdraw and choice before the window; nothing changes once it starts', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const { offer, order } = await buy(buyer, { kind: 'lock', gpu: 'H100' });
  await buyer.post('/api/demo/advance', { until: 'next-event' });
  await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3 });
  const withdrawn = await buyer.post(`/api/orders/${order.ref}/withdraw`);
  assert.deepEqual([withdrawn.data.order.listing.status, withdrawn.data.order.deliveryChoice], ['withdrawn', 'deliver']);
  assert.equal((await buyer.post(`/api/orders/${order.ref}/choice`, { choice: 'resell' })).data.order.deliveryChoice, 'resell');
  assert.equal((await buyer.post(`/api/orders/${order.ref}/choice`, { choice: 'maybe' })).status, 400);
  await buyer.post('/api/demo/advance', { to: offer.start });
  assert.equal((await buyer.post(`/api/orders/${order.ref}/choice`, { choice: 'deliver' })).status, 409);
  assert.equal((await buyer.post(`/api/orders/${order.ref}/list`, { askPerHour: 3 })).status, 409);
});

test('the demo clock validates its input and stays within 400 days of today', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  for (const body of [{}, { days: 1, until: 'settlement' }, { days: -1 }, { days: 401 }, { to: 'tomorrow' }, { until: 'forever' }, { to: '2026-10-01T00:00:00Z' }]) {
    assert.equal((await buyer.post('/api/demo/advance', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await buyer.post('/api/demo/advance', { to: '2027-12-01T00:00:00Z' })).status, 400, 'more than 400 days ahead');
  assert.equal((await buyer.post('/api/demo/scenario', { scenario: 'crash' })).status, 400);
  assert.equal((await f.anonymous.post('/api/demo/advance', { days: 1 })).status, 401);
});

test('scenarios regenerate synthetic prints deterministically', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  await buyer.post('/api/demo/advance', { days: 70 });
  const read = async () => (await buyer.get('/api/index?gpu=H100&from=2026-10-17')).data.points;
  const market = await read();
  await buyer.post('/api/demo/scenario', { scenario: 'rise' });
  const rise = await read();
  assert.ok(rise.at(-1).price > rise[0].price * 1.25, 'rise adds about 35% over 60 days');
  await buyer.post('/api/demo/scenario', { scenario: 'flat' });
  const flat = await read();
  assert.ok(Math.abs(flat.at(-1).price / flat[0].price - 1) < 0.1, 'flat has no drift');
  await buyer.post('/api/demo/scenario', { scenario: 'market' });
  assert.deepEqual(await read(), market, 'same seed, same prints');
  assert.equal(market[0].synthetic, false);
});

test('reset reseeds the account: clock back to today and the seven sample orders again', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  await buy(buyer);
  await buyer.post('/api/demo/advance', { days: 30 });
  const reset = await buyer.post('/api/demo/reset');
  assert.equal(reset.data.account.demoNow, '2026-10-23T12:00:00.000Z');
  assert.equal(reset.data.account.scenario, 'market');
  const orders = (await buyer.get('/api/orders')).data.orders;
  assert.equal(orders.length, 7);
  const statuses = Object.fromEntries((await buyer.get('/api/portfolio')).data.positions.map(p => [p.id, p.orderStatus]));
  assert.deepEqual(statuses, { H1: 'reserved', H2: 'reserved', H3: 'delivering', H4: 'reserved', H5: 'reserved', H6: 'settled', H7: 'reserved' });
  const h6 = orders.find(o => o.settlement);
  assert.equal(h6.kind, 'lock');
  assert.equal(h6.settlement.computeBill, cents(0.82 * h6.gpuHours));
});

test('role gating: buyers cannot reach provider or admin routes, and each portal is its own', async t => {
  const f = await setup(t);
  const [buyer, provider, admin] = [await f.as(BUYER), await f.as(PROVIDER), await f.as(ADMIN)];
  const providerPaths = ['/api/provider/overview', '/api/provider/orders', '/api/provider/contracts', '/api/provider/settlements', '/api/provider/payouts', '/api/provider/events', '/api/provider/settings'];
  const adminPaths = ['/api/admin/accounts', '/api/admin/accounts.csv', '/api/admin/orders', '/api/admin/neoclouds', '/api/admin/events', '/api/admin/sync'];
  for (const path of providerPaths) {
    assert.equal((await buyer.get(path)).status, 403, `buyer ${path}`);
    assert.equal((await admin.get(path)).status, 403, `admin ${path}`);
    assert.equal((await f.anonymous.get(path)).status, 401, `signed out ${path}`);
    assert.equal((await provider.get(path)).status, 200, `provider ${path}`);
  }
  for (const path of adminPaths) {
    assert.equal((await buyer.get(path)).status, 403, `buyer ${path}`);
    assert.equal((await provider.get(path)).status, 403, `provider ${path}`);
    assert.equal((await admin.get(path)).status, 200, `admin ${path}`);
  }
  for (const [path, body] of [['/api/provider/api-key'], ['/api/provider/settings', { autoConfirm: false }], ['/api/admin/sync'], ['/api/admin/accounts', { email: 'x@y.example', password: 'longenough', company: 'X', role: 'buyer' }]]) {
    const response = await buyer.post(path, body);
    assert.equal(response.status, 403, path);
    assert.equal(response.data.error.code, 'forbidden');
  }
});

test('provider portal: capacity, contracts from both sides, settings and a mock API key shown once', async t => {
  const db = openDatabase(':memory:');
  const f = await setup(t, { db });
  const buyer = await f.as(BUYER);
  const provider = await f.as(PROVIDER);
  const { order } = await buy(buyer, { kind: 'cap', gpu: 'H100', region: 'US East', count: 64 });
  const overview = (await provider.get('/api/provider/overview')).data;
  const h100 = overview.capacity.find(c => c.gpu === 'H100' && c.region === 'US East');
  assert.equal(h100.total, 1024);
  assert.ok(h100.reserved >= 64 && h100.free === h100.total - h100.reserved);
  const floor = await buy(provider, { kind: 'floor', region: 'Europe' });
  const contracts = (await provider.get('/api/provider/contracts')).data;
  const sold = contracts.capsSold.find(c => c.ref === order.ref);
  assert.ok(sold.value <= 0, 'a sold cap is a liability to the neocloud');
  assert.ok(sold.expectedWindowAverage > 0);
  assert.equal(contracts.floorsBought[0].ref, floor.order.ref);
  assert.ok(contracts.floorsBought[0].value >= 0);
  assert.equal((await provider.post('/api/provider/settings', { webhookUrl: 'javascript:alert(1)' })).status, 400);
  assert.equal((await provider.post('/api/provider/settings', { webhookUrl: 'https://hooks.northwind.example/dodona' })).data.neocloud.webhookUrl, 'https://hooks.northwind.example/dodona');
  const key = (await provider.post('/api/provider/api-key')).data;
  assert.match(key.apiKey, /^dk_[a-f0-9]{48}$/);
  assert.equal((await provider.get('/api/provider/settings')).data.neocloud.apiKeyLast4, key.last4);
  const stored = JSON.stringify(all(db, 'SELECT * FROM neoclouds'));
  assert.ok(!stored.includes(key.apiKey), 'only a hash of the key is kept');
  const events = (await provider.get('/api/provider/events')).data.events;
  assert.ok(events.some(e => e.orderRef === order.ref && e.type === 'reservation.requested'));
  assert.ok(!events.some(e => e.orderRef === floor.order.ref), 'a floor bought from Helix is not on Northwind');
  await provider.post('/api/demo/advance', { until: 'settlement' });
  assert.ok((await provider.get('/api/provider/settlements')).data.settlements.some(s => s.ref === order.ref), 'a provider clock advances orders on its neocloud');
});

test('admin portal: search, CSV, detail, notes, stage, account creation, orders, neoclouds and sync status', async t => {
  const f = await setup(t);
  const admin = await f.as(ADMIN);
  const accounts = (await admin.get('/api/admin/accounts')).data.accounts;
  assert.equal(accounts.length, 4);
  const sample = accounts.find(a => a.company === 'Sample Labs');
  assert.equal(sample.ordersCount, 7);
  assert.ok(sample.premiumsPaid > 0);
  assert.deepEqual((await admin.get('/api/admin/accounts?q=meridian')).data.accounts.map(a => a.email), ['credit@meridian.example']);
  assert.deepEqual((await admin.get('/api/admin/accounts?role=provider')).data.accounts.map(a => a.company), ['Northwind Compute']);
  const csv = await fetch(f.origin + '/api/admin/accounts.csv', { headers: { Cookie: admin.cookie } });
  const text = await csv.text();
  assert.match(text, /^id,email,company,role,kyb,stage,phone,ordersCount,premiumsPaid,lastActiveAt,createdAt\n/);
  assert.ok(!/scrypt|password/i.test(text), 'no password hashes in the export');
  const d = (await admin.get(`/api/admin/accounts/${sample.id}`)).data;
  assert.equal(d.orders.length, 7);
  assert.ok(d.payments.every(p => p.last4 === '4242' && !('number' in p)));
  assert.ok(d.emails.length > 7 && d.events.length > 7);
  const note = await admin.post(`/api/admin/accounts/${sample.id}/notes`, { text: 'Walked through the cap flow on the call.' });
  assert.equal(note.status, 201);
  assert.equal(note.data.note.author, ADMIN);
  const changed = await admin.post(`/api/admin/accounts/${sample.id}`, { stage: 'kyb', phone: '+1 415 555 0100' });
  assert.deepEqual([changed.data.account.stage, changed.data.account.phone], ['kyb', '+1 415 555 0100']);
  assert.equal((await admin.post(`/api/admin/accounts/${sample.id}`, { stage: 'won' })).status, 400);
  assert.equal((await admin.get('/api/admin/accounts/acc_missing')).status, 404);
  const made = await admin.post('/api/admin/accounts', { email: 'cfo@prospect.example', password: 'meeting-2026', company: 'Prospect AI', role: 'buyer', stage: 'lead', kyb: 'pending' });
  assert.equal(made.status, 201);
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: 'cfo@prospect.example', password: 'meeting-2026' })).data.home, '/dashboard');
  assert.ok((await admin.get('/api/admin/orders?status=settled')).data.orders.every(o => o.status === 'settled'));
  assert.equal((await admin.get('/api/admin/orders?status=bogus')).status, 400);
  const neoclouds = (await admin.get('/api/admin/neoclouds')).data.neoclouds;
  assert.deepEqual(neoclouds.map(n => n.name), ['Helix Cloud', 'Northwind Compute']);
  assert.equal(neoclouds.find(n => n.name === 'Northwind Compute').ownerEmail, PROVIDER);
  assert.equal((await admin.get('/api/admin/events?limit=5')).data.events.length, 5);
  const sync = (await admin.get('/api/admin/sync')).data;
  assert.deepEqual([sync.configured, sync.tables.accounts, sync.tables.orders], [false, 5, 7]);
  const unconfigured = await admin.post('/api/admin/sync');
  assert.equal(unconfigured.status, 409);
  assert.match(unconfigured.data.error.message, /not configured/);
  const reset = await admin.post(`/api/admin/accounts/${sample.id}/reset`);
  assert.equal(reset.data.account.demoNow, '2026-10-23T12:00:00.000Z');
});

test('integration events: an account sees its own orders, an admin sees everything', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const lender = await f.as('credit@meridian.example');
  const admin = await f.as(ADMIN);
  const { order } = await buy(buyer);
  const own = (await buyer.get(`/api/integration/events?orderRef=${order.ref}`)).data.events;
  assert.deepEqual(own.map(e => e.type), ['reservation.requested']);
  assert.deepEqual(Object.keys(own[0]).sort(), ['at', 'direction', 'httpStatus', 'id', 'orderRef', 'payload', 'type']);
  assert.equal((await lender.get(`/api/integration/events?orderRef=${order.ref}`)).status, 404);
  assert.equal((await lender.get('/api/integration/events')).data.events.length, 0);
  assert.ok((await admin.get('/api/integration/events')).data.events.length > 10);
});

test('review fixes: production needs DEMO_SEED_PASSWORD, failed sign-ins lock an email, providers see no buyer ids', async t => {
  const { createApp } = await import('../server.mjs');
  const productionApp = extra => createApp({ store: null, production: true, origin: 'https://demo.example', tokenSecret: 'x'.repeat(32), platform: true, db: ':memory:', ...extra });
  assert.throws(() => productionApp({}), /DEMO_SEED_PASSWORD/);
  assert.throws(() => productionApp({ seedPassword: 'too-short' }), /DEMO_SEED_PASSWORD/);
  productionApp({ seedPassword: 'a-long-private-password' }).close();
  const f = await setup(t, { seedPassword: 'another-private-pass', trustedProxyCidrs: '127.0.0.1/32' });
  const from = i => ({ 'X-Forwarded-For': `203.0.113.${i}` });
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'demo-dodona-2026' }, from(1))).status, 401, 'the published password no longer works');
  assert.equal((await f.anonymous.post('/api/auth/sign-in', { email: BUYER, password: 'another-private-pass' }, from(2))).status, 200);
  for (let i = 0; i < 10; i++) await f.anonymous.post('/api/auth/sign-in', { email: PROVIDER, password: 'wrong-password' }, from(10 + i));
  const locked = await f.anonymous.post('/api/auth/sign-in', { email: PROVIDER, password: 'another-private-pass' }, from(50));
  assert.equal(locked.status, 429, 'ten failures for one email lock it, whatever the address');
  const g = await setup(t);
  const nw = await g.as(PROVIDER);
  const b = await g.as(BUYER);
  const { order } = await buy(b, { kind: 'cap', region: 'US East', gpu: 'H100' });
  assert.ok(!('accountId' in (await nw.get(`/api/orders/${order.ref}`)).data.order), 'no buyer account id on the provider view');
  assert.ok((await nw.get('/api/provider/orders')).data.incoming.every(o => !('accountId' in o)));
  assert.equal((await nw.post('/api/provider/settings', { webhookUrl: 'http://hooks.northwind.example' })).status, 400, 'https only');
  assert.equal((await b.get('/api/statementsXcsv')).status, 404, 'a dot in a route is literal');
});

test('portfolio history runs from the first index print to the demo clock, synthetic prints included', async t => {
  const f = await setup(t);
  const buyer = await f.as(BUYER);
  const put = await buy(buyer, { kind: 'floor', gpu: 'H100', region: 'US East' });
  await buyer.post('/api/demo/advance', { days: 60 });
  const p = (await buyer.get('/api/portfolio')).data;
  assert.equal(p.history.at(-1).date, '2026-12-22');
  assert.ok(p.history[0].date <= '2026-07-20', `starts at the first print, got ${p.history[0].date}`);
  const h7 = p.positions.find(x => x.id === 'H7');
  assert.ok(h7.history.length > 150 && h7.history[0].date === '2026-07-18');
  const floor = p.positions.find(x => x.orderRef === put.order.ref);
  assert.ok(floor.valuation.premiumPaid > 0 && floor.valuation.totalHours === put.order.gpuHours, 'puts carry premiumPaid and totalHours like calls');
});
