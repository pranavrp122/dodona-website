import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { renderPage, readSiteSettings, privacyBody } from '../lib/site.mjs';

const root = new URL('../', import.meta.url);
let html = await readFile(new URL('index.html', root), 'utf8');
const settings = readSiteSettings();
html = renderPage(html, { settings, origin: process.env.APP_ORIGIN || '' });
html = html.replaceAll('href="/privacy"', 'href="#privacy"');
html = html.replaceAll('href="/agents"', 'href="#agents"');
html = html.replaceAll('href="/agents#mcp"', 'href="#agents"');
html = html.replace(/\s*<link rel="alternate"[^>]+>/g, '');
let css = await readFile(new URL('styles.css', root), 'utf8');
const fontNames = ['bricolage-grotesque-latin-standard-normal.woff2', 'albert-sans-latin-wght-normal.woff2'];
for (const font of fontNames) {
  const bytes = await readFile(new URL(`assets/fonts/${font}`, root));
  css = css.replace(`/assets/fonts/${font}`, `data:font/woff2;base64,${bytes.toString('base64')}`);
}
const licenses = await Promise.all(['bricolage-grotesque', 'albert-sans'].map(name => readFile(new URL(`assets/fonts/${name}-LICENSE.txt`, root), 'utf8')));
const favicon = await readFile(new URL('assets/favicon.svg', root));
html = html.replace('/assets/favicon.svg', `data:image/svg+xml;base64,${favicon.toString('base64')}`);
html = html.replace(/\s*<link rel="preload"[^>]+>/, '');
html = html.replace('<link rel="stylesheet" href="/styles.css">', `<!-- Bundled typeface licenses:\n${licenses.join('\n').replaceAll('--', '—')}\n-->\n<style>${css}</style>`);
// Standalone review has no backend. Disable only availability, never fake a write.
let client = await readFile(new URL('waitlist.js', root), 'utf8');
client = client.replace('  async function checkAvailability(quiet = false) {', `  async function checkAvailability() {
    token = null;
    button.disabled = true;
    retry.hidden = true;
    clearTimeout(retryTimer);
    label.textContent = 'Signups unavailable in this preview';
    announce('This standalone review preview does not collect signups. No signup has been saved.', 'unavailable');
    return false;
  }

  async function unusedLiveAvailability() {`);
html = html.replace('<script src="/waitlist.js" defer></script>', '');
const paperModel = (await readFile(new URL('demo-model.js', root), 'utf8')).replace(/^export /gm, '');
const paperClient = (await readFile(new URL('paper-order.js', root), 'utf8')).replace(/^import \{[^}]+\} from '\.\/demo-model\.js';\n/, '');
html = html.replace('<script type="module" src="/paper-order.js"></script>', '');
html = html.replace('</main>', `<section class="sec wrap privacy-preview" id="privacy"><h2>Privacy &amp; signup information</h2>${privacyBody(settings, 'h3')}</section><section class="sec wrap privacy-preview" id="agents"><h2>For agents</h2><p>The Node app provides a demo MCP server at /mcp, connection instructions at /agents, a text guide at /llms.txt, product data at /api/site, and the signup API schema at /openapi.json. MCP quotes and receipts do not take payments or reserve capacity. This offline design preview has no API and cannot collect signups or run the MCP demo.</p></section></main>`);
html = html.replace('</body>', `<script>${client}</script>\n<script type="module">${paperModel}\n${paperClient}</script>\n</body>`);
await mkdir(new URL('artifacts/', root), { recursive: true });
await writeFile(new URL('artifacts/dodona-preview.html', root), html);
console.log('Created artifacts/dodona-preview.html — self-contained review only; signups are unavailable.');
