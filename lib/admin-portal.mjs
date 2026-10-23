/** Admin portal wiring: serves the /admin page and its assets while the platform is on, and the Supabase sync API backed by the CRM mirror. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './site.mjs';
import { sessionAccount } from './auth.mjs';
import { createCrmMirror, mirrorSettings } from './crm-mirror.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ADMIN_FILES = new Map([
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin-view.js', ['admin-view.js', 'text/javascript; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
]);
const SYNC_PATH = '/api/admin/sync';

const fail = (json, response, status, code, message, extra = {}) => json(response, status, { ok: false, error: { code, message }, ...extra });

/**
 * Options: the mounted `demo` platform (for boot() and enabled), `now`, `origin`, `settings`, `logger`, `json`,
 * and `mirror` ({ environment, fetchImpl, intervalMs }) for tests. The mirror's timer starts once the database opens.
 */
export function createAdminPortal({ demo, now = Date.now, origin = '', settings, logger = console, json, mirror: mirrorOptions = {} }) {
  let mirror = null;
  const mirrorFor = db => (mirror ??= createCrmMirror({ db, logger, now, ...mirrorOptions }));
  // Only a configured mirror opens the database at startup; otherwise it opens on the first request as before.
  if (demo.enabled && mirrorSettings(mirrorOptions.environment).configured) {
    demo.boot().then(db => mirrorFor(db).start()).catch(() => logger.error('[crm-mirror] The demo database did not open, so the mirror is off.'));
  }

  async function serveFile(request, response, url) {
    const [path, type] = ADMIN_FILES.get(url.pathname);
    let content = await readFile(resolve(ROOT, path));
    if (type.startsWith('text/html')) content = Buffer.from(renderPage(content.toString('utf8'), { settings, origin, path: '/admin' }));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    return response.end(request.method === 'HEAD' ? undefined : content);
  }

  async function serveSync(request, response) {
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return fail(json, response, 405, 'method_not_allowed', 'Method not allowed.');
    if (request.method === 'POST') {
      const expected = origin || `http://${request.headers.host}`;
      if ((request.headers.origin && request.headers.origin !== expected) || request.headers['sec-fetch-site'] === 'cross-site') return fail(json, response, 403, 'bad_origin', 'Use the Dodona site origin.');
    }
    const db = await demo.boot();
    const account = sessionAccount(db, request, now());
    if (!account) return fail(json, response, 401, 'signed_out', 'Sign in to continue.');
    if (account.role !== 'admin') return fail(json, response, 403, 'forbidden', 'This needs an admin account.');
    const crm = mirrorFor(db);
    if (request.method !== 'POST') return json(response, 200, { ok: true, ...crm.status() });
    const result = await crm.run();
    if (!result.configured) return fail(json, response, 409, 'mirror_not_configured', result.message);
    if (!result.ok) return fail(json, response, 502, 'mirror_failed', result.message, { pushed: result.pushed });
    return json(response, 200, { ...result, ok: true });
  }

  /** Handles the admin page files and the sync API; returns false for anything else or when the platform is off. */
  async function handle(request, response, url) {
    if (!demo.enabled) return false;
    if (url.pathname === SYNC_PATH) { await serveSync(request, response); return true; }
    if (ADMIN_FILES.has(url.pathname) && ['GET', 'HEAD'].includes(request.method)) { await serveFile(request, response, url); return true; }
    return false;
  }

  return { handle, stop: () => mirror?.stop() };
}
