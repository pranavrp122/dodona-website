// Routes for the signup, contact and quote-request pages and their JSON APIs.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateForm } from '../forms.js';
import { FORM_TABLES } from './signups.mjs';
import { renderPage, collectionDetailsReady } from './site.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY_BYTES = 8 * 1024;
const POST_LIMIT = 20;
const POST_WINDOW_MS = 10 * 60 * 1000;
const HEALTHY_CACHE_MS = 30000;
const UNHEALTHY_CACHE_MS = 2000;
const pages = new Map([['/signup', 'signup.html'], ['/contact', 'contact.html'], ['/rfq', 'rfq.html']]);
const apiRoutes = new Map([['/api/signups', 'signup'], ['/api/contact', 'contact'], ['/api/rfq', 'rfq']]);
const unavailable = {
  signup: 'Signups are stored once the database is connected.',
  contact: 'We can’t accept messages right now. Please try again later.',
  rfq: 'We can’t accept quote requests right now. Please try again later.',
};

// Maps validated form values to table rows (snake_case columns, nulls for empty optionals).
const rows = {
  signup: v => ({ email: v.email, company: v.company, role: v.role, use_case: v.useCase || null, website: v.website || null }),
  contact: v => ({ name: v.name, email: v.email, company: v.company || null, message: v.message }),
  rfq: v => ({ email: v.email, company: v.company, gpu: v.gpu, gpu_count: v.count, start_at: v.start, end_at: v.end, type: v.type, strike: v.strike, notes: v.notes || null }),
};

class FormError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const bytes = await new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); };
    const onError = () => { cleanup(); reject(new FormError(400, 'Unable to read this request.')); };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { cleanup(); request.resume(); reject(new FormError(413, 'This submission is too large.')); }
      else chunks.push(chunk);
    };
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError);
  });
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new FormError(400, 'Please submit a valid form.'); }
}

/**
 * Builds the form routes. Token, rate-limit and client-address helpers come from the
 * server so the forms share the waitlist's secret and limiter.
 */
export function createFormRoutes({ store, settings, origin, now, logger, issueToken, verifyToken, limit, clientAddress }) {
  const health = new Map();

  async function isAvailable(kind) {
    if (!store || !collectionDetailsReady(settings)) return false;
    const table = FORM_TABLES[kind];
    const cached = health.get(table);
    if (cached && now() - cached.at < (cached.available ? HEALTHY_CACHE_MS : UNHEALTHY_CACHE_MS)) return cached.available;
    let available = true;
    try { await store.health(table); }
    catch { available = false; logger.error('[forms] Storage availability check failed.'); }
    health.set(table, { at: now(), available });
    return available;
  }

  async function servePage(request, response, path) {
    const html = await readFile(`${root}${pages.get(path)}`, 'utf8');
    const content = Buffer.from(renderPage(html, { settings, origin, path }));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : content);
  }

  async function status(request, response, url) {
    limit(clientAddress(request), 'status', 120, 60000);
    const kind = url.searchParams.get('form');
    if (!Object.hasOwn(FORM_TABLES, kind)) throw new FormError(400, 'Unknown form.');
    if (await isAvailable(kind)) return json(response, 200, { available: true, token: issueToken() });
    json(response, 503, { available: false, message: unavailable[kind] });
  }

  async function submit(request, response, kind) {
    const expectedOrigin = origin || `http://${request.headers.host}`;
    if ((request.headers.origin && request.headers.origin !== expectedOrigin) || request.headers['sec-fetch-site'] === 'cross-site') {
      throw new FormError(403, 'Please submit the form from the Dodona website.');
    }
    limit(clientAddress(request), 'forms', POST_LIMIT, POST_WINDOW_MS);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new FormError(415, 'Please submit the website form.');
    const body = await readBody(request);
    const check = validateForm(kind, body, now());
    if (!check.ok) throw new FormError(400, check.message, check.field ? { field: check.field } : {});
    if (!(await isAvailable(kind))) throw new FormError(503, unavailable[kind]);
    verifyToken(body.token);
    let result;
    try {
      result = await store.insertRow(FORM_TABLES[kind], rows[kind](check.value), kind === 'signup' ? { onConflict: 'email' } : {});
    } catch {
      health.delete(FORM_TABLES[kind]);
      logger.error(`[forms] Storage did not confirm a ${kind} submission.`);
      throw new FormError(503, 'We couldn’t confirm your submission. Please try again later.');
    }
    json(response, 200, { status: kind === 'signup' && result.duplicate ? 'duplicate' : 'saved' });
  }

  // Returns true when the request belonged to a form route and has been answered.
  async function handle(request, response, url) {
    try {
      if (pages.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) { await servePage(request, response, url.pathname); return true; }
      if (url.pathname === '/api/forms/status' && request.method === 'GET') { await status(request, response, url); return true; }
      if (apiRoutes.has(url.pathname)) {
        if (request.method !== 'POST') json(response, 405, { message: 'Method not allowed.' });
        else await submit(request, response, apiRoutes.get(url.pathname));
        return true;
      }
      return false;
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      json(response, error.status, { message: error.message, ...error.details });
      return true;
    }
  }

  return { handle };
}
