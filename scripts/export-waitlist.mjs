import { mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { storeFromEnvironment } from '../lib/supabase.mjs';
import { fetchWaitlistRows, waitlistCsv } from '../lib/export.mjs';

try {
  const store = storeFromEnvironment();
  if (!store) throw new Error();
  const rows = await fetchWaitlistRows(store);
  const directory = new URL('../exports/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = new URL(`waitlist-${randomUUID()}.csv`, directory);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(waitlistCsv(rows)); } finally { await file.close(); }
  console.log(`Exported ${rows.length} signup records to ${path.pathname}. Keep this file private.`);
} catch {
  console.error('Private export failed. Configure Supabase and the waitlist table first. No credentials or signup details were logged.');
  process.exitCode = 1;
}
