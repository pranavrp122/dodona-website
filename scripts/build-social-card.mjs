import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = new URL('../', import.meta.url);
const fonts = await Promise.all(['bricolage-grotesque-latin-standard-normal.woff2', 'albert-sans-latin-wght-normal.woff2'].map(name => readFile(new URL(`assets/fonts/${name}`, root))));
const svg = await readFile(new URL('assets/social-card.svg', root), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>body{margin:0}svg{display:block}@font-face{font-family:'Bricolage Grotesque';font-weight:200 800;src:url(data:font/woff2;base64,${fonts[0].toString('base64')})}@font-face{font-family:'Albert Sans';font-weight:100 900;src:url(data:font/woff2;base64,${fonts[1].toString('base64')})}</style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  await writeFile(new URL('assets/social-card.png', root), await page.screenshot());
  console.log('Built the 1200 × 630 social-sharing card.');
} finally { await browser.close(); }
