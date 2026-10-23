// Test-only in-memory stand-in for the provider half of the platform API, used to build the portal before the core lands. Not a mock of record.
import { createServer } from 'node:http';
import { createApp } from '../server.mjs';

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

function seed(now) {
  const order = (ref, status, gpu, count, startDays, days, kind, strike, extra = {}) => ({
    ref, status, gpu, count, region: gpu === 'B200' ? 'US West' : 'US East', kind, strike, start: iso(now + startDays * DAY), end: iso(now + (startDays + days) * DAY),
    gpuHours: count * 24 * days, premiumTotal: Math.round(count * 24 * days * 0.11 * 100) / 100, buyer: { company: 'Sample Labs' }, ...extra,
  });
  return {
    demoNow: iso(now), scenario: 'market', autoConfirm: false, webhookUrl: '', apiKeyPreview: 'a91f',
    orders: [
      order('DOD-INC001', 'reserving', 'H100', 64, 14, 14, 'cap', 2.4),
      order('DOD-ACT002', 'delivering', 'H200', 32, -5, 21, 'cap', 3.1, { usage: { hoursReported: 3840, windowAvgSoFar: 3.02 } }),
      order('DOD-RES003', 'reserved', 'B200', 16, 6, 7, 'lock', 4.9),
      order('DOD-SET004', 'settled', 'A100', 128, -40, 14, 'floor', 1.2, { settlement: { windowAvg: 1.08, strike: 1.2, hours: 43008, kind: 'floor', computeBill: 46448.64, payout: 5160.96, premiumPaid: 2580.48, netResult: 2580.48, computedAt: iso(now - 26 * DAY) } }),
    ],
    events: [
      { id: 'evt_1', orderRef: 'DOD-INC001', direction: 'dodona_to_neocloud', type: 'reservation.requested', payload: { orderRef: 'DOD-INC001', gpu: 'H100', count: 64, region: 'US East', kind: 'cap', strike: 2.4 }, httpStatus: 200, at: iso(now - 3600000) },
      { id: 'evt_2', orderRef: 'DOD-ACT002', direction: 'neocloud_to_dodona', type: 'usage.reported', payload: { orderRef: 'DOD-ACT002', date: iso(now).slice(0, 10), gpuHours: 768, hoursToDate: 3840 }, httpStatus: 200, at: iso(now - 7200000) },
      { id: 'evt_3', orderRef: 'DOD-SET004', direction: 'dodona_to_neocloud', type: 'settlement.computed', payload: { orderRef: 'DOD-SET004', kind: 'floor', windowAvg: 1.08, strike: 1.2 }, httpStatus: 200, at: iso(now - 26 * DAY) },
    ],
    payouts: [
      { id: 'p1', orderRef: 'DOD-SET004', direction: 'buyer_to_neocloud', amount: 46448.64, status: 'paid', dueAt: iso(now - 25 * DAY), paidAt: iso(now - 25 * DAY) },
      { id: 'p2', orderRef: 'DOD-ACT002', direction: 'premium_to_neocloud', amount: 1508.35, status: 'paid', dueAt: iso(now - 20 * DAY), paidAt: iso(now - 20 * DAY) },
      { id: 'p3', orderRef: 'DOD-INC001', direction: 'premium_to_neocloud', amount: 2010.62, status: 'scheduled', dueAt: iso(now + DAY), paidAt: null },
    ],
  };
}

function routes(s) {
  const holding = o => ['reserving', 'reserved', 'delivering'].includes(o.status);
  const capacity = [['H100', 'US East', 1024], ['H100', 'US West', 1024], ['H200', 'US East', 512], ['B200', 'US West', 256], ['A100', 'US East', 1024]]
    .map(([gpu, region, total]) => ({ gpu, region, total, reserved: s.orders.filter(o => o.gpu === gpu && o.region === region && holding(o)).reduce((n, o) => n + o.count, 0) }));
  return {
    'GET /api/provider/overview': () => ({ neocloud: { id: 'nc_northwind', name: 'Northwind Compute' }, capacity, income: { month: { premiums: 3518.97, computeBills: 0, floorPayouts: 0 }, toDate: { premiums: 3518.97, computeBills: 46448.64, floorPayouts: 0 } }, nextDeliveries: s.orders.filter(o => o.status === 'reserved'), pendingConfirmations: s.orders.filter(o => o.status === 'reserving').length }),
    'GET /api/provider/orders': () => ({ orders: s.orders }),
    'GET /api/provider/contracts': () => ({ contracts: s.orders.filter(o => o.status !== 'declined').map(o => ({ orderRef: o.ref, kind: o.kind, gpu: o.gpu, count: o.count, hours: o.gpuHours, start: o.start, end: o.end, strike: o.strike, premium: o.premiumTotal * 0.85, expectedAvg: o.strike * 1.04, value: o.kind === 'floor' ? 820.5 : -310.25 })) }),
    'GET /api/provider/settlements': () => ({ settlements: s.orders.filter(o => o.settlement).map(o => ({ orderRef: o.ref, ...o.settlement })) }),
    'GET /api/provider/payouts': () => ({ payouts: s.payouts }),
    'GET /api/provider/events': () => ({ events: [...s.events].reverse() }),
    'GET /api/provider/settings': () => ({ settings: { autoConfirm: s.autoConfirm, webhookUrl: s.webhookUrl, apiKeyPreview: s.apiKeyPreview } }),
  };
}

function account(s, role) {
  return role === 'buyer'
    ? { id: 'acc_buyer', email: 'demo@dodona.markets', company: 'Sample Labs', role: 'buyer', kyb: 'verified', stage: 'demo', demoNow: s.demoNow, scenario: s.scenario, neocloud: null, home: '/dashboard' }
    : { id: 'acc_nw', email: 'ops@northwind.example', company: 'Northwind Compute', role: 'provider', kyb: 'verified', stage: 'demo', demoNow: s.demoNow, scenario: s.scenario, neocloud: { id: 'nc_northwind', name: 'Northwind Compute' }, autoConfirm: s.autoConfirm, home: '/provider' };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

function post(s, path, data) {
  const decide = path.match(/^\/api\/provider\/orders\/([^/]+)\/(confirm|decline)$/);
  if (decide) {
    const order = s.orders.find(o => o.ref === decodeURIComponent(decide[1]));
    if (!order || order.status !== 'reserving') return [409, { ok: false, error: { code: 'state', message: 'This order is not waiting for a decision.' } }];
    order.status = decide[2] === 'confirm' ? 'reserved' : 'declined';
    s.events.push({ id: `evt_${s.events.length + 1}`, orderRef: order.ref, direction: 'neocloud_to_dodona', type: `reservation.${decide[2]}d`, payload: { orderRef: order.ref, confirmedBy: 'operator' }, httpStatus: 200, at: s.demoNow });
    return [200, { ok: true, order }];
  }
  if (path === '/api/provider/settings') {
    if ('autoConfirm' in data) s.autoConfirm = Boolean(data.autoConfirm);
    if ('webhookUrl' in data) s.webhookUrl = String(data.webhookUrl);
    return [200, { ok: true, settings: { autoConfirm: s.autoConfirm, webhookUrl: s.webhookUrl } }];
  }
  if (path === '/api/provider/api-key') { s.apiKeyPreview = 'c0de'; return [200, { ok: true, apiKey: 'dk_demo_3f9a7c2e1b5d4c0de' }]; }
  if (path === '/api/demo/advance') { s.demoNow = iso(Date.parse(s.demoNow) + (data.days || 1) * DAY); return [200, { ok: true, demoNow: s.demoNow, fired: [{ type: 'usage.reported' }, { type: 'delivery.started' }] }]; }
  if (path === '/api/demo/scenario') { s.scenario = data.scenario; return [200, { ok: true, scenario: s.scenario }]; }
  if (path === '/api/demo/reset') return [200, { ok: true }];
  if (path === '/api/auth/sign-out') return [204, null];
  return null;
}

export async function stubServer({ port = 0, role = 'provider' } = {}) {
  const app = createApp({ store: null, platform: true, logger: { error() {} } });
  const appHandler = app.listeners('request')[0];
  const s = seed(Date.parse('2026-10-23T12:00:00Z'));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(status === 204 ? undefined : JSON.stringify(data)); };
    const as = /stub_role=buyer/.test(request.headers.cookie || '') ? 'buyer' : role;
    if (url.pathname === '/api/account') return send(200, { ok: true, account: account(s, as) });
    if (url.pathname.startsWith('/api/provider') && as !== 'provider') return send(403, { ok: false, error: { code: 'forbidden', message: 'Provider accounts only.' } });
    const handler = routes(s)[`${request.method} ${url.pathname}`];
    if (handler) return send(200, { ok: true, ...handler() });
    if (request.method === 'POST') { const result = post(s, url.pathname, await body(request)); if (result) return send(...result); }
    return appHandler(request, response);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, state: s, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && process.argv[1].endsWith('provider-stub.mjs')) {
  const { origin } = await stubServer({ port: Number(process.env.PORT || 3113) });
  console.log(`Provider stub on ${origin}`);
}
