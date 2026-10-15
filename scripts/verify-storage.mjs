// Real, private Supabase verification. This command cannot pass without live storage.
import { randomUUID } from 'node:crypto';
import { storeFromEnvironment } from '../lib/supabase.mjs';
import { createApp } from '../server.mjs';

let store;
try { store = storeFromEnvironment(); }
catch { console.error('Invalid Supabase configuration. See README.md; no credentials were logged.'); process.exit(1); }
if (!store) {
  console.error('Live storage verification is blocked: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY securely, then run supabase/waitlist.sql.');
  process.exit(1);
}

const email = `dodona-verification-${randomUUID()}@example.invalid`;
const app = createApp({ store, origin: '', production: false });
let createdId;
let verificationError;
try {
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const readiness = await fetch(origin + '/api/waitlist/status');
  if (!readiness.ok) throw new Error('The configured storage is not ready.');
  const { token } = await readiness.json();
  await new Promise(resolve => setTimeout(resolve, 1600));
  const submit = () => fetch(origin + '/api/waitlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email, interest: 'Partnership', useCase: 'Owner-run storage verification. Remove after check.', token }),
  });
  for (let i = 0; i < 2; i++) {
    const response = await submit();
    if (!response.ok || (await response.json()).status !== 'saved') throw new Error('The signup endpoint did not confirm storage.');
  }
  const response = await store.request(`?email=eq.${encodeURIComponent(email)}&select=id,email,interest,use_case`);
  if (!response.ok) throw new Error('Unable to verify the stored test row.');
  const rows = await response.json();
  if (rows.length !== 1 || rows[0].email !== email || rows[0].interest !== 'Partnership') throw new Error('Expected exactly one saved test row.');
  createdId = rows[0].id;
  console.log('Live signup storage and duplicate handling verified.');
} catch {
  verificationError = true;
  console.error('Live verification failed. Check Supabase settings, the migration, and network access. No credentials were logged.');
} finally {
  // Delete only the uniquely generated address, even if the write response was lost.
  try {
    const removed = await store.request(`?email=eq.${encodeURIComponent(email)}${createdId ? `&id=eq.${encodeURIComponent(createdId)}` : ''}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!removed.ok) throw new Error();
    const check = await store.request(`?email=eq.${encodeURIComponent(email)}&select=id`);
    if (!check.ok || (await check.json()).length !== 0) throw new Error();
    console.log('Verification test record removed and absence confirmed.');
  } catch {
    verificationError = true;
    console.error(`Test cleanup could not be confirmed. In the private Supabase dashboard, check and remove only this test address: ${email}`);
  }
  app.closeAllConnections();
  await new Promise(resolve => app.close(resolve));
}
if (verificationError) process.exitCode = 1;
