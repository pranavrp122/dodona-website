import { createApp } from '../server.mjs';
import { readSiteSettings } from '../lib/site.mjs';
import { storeFromEnvironment } from '../lib/supabase.mjs';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_ORIGIN', 'WAITLIST_FORM_SECRET'];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  console.error('Live collection setup is incomplete. Set these server-side settings securely: ' + missing.join(', '));
  process.exit(1);
}
try {
  const store = storeFromEnvironment();
  createApp({ production: true, store, siteSettings: readSiteSettings() });
  if (process.argv.includes('--verify')) {
    await store.health();
    console.log('Production settings and read-only Supabase connectivity verified. Run npm run verify:storage to test a real signup and cleanup.');
  } else console.log('Production settings validated. Run with --verify to check read-only storage connectivity.');
} catch {
  console.error('Production settings or storage connectivity could not be verified. Check README.md. No secret values were logged.');
  process.exitCode = 1;
}
