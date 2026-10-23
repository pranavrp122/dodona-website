/** Demo platform routes: accounts, offers, orders, mock payment, the demo clock, the mock neocloud, and the provider and admin APIs. */
import samples from '../data/sample-portfolio.json' with { type: 'json' };
import { openDatabase, all, get } from './db.mjs';
import * as auth from './auth.mjs';
import * as orders from './orders.mjs';
import { payOrder } from './payments.mjs';
import { seedPlatform, refreshOffers } from './seed.mjs';
import { accountPrices, indexPoints } from './prints.mjs';
import { eventView } from './neocloud.mjs';
import { emailView } from './outbox.mjs';
import { PlatformError, notFound, signedOut, forbidden, invalid } from './validate.mjs';

const API_PREFIX = /^\/api\/(?:auth|account|orders|offers|demo|provider|admin|emails|statements|integration|index)(?:\/|\.csv$|$)/;
const PAGE_PATHS = /^\/(?:sign-in|offers|checkout|orders(?:\/[A-Za-z0-9-]{1,40})?|provider|admin|docs\/neocloud-api)\/?$/;
const BUYING_ROLES = Object.freeze(['buyer', 'lender', 'provider']);
const ANY = Object.freeze(['buyer', 'lender', 'provider', 'admin']);
const GPU_PATTERN = /^[A-Z0-9 ]{2,12}$/;

/** True for a platform API path (they all 404 when the platform is off). */
export const isPlatformApi = pathname => API_PREFIX.test(pathname);
/** True for a platform page path (sign-in, offers, checkout, orders, provider, admin, the neocloud guide). */
export const isPlatformPage = pathname => PAGE_PATHS.test(pathname);

/** On by default outside production; in production only with DEMO_PLATFORM=1. */
export function platformEnabled({ production, environment = process.env }) {
  const flag = environment.DEMO_PLATFORM;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !production;
}

const compile = path => new RegExp(`^${path.replace(/:([a-z]+)/g, '(?<$1>[A-Za-z0-9_-]{1,64})').replace(/\./g, '\\.')}$`);
const route = (method, path, handler, { roles = null, body = false } = {}) => ({ method, pattern: compile(path), handler, roles, body });

function accountBook(db, account) {
  return {
    organisation: account.company, email: account.email, accountNumber: account.id.slice(-4).toUpperCase(),
    kyb: account.kyb, kybDate: account.kyb === 'verified' ? account.created_at.slice(0, 10) : null, role: account.role,
  };
}

function orderDetail(db, viewer, row) {
  const own = viewer.role === 'admin' || row.account_id === viewer.id;
  const view = orders.orderView(db, row);
  return {
    order: view,
    events: all(db, 'SELECT * FROM events WHERE order_ref = ? ORDER BY seq', row.ref).map(eventView),
    settlement: view.settlement,
    payouts: all(db, 'SELECT * FROM payouts WHERE order_ref = ? ORDER BY due_at, created_at', row.ref).map(payoutView),
    emails: own ? all(db, 'SELECT * FROM emails WHERE order_ref = ? AND account_id = ? ORDER BY seq', row.ref, row.account_id).map(emailView) : [],
    listing: view.listing,
    bids: all(db, 'SELECT * FROM bids WHERE order_ref = ? ORDER BY at, created_at', row.ref).map(bidView),
  };
}

export const payoutView = row => ({ id: row.id, orderRef: row.order_ref, direction: row.direction, amount: row.amount, status: row.status, dueAt: row.due_at, paidAt: row.paid_at });
export const bidView = row => ({ id: row.id, bidder: row.bidder, pricePerHour: row.price_per_hour, createdAt: row.at, status: row.status });

function baseRoutes(deps) {
  const { now, limit, clientAddress, secureCookie } = deps;
  return [
    route('POST', '/api/auth/sign-up', async ({ db, request, body }) => {
      limit(clientAddress(request), 'sign-up', 10, 10 * 60 * 1000);
      const account = await auth.signUp(db, body, now());
      return { status: 201, body: { account: auth.accountView(db, account) }, headers: { 'Set-Cookie': auth.sessionCookie(auth.createSession(db, account.id, now()), secureCookie) } };
    }, { body: true }),
    route('POST', '/api/auth/sign-in', async ({ db, request, body }) => {
      limit(clientAddress(request), 'sign-in', 10, 10 * 60 * 1000);
      const account = await auth.signIn(db, body);
      const view = auth.accountView(db, account);
      return { body: { account: view, home: view.home }, headers: { 'Set-Cookie': auth.sessionCookie(auth.createSession(db, account.id, now()), secureCookie) } };
    }, { body: true }),
    route('POST', '/api/auth/sign-out', async ({ db, request }) => {
      auth.deleteSession(db, request);
      return { status: 204, headers: { 'Set-Cookie': auth.clearCookie(secureCookie) } };
    }),
    route('GET', '/api/account', ({ db, account }) => ({ body: { account: auth.accountView(db, account) } }), { roles: ANY }),
    route('GET', '/api/offers', async ({ db, url, account }) => {
      refreshOffers(db, await deps.prices(), now());
      const filters = Object.fromEntries(['gpu', 'region', 'kind'].map(key => [key, url.searchParams.get(key) || null]));
      return { body: { offers: orders.listOffers(db, filters, account?.demo_now ?? new Date(now()).toISOString()) } };
    }),
    route('GET', '/api/offers/:id', ({ db, params }) => {
      const row = get(db, 'SELECT * FROM offers WHERE id = ?', params.id);
      if (!row) throw notFound('That offer does not exist.');
      return { body: { offer: orders.offerView(db, row) } };
    }),
    route('POST', '/api/orders', async ({ db, account, body, request }) => {
      limit(clientAddress(request), 'orders', 60, 10 * 60 * 1000);
      return { status: 201, body: { order: orders.orderView(db, orders.createOrder(db, account, body, await deps.prices())) } };
    }, { roles: BUYING_ROLES, body: true }),
    route('GET', '/api/orders', ({ db, account }) => ({ body: { orders: orders.listOrders(db, account.id) } }), { roles: ANY }),
    route('GET', '/api/orders/:ref', ({ db, account, params }) => ({ body: orderDetail(db, account, orders.loadOrder(db, account, params.ref)) }), { roles: ANY }),
    route('POST', '/api/orders/:ref/pay', ({ db, account, params, body, request }) => {
      limit(clientAddress(request), 'pay', 30, 10 * 60 * 1000);
      const { order } = payOrder(db, account, orders.loadOwnOrder(db, account, params.ref), body, now());
      return { body: { order: orders.orderView(db, order) } };
    }, { roles: BUYING_ROLES, body: true }),
    route('GET', '/api/index', async ({ db, url, account }) => {
      const history = await deps.prices();
      const gpu = url.searchParams.get('gpu') || 'H100';
      if (!GPU_PATTERN.test(gpu) || !history.data[gpu]) throw invalid(`GPU must be one of ${Object.keys(history.data).join(', ')}.`);
      const until = (account?.demo_now ?? new Date(now()).toISOString()).slice(0, 10);
      const day = name => { const value = url.searchParams.get(name); if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`${name} must be a date like 2026-10-01.`); return value; };
      const to = [day('to') || until, until].sort()[0];
      return { body: { gpu, points: indexPoints(db, account, history, gpu, day('from') || '0000-01-01', to) } };
    }),
    route('GET', '/api/emails', ({ db, account }) => ({ body: { emails: all(db, 'SELECT * FROM emails WHERE account_id = ? ORDER BY at DESC, seq DESC', account.id).map(emailView) } }), { roles: ANY }),
  ];
}

function errorBody(error) {
  if (error instanceof PlatformError) return [error.status, error.code, error.message, {}];
  const code = error.details?.code === 'RATE_LIMIT' || error.status === 429 ? 'rate_limited' : error.status === 413 ? 'too_large' : error.status === 403 ? 'bad_origin' : 'invalid';
  return [error.status, code, error.message, error.status === 429 ? { 'Retry-After': String(error.details?.retryAfter || 600) } : {}];
}

/**
 * The platform as the server mounts it. Options: `db` (a DatabaseSync, or a file path; ':memory:' in tests), `enabled`,
 * `prices`, `now`, `limit`, `clientAddress`, `origin`, `production`, `logger`, `json`, `readJson`, `extraRoutes` (later drops).
 */
export function createPlatform({ db: dbOption, enabled = true, prices, now = Date.now, limit, clientAddress, origin = '', production = false, logger = console, json, readJson, extraRoutes = () => [], settle } = {}) {
  let ready = null;
  const boot = () => (ready ??= (async () => {
    const db = dbOption && typeof dbOption === 'object' ? dbOption : openDatabase(dbOption || undefined);
    seedPlatform(db, { history: await prices(), nowMs: now(), settle: settle && ((account, to) => settle(db, account, to, prices)) });
    return db;
  })().catch(error => { ready = null; throw error; }));
  const deps = { now, limit, clientAddress, prices, secureCookie: production, boot, logger };
  const routes = [...baseRoutes(deps), ...extraRoutes(deps)];

  function checkOrigin(request) {
    const expected = origin || `http://${request.headers.host}`;
    if ((request.headers.origin && request.headers.origin !== expected) || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new PlatformError(403, 'bad_origin', 'Use the Dodona site origin.');
    }
  }

  async function run(request, response, url, match, params) {
    if (match.method !== 'GET') checkOrigin(request);
    let body = {};
    if (match.body) {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new PlatformError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
      body = await readJson(request);
    }
    const db = await boot();
    const account = auth.sessionAccount(db, request, now());
    if (match.roles && !account) throw signedOut();
    if (match.roles && !match.roles.includes(account.role)) throw forbidden(`This needs a ${match.roles.join(' or ')} account.`);
    const result = await match.handler({ db, request, response, url, params, account, body });
    if (result.raw) {
      response.writeHead(result.status || 200, { 'Cache-Control': 'no-store', ...result.headers });
      return response.end(result.raw);
    }
    if (result.status === 204) {
      response.writeHead(204, { 'Cache-Control': 'no-store', ...result.headers });
      return response.end();
    }
    return json(response, result.status || 200, { ok: true, ...result.body }, result.headers || {});
  }

  /** Handles a platform API request; returns false for any other path. */
  async function handle(request, response, url) {
    if (!isPlatformApi(url.pathname)) return false;
    try {
      if (!enabled) throw notFound();
      const candidates = routes.filter(r => r.pattern.test(url.pathname));
      if (!candidates.length) throw notFound();
      const match = candidates.find(r => r.method === request.method || (r.method === 'GET' && request.method === 'HEAD'));
      if (!match) throw new PlatformError(405, 'method_not_allowed', 'Method not allowed.');
      await run(request, response, url, match, url.pathname.match(match.pattern).groups || {});
    } catch (error) {
      if (!(error instanceof PlatformError) && !(Number.isInteger(error?.status) && error.status < 500)) {
        logger.error(`[platform] Request failed: ${error?.name || 'Error'}.`);
        if (response.headersSent) { response.end(); return true; }
        json(response, 500, { ok: false, error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
        return true;
      }
      const [status, code, message, headers] = errorBody(error);
      if (!response.headersSent) json(response, status, { ok: false, error: { code, message } }, headers);
    }
    return true;
  }

  /** The signed-in account's book for /dashboard and /api/portfolio, or null when signed out or off. */
  async function portfolioSource(request) {
    if (!enabled || !auth.readCookie(request)) return null;
    const db = await boot();
    const account = auth.sessionAccount(db, request, now());
    if (!account) return null;
    const history = await prices();
    return {
      prices: accountPrices(db, account, history), now: Date.parse(account.demo_now),
      positions: orders.orderPositions(db, account.id), facilities: account.role === 'lender' ? samples.facilities : [], account: accountBook(db, account),
    };
  }

  return { enabled, handle, portfolioSource, boot };
}
