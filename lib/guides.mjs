// Public guide pages written for people (and AI assistants) researching GPU costs.
import { readFile } from 'node:fs/promises';
import { renderPage } from './site.mjs';
import { GUIDES } from './guide-list.mjs';


const byPath = new Map(GUIDES.map(guide => [guide.path, guide]));

// Returns true when the request was for a guide page and has been answered.
export async function handleGuide(request, response, url, { settings, origin }) {
  const guide = byPath.get(url.pathname);
  if (!guide || !['GET', 'HEAD'].includes(request.method)) return false;
  const html = await readFile(new URL(`../${guide.file}`, import.meta.url), 'utf8');
  const content = Buffer.from(renderPage(html, { settings, origin, path: guide.path }));
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
  response.end(request.method === 'HEAD' ? undefined : content);
  return true;
}
