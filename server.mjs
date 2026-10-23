import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { storeFromEnvironment } from './lib/supabase.mjs';
import { createClientAddressResolver } from './lib/proxy.mjs';
import { readSiteSettings, collectionDetailsReady, renderPage } from './lib/site.mjs';
import { discoveryDocument, structuredData } from './lib/discovery.mjs';
import { handleMcp } from './lib/mcp.mjs';
import { getPriceHistory } from './lib/prices.mjs';
import { contractsDocument } from './lib/contracts.mjs';
import { quoteRoute } from './lib/pricing.mjs';
import { createMarketSource, handleMarket, handleMethodology } from './lib/market.mjs';
import { createFormRoutes } from './lib/forms.mjs';
import { formStoreFromEnvironment } from './lib/signups.mjs';
import { auditDocument, acceptEvent, AuditError, recordStartup, recordServerEvent } from './lib/audit.mjs';
import { portfolioDocument } from './lib/portfolio.mjs';

const QUOTE_AUDIT_INTERVAL_MS = 15000;
const dateOnly = iso => String(iso).slice(0, 10);
const quoteSummary = ({ inputs, type, strike, premiumPerGpuHour }) => `Quote · ${inputs.gpu} × ${inputs.count} · ${dateOnly(inputs.start)} to ${dateOnly(inputs.end)} · ${type} $${Number(strike).toFixed(2)} · fee $${premiumPerGpuHour.toFixed(2)}/h`;
const compactUsd = v => `${v < 0 ? '−' : '+'}$${Math.round(Math.abs(v) / 1000).toLocaleString('en-US')}k`;
const markSummary = portfolio => `Mark · ${portfolio.positions.filter(p => p.phase !== 'used').length} positions · net ${compactUsd(portfolio.kpis.netValue)} · Ornn ${dateOnly(portfolio.prices.asOf)}`;

const root = fileURLToPath(new URL('.', import.meta.url));
const interests = new Set(['', 'Individual trading', 'Business hedging', 'Partnership']);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/waitlist.js', ['waitlist.js', 'text/javascript; charset=utf-8']],
  ['/checkout.js', ['checkout.js', 'text/javascript; charset=utf-8']],
  ['/paper-order.js', ['paper-order.js', 'text/javascript; charset=utf-8']],
  ['/demo-model.js', ['demo-model.js', 'text/javascript; charset=utf-8']],
  ['/contracts.css', ['contracts.css', 'text/css; charset=utf-8']],
  ['/contracts.js', ['contracts.js', 'text/javascript; charset=utf-8']],
  ['/contract.js', ['contract.js', 'text/javascript; charset=utf-8']],
  ['/contracts-view.js', ['contracts-view.js', 'text/javascript; charset=utf-8']],
  ['/checkout.css', ['checkout.css', 'text/css; charset=utf-8']],
  ['/market.js', ['market.js', 'text/javascript; charset=utf-8']],
  ['/market.css', ['market.css', 'text/css; charset=utf-8']],
  ['/forms.js', ['forms.js', 'text/javascript; charset=utf-8']],
  ['/signup.js', ['signup.js', 'text/javascript; charset=utf-8']],
  ['/forms.css', ['forms.css', 'text/css; charset=utf-8']],
  ['/audit.js', ['audit.js', 'text/javascript; charset=utf-8']],
  ['/audit.css', ['audit.css', 'text/css; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  ['/dashboard-view.js', ['dashboard-view.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/privacy', ['privacy.html', 'text/html; charset=utf-8']],
  ['/privacy.html', ['privacy.html', 'text/html; charset=utf-8']],
  ['/agents', ['agents.html', 'text/html; charset=utf-8']],
  ['/assets/social-card.png', ['assets/social-card.png', 'image/png']],
  ['/assets/favicon.svg', ['assets/favicon.svg', 'image/svg+xml']],
  ...['bricolage-grotesque-latin-standard-normal.woff2', 'albert-sans-latin-wght-normal.woff2', 'open-sans-latin-wght-normal.woff2'].map(name =>
    [`/assets/fonts/${name}`, [`assets/fonts/${name}`, 'font/woff2']]),
]);
const unavailable = 'We can’t accept signups right now. Please check back later.';

class RequestError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}

function json(response, status, data, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const bytes = await new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError);
    };
    const onError = () => { cleanup(); reject(new RequestError(400, 'Unable to read this request.')); };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    const onData = chunk => {
      size += chunk.length;
      if (size > 4096) {
        cleanup(); request.resume(); reject(new RequestError(413, 'This submission is too large.'));
      } else chunks.push(chunk);
    };
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError);
  });
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError(400, 'Please submit a valid form.'); }
}

export function validateSubmission(body) {
  if (typeof body.email !== 'string') throw new RequestError(422, 'Enter a valid email address.', { field: 'email' });
  const email = body.email.trim().toLowerCase();
  const [local, domain] = email.split('@');
  if (email.length > 254 || !local || local.length > 64 || !domain ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new RequestError(422, 'Enter a valid email address.', { field: 'email' });
  }
  const interest = body.interest ?? '';
  if (typeof interest !== 'string' || !interests.has(interest)) throw new RequestError(422, 'Choose one of the listed interests.');
  if (body.useCase != null && typeof body.useCase !== 'string') throw new RequestError(422, 'Please keep your use case to a short sentence or two.');
  const useCase = (body.useCase ?? '').trim();
  if (useCase.length > 280 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(useCase)) {
    throw new RequestError(422, 'Please keep your use case to 280 characters or fewer.');
  }
  if (body.website != null && (typeof body.website !== 'string' || body.website !== '')) {
    throw new RequestError(422, 'We couldn’t accept this submission.');
  }
  return { email, interest, useCase };
}

export function createApp({
  store = storeFromEnvironment(),
  origin = process.env.APP_ORIGIN || '',
  production = process.env.NODE_ENV === 'production',
  tokenSecret = process.env.WAITLIST_FORM_SECRET || (production ? '' : randomBytes(32).toString('hex')),
  siteSettings = readSiteSettings(),
  trustedProxyCidrs = process.env.TRUSTED_PROXY_CIDRS || '',
  now = Date.now,
  rateLimit = 20,
  logger = console,
  prices = getPriceHistory,
  market = createMarketSource({ prices }),
  formStore = formStoreFromEnvironment(),
  contractValues = false,
  platform = production ? process.env.DEMO_PLATFORM === '1' : process.env.DEMO_PLATFORM !== '0',
} = {}) {
  if (origin && new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an exact origin without a path or trailing slash.');
  if (production && (!origin.startsWith('https://') || tokenSecret.length < 32)) throw new Error('Production requires an HTTPS APP_ORIGIN and a private WAITLIST_FORM_SECRET of at least 32 characters.');
  const clientAddress = createClientAddressResolver(trustedProxyCidrs);
  const structuredDataHash = createHash('sha256').update(structuredData(siteSettings, origin)).digest('base64');
  const attempts = new Map();
  let health = { at: -Infinity, available: false };
  let healthRequest;
  const sign = payload => createHmac('sha256', tokenSecret).update(payload).digest('hex');
  const issueToken = () => {
    const payload = `${now()}.${randomBytes(12).toString('hex')}`;
    return `${payload}.${sign(payload)}`;
  };
  function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 160) throw new RequestError(403, 'Refresh the form and try again.', { code: 'FORM_EXPIRED' });
    const [timestamp, nonce, signature, extra] = token.split('.');
    const payload = `${timestamp}.${nonce}`;
    if (extra || !/^\d{10,16}$/.test(timestamp || '') || !/^[a-f0-9]{24}$/.test(nonce || '') ||
        !/^[a-f0-9]{64}$/.test(signature || '') || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(payload), 'hex'))) {
      throw new RequestError(403, 'Refresh the form and try again.', { code: 'FORM_EXPIRED' });
    }
    const age = now() - Number(timestamp);
    if (age < 1500) throw new RequestError(429, 'Please wait a moment and try again.', { code: 'FORM_TOO_FAST' });
    if (age > 2 * 60 * 60 * 1000) throw new RequestError(403, 'Refresh the form and try again.', { code: 'FORM_EXPIRED' });
  }
  function limit(address, bucket = 'signup', max = rateLimit, duration = 10 * 60 * 1000) {
    const time = now();
    for (const [ip, entry] of attempts) if (entry.until <= time) attempts.delete(ip);
    const key = `${bucket}:${address}`;
    if (!attempts.has(key)) {
      if (attempts.size >= 10000) throw new RequestError(429, 'Too many requests. Please try again later.');
      attempts.set(key, { count: 0, until: time + duration });
    }
    const entry = attempts.get(key);
    if (++entry.count > max) throw new RequestError(429, 'Too many requests. Please try again shortly.', { code: 'RATE_LIMIT', retryAfter: Math.ceil((entry.until - time) / 1000) });
  }
  const lastQuoteAudit = new Map();
  let lastMarkAsOf = null;
  const auditQuote = (request, quote) => {
    try {
      const address = clientAddress(request), at = now();
      if (at - (lastQuoteAudit.get(address) ?? -Infinity) < QUOTE_AUDIT_INTERVAL_MS) return;
      if (lastQuoteAudit.size > 1000) lastQuoteAudit.clear();
      lastQuoteAudit.set(address, at);
      recordServerEvent('quote', quoteSummary(quote), { premiumTotal: quote.premiumTotal, method: quote.method, asOf: quote.asOf });
    } catch { /* the audit trail never breaks a quote */ }
  };
  const auditMark = page => {
    try {
      if (page.status !== 200) return;
      const portfolio = JSON.parse(page.body);
      if (portfolio.asOf === lastMarkAsOf) return;
      lastMarkAsOf = portfolio.asOf;
      recordServerEvent('mark', markSummary(portfolio), { netValue: portfolio.kpis.netValue, asOf: portfolio.asOf, indexAsOf: portfolio.prices.asOf });
    } catch { /* the audit trail never breaks the portfolio */ }
  };
  const forms = createFormRoutes({ store: formStore, settings: siteSettings, origin, now, logger, issueToken, verifyToken, limit, clientAddress });
  async function isAvailable() {
    if (!store || !collectionDetailsReady(siteSettings)) return false;
    if (now() - health.at < (health.available ? 30000 : 2000)) return health.available;
    if (!healthRequest) {
      healthRequest = (async () => {
        try { await store.health(); health = { at: now(), available: true }; }
        catch { health = { at: now(), available: false }; logger.error('[waitlist] Storage availability check failed.'); }
        finally { healthRequest = null; }
        return health.available;
      })();
    }
    return healthRequest;
  }
  async function getWaitlistStatus(address) {
    limit(address, 'status', 120, 60000);
    const available = await isAvailable();
    return available ? { available, token: issueToken() } : { available, message: unavailable };
  }
  async function joinWaitlist(body, address, { alreadyLimited = false } = {}) {
    if (!alreadyLimited) limit(address);
    const submission = validateSubmission(body);
    if (!store || !collectionDetailsReady(siteSettings)) throw new RequestError(503, unavailable);
    verifyToken(body.token);
    try { await store.insert(submission); }
    catch {
      health = { at: now(), available: false };
      logger.error('[waitlist] Storage did not confirm the submission.');
      throw new RequestError(503, 'We couldn’t confirm your signup. Please try again later; retrying won’t add a duplicate.');
    }
    // Same acknowledgement for existing and new emails, without exposing membership.
    return { status: 'saved' };
  }

  const server = createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'sha256-${structuredDataHash}'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    response.setHeader('Link', '</llms.txt>; rel="describedby"; type="text/plain", </openapi.json>; rel="service-desc"; type="application/json", </agents>; rel="service-doc"; type="text/html"');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/mcp') {
        try {
          const address = clientAddress(request);
          limit(address, 'mcp', 120, 60000);
          const port = request.socket.localPort;
          const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]'].flatMap(host => [host, `${host}:${port}`]));
          if (origin) allowedHosts.add(new URL(origin).host);
          if (!allowedHosts.has((request.headers.host || '').toLowerCase())) throw new RequestError(403, 'Use the configured Dodona host.');
          const expectedOrigin = origin || `http://${request.headers.host}`;
          if (request.headers.origin && request.headers.origin !== expectedOrigin || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Use the Dodona site origin.');
          if (request.method !== 'POST') return json(response, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use Streamable HTTP POST requests. No persistent event stream is provided.' } }, { Allow: 'POST' });
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new RequestError(415, 'Content-Type must be application/json.');
          const body = await readJson(request);
          response.setHeader('Cache-Control', 'no-store');
          return await handleMcp(request, response, body, { settings: siteSettings, origin, contractValues, secret: tokenSecret, now, address, getWaitlistStatus, joinWaitlist, logger });
        } catch (error) {
          if (error instanceof RequestError) return json(response, error.status, { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message, data: error.details } }, error.status === 429 ? { 'Retry-After': String(error.details.retryAfter || 60) } : {});
          throw error;
        }
      }
      const document = discoveryDocument(url.pathname, { settings: siteSettings, origin, contractValues });
      if (document) {
        if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { message: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
        const content = Buffer.from(document.body);
        response.writeHead(document.status || 200, { 'Content-Type': document.type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (url.pathname === '/healthz' && request.method === 'GET') return json(response, 200, { status: 'ok' });
      if (url.pathname === '/api/prices' && request.method === 'GET') return json(response, 200, await prices(), { 'Cache-Control': 'public, max-age=300' });
      if (url.pathname === '/api/quote' && request.method === 'GET') { const quote = await quoteRoute(url, { prices, now }); if (quote.status === 200) auditQuote(request, quote.body); return json(response, quote.status, quote.body); }
      if (url.pathname === '/api/market' && request.method === 'GET') return await handleMarket(url, response, market, json);
      if (url.pathname === '/methodology' && ['GET', 'HEAD'].includes(request.method)) return await handleMethodology(request, response, { settings: siteSettings, origin });
      if (await forms.handle(request, response, url)) return;
      if (url.pathname === '/api/audit/events' && request.method === 'POST') {
        const expectedOrigin = origin || `http://${request.headers.host}`;
        if (request.headers.origin && request.headers.origin !== expectedOrigin || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Use the Dodona site origin.');
        limit(clientAddress(request), 'audit', 30, 60000);
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new RequestError(415, 'Content-Type must be application/json.');
        const body = await readJson(request);
        try { return json(response, 202, acceptEvent(body)); }
        catch (error) { throw error instanceof AuditError ? new RequestError(error.status, error.message) : error; }
      }
      // ---- provider portal pages (feature/platform-provider): the portal, its assets and the neocloud guide; 404 when the platform is off ----
      const providerPage = {
        '/provider': ['provider.html', 'text/html; charset=utf-8', '/provider'],
        '/provider.js': ['provider.js', 'text/javascript; charset=utf-8'],
        '/provider-view.js': ['provider-view.js', 'text/javascript; charset=utf-8'],
        '/provider.css': ['provider.css', 'text/css; charset=utf-8'],
        '/docs/neocloud-api': ['neocloud-api.html', 'text/html; charset=utf-8', '/docs/neocloud-api'],
      }[url.pathname];
      if (providerPage && ['GET', 'HEAD'].includes(request.method)) {
        if (!platform) return json(response, 404, { message: 'Not found.' });
        const [path, type, pagePath] = providerPage;
        let content = await readFile(resolve(root, path));
        if (pagePath) content = Buffer.from(renderPage(content.toString('utf8'), { settings: siteSettings, origin, path: pagePath }));
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      // ---- end provider portal pages ----
      if (['GET', 'HEAD'].includes(request.method) && (url.pathname === '/dashboard' || url.pathname === '/api/portfolio')) {
        const page = await portfolioDocument(url, { prices, now, settings: siteSettings, origin });
        if (url.pathname === '/api/portfolio') auditMark(page);
        const content = Buffer.from(page.body);
        response.writeHead(page.status, { 'Content-Type': page.type, 'Content-Length': content.length, 'Cache-Control': page.cacheControl });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (contractValues && ['GET', 'HEAD'].includes(request.method)) {
        const page = await contractsDocument(url, { prices, now, settings: siteSettings, origin });
        if (page) {
          const content = Buffer.from(page.body);
          response.writeHead(page.status, { 'Content-Type': page.type, 'Content-Length': content.length, 'Cache-Control': page.cacheControl });
          return response.end(request.method === 'HEAD' ? undefined : content);
        }
      }
      if (['GET', 'HEAD'].includes(request.method)) {
        const page = await auditDocument(url, { settings: siteSettings, origin });
        if (page) {
          const content = Buffer.from(page.body);
          response.writeHead(page.status, { 'Content-Type': page.type, 'Content-Length': content.length, 'Cache-Control': page.cacheControl });
          return response.end(request.method === 'HEAD' ? undefined : content);
        }
      }
      if (url.pathname === '/readyz' && request.method === 'GET') {
        limit(clientAddress(request), 'status', 120, 60000);
        const ready = await isAvailable();
        return json(response, ready ? 200 : 503, { waitlistAvailable: ready });
      }
      if (url.pathname === '/api/waitlist/status' && request.method === 'GET') {
        const status = await getWaitlistStatus(clientAddress(request));
        return json(response, status.available ? 200 : 503, status);
      }
      if (url.pathname === '/api/waitlist' && request.method === 'POST') {
        const expectedOrigin = origin || `http://${request.headers.host}`;
        if (request.headers.origin && request.headers.origin !== expectedOrigin) throw new RequestError(403, 'Please submit the form from the Dodona website.');
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Please submit the form from the Dodona website.');
        limit(clientAddress(request));
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new RequestError(415, 'Please submit the website form.');
        const body = await readJson(request);
        return json(response, 200, await joinWaitlist(body, clientAddress(request), { alreadyLimited: true }));
      }
      if ((url.pathname === '/api/waitlist' || url.pathname === '/api/waitlist/status') && !['GET', 'HEAD'].includes(request.method)) {
        return json(response, 405, { message: 'Method not allowed.' });
      }
      if (['GET', 'HEAD'].includes(request.method) && staticFiles.has(url.pathname)) {
        const [path, type] = staticFiles.get(url.pathname);
        let content = await readFile(resolve(root, path));
        if (type.startsWith('text/html')) content = Buffer.from(renderPage(content.toString('utf8'), { settings: siteSettings, origin, path: path === 'privacy.html' ? '/privacy' : path === 'agents.html' ? '/agents' : '/' }));
        response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      return json(response, 404, { message: 'Not found.' });
    } catch (error) {
      if (error instanceof RequestError) return json(response, error.status, { message: error.message, ...error.details }, error.status === 429 ? { 'Retry-After': error.details.code === 'FORM_TOO_FAST' ? '2' : String(error.details.retryAfter || 600) } : {});
      logger.error('[server] Request failed.');
      if (!response.headersSent) return json(response, 500, { message: 'Something went wrong. Please try again later.' });
      response.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createApp({ contractValues: process.env.SHOW_CONTRACT_VALUES === '1' });
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 3000);
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'The requested port is already in use.' : 'Server startup failed.'); process.exitCode = 1; });
    server.listen(port, host, () => {
      console.log(`Dodona server listening on port ${port}.`);
      recordStartup();
      console.log(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Supabase configured; signup requests will verify storage.' : 'Supabase is not configured. Signups will honestly show unavailable.');
    });
  } catch {
    console.error('Invalid server configuration. Check the settings described in README.md.');
    process.exitCode = 1;
  }
}
