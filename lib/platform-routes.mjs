/** Demo platform routes beyond the core: the demo clock, delivery choice and resale, statements, integration events, provider and admin. */
import { all, get, transaction } from './db.mjs';
import { accountView } from './auth.mjs';
import { orderView, loadOrder, loadOwnOrder } from './orders.mjs';
import { advance, setScenario, settleAccount } from './clock.mjs';
import { setChoice, createListing, withdrawListing, counterBid, acceptBid } from './listing.mjs';
import { statements, statementsCsv } from './settlement.mjs';
import { reseedAccount } from './seed.mjs';
import { eventView } from './neocloud.mjs';
import { providerRoutes } from './provider.mjs';
import { adminRoutes } from './admin.mjs';
import { route, ANY, BUYING_ROLES } from './route.mjs';
import { invalid, onlyKeys } from './validate.mjs';

export { settleAccount };

const MAX_EVENTS = 500;
const bidView = row => ({ id: row.id, bidder: row.bidder, pricePerHour: row.price_per_hour, createdAt: row.at, status: row.status });
const reload = (db, ref) => get(db, 'SELECT * FROM orders WHERE ref = ?', ref);

function demoRoutes({ now, prices, limit, clientAddress }) {
  return [
    route('POST', '/api/demo/advance', async ({ db, account, body, request }) => {
      limit(clientAddress(request), 'demo', 120, 60 * 1000);
      return { body: advance(db, account, body, { history: await prices(), nowMs: now() }) };
    }, { roles: ANY, body: true }),
    route('POST', '/api/demo/scenario', ({ db, account, body }) => {
      const row = setScenario(db, account, body, now());
      return { body: { scenario: row.scenario, demoNow: row.demo_now } };
    }, { roles: ANY, body: true }),
    route('POST', '/api/demo/reset', async ({ db, account }) => {
      const history = await prices();
      const row = reseedAccount(db, account, { nowMs: now(), settle: (acc, to) => settleAccount(db, acc, to, history) });
      return { body: { account: accountView(db, row) } };
    }, { roles: ANY }),
  ];
}

// Each listing action runs at the holder's demo clock and answers with the order and its bids.
function listingAction(path, act, { prices, needsBody = true }) {
  return route('POST', `/api/orders/:ref/${path}`, async ({ db, account, params, body }) => {
    const order = loadOwnOrder(db, account, params.ref);
    const history = await prices();
    const result = transaction(db, () => act(db, order, body, account.demo_now, history));
    const bids = all(db, 'SELECT * FROM bids WHERE order_ref = ? ORDER BY at, created_at', order.ref).map(bidView);
    return { body: { order: orderView(db, reload(db, order.ref)), bids, ...(result && result.price_per_hour ? { bid: bidView(result) } : {}) } };
  }, { roles: BUYING_ROLES, body: needsBody });
}

function orderRoutes(deps) {
  return [
    listingAction('choice', (db, order, body, at) => { onlyKeys(body, ['choice']); setChoice(db, order, body, at); }, deps),
    listingAction('list', (db, order, body, at) => { onlyKeys(body, ['askPerHour']); createListing(db, order, body, at); }, deps),
    listingAction('withdraw', (db, order, body, at) => withdrawListing(db, order, at), { ...deps, needsBody: false }),
    listingAction('counter', (db, order, body, at, history) => { onlyKeys(body, ['bidId', 'askPerHour']); return counterBid(db, order, body, at, history); }, deps),
    listingAction('accept-bid', (db, order, body, at) => { onlyKeys(body, ['bidId']); acceptBid(db, order, body, at); }, deps),
  ];
}

function accountRoutes() {
  return [
    route('GET', '/api/statements', ({ db, account }) => ({ body: statements(db, account) }), { roles: ANY }),
    route('GET', '/api/statements.csv', ({ db, account }) => ({ raw: statementsCsv(statements(db, account)), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dodona-demo-statement.csv"' } }), { roles: ANY }),
    route('GET', '/api/integration/events', ({ db, account, url }) => {
      const ref = url.searchParams.get('orderRef');
      if (ref) {
        const order = loadOrder(db, account, ref);
        if (account.role !== 'admin' && order.account_id !== account.id) throw invalid('Use the provider events for orders on your neocloud.');
        return { body: { events: all(db, 'SELECT * FROM events WHERE order_ref = ? ORDER BY seq', ref).map(eventView) } };
      }
      const rows = account.role === 'admin'
        ? all(db, 'SELECT * FROM events ORDER BY seq DESC LIMIT ?', MAX_EVENTS)
        : all(db, 'SELECT * FROM events WHERE account_id = ? ORDER BY seq DESC LIMIT ?', account.id, MAX_EVENTS);
      return { body: { events: rows.map(eventView) } };
    }, { roles: ANY }),
  ];
}

/** Every route after the core set, for createPlatform's `extraRoutes`. */
export const platformRoutes = deps => [...demoRoutes(deps), ...orderRoutes(deps), ...accountRoutes(), ...providerRoutes(deps), ...adminRoutes(deps)];
