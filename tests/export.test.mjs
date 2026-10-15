import test from 'node:test';
import assert from 'node:assert/strict';
import { waitlistCsv, fetchWaitlistRows } from '../lib/export.mjs';
test('CSV export preserves quotes and line breaks without executing submitted formulas', () => {
  const csv = waitlistCsv([{ email: 'test@example.com', interest: 'Partnership', use_case: '=IMPORTXML("danger")\nsecond line', created_at: '2026-10-13T00:00:00Z', secret: 'must-not-export' }]);
  assert.ok(csv.includes('"\'=IMPORTXML(""danger"")\nsecond line"'));
  assert.ok(!csv.includes('must-not-export'));
});
test('storage failures prevent a successful export', async () => {
  await assert.rejects(fetchWaitlistRows({ request: async () => ({ ok: false }) }));
});
