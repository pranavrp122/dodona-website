/** Admin portal wiring: serves the /admin page and its assets while the platform is on, and starts the Supabase CRM mirror's timer. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from './site.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ADMIN_FILES = new Map([
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/admin-view.js', ['admin-view.js', 'text/javascript; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
]);

/**
 * Options: the mounted `demo` platform (enabled, boot()), the `mirror` service from lib/crm-mirror.mjs, `origin`, `settings`
 * and `logger`. The /api/admin/sync routes live with the other admin routes in lib/admin.mjs.
 */
export function createAdminPortal({ demo, mirror, origin = '', settings, logger = console }) {
  // Only a configured mirror opens the database at startup; otherwise it opens on the first request as before.
  if (demo.enabled && mirror?.configured) {
    demo.boot().then(db => mirror.start(db)).catch(() => logger.error('[crm-mirror] The demo database did not open, so the mirror is off.'));
  }

  async function serveFile(request, response, url) {
    const [path, type] = ADMIN_FILES.get(url.pathname);
    let content = await readFile(resolve(ROOT, path));
    if (type.startsWith('text/html')) content = Buffer.from(renderPage(content.toString('utf8'), { settings, origin, path: '/admin' }));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    return response.end(request.method === 'HEAD' ? undefined : content);
  }

  /** Serves the admin page files; returns false for anything else, and always when the platform is off. */
  async function handle(request, response, url) {
    if (!demo.enabled || !ADMIN_FILES.has(url.pathname) || !['GET', 'HEAD'].includes(request.method)) return false;
    await serveFile(request, response, url);
    return true;
  }

  return { handle, stop: () => mirror?.stop() };
}
