import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let endpoint;
try { endpoint = new URL(process.env.MCP_SERVER_URL || `${process.env.APP_ORIGIN || 'http://127.0.0.1:3000'}/mcp`); }
catch { throw new Error('Invalid MCP_SERVER_URL. Use a valid HTTP loopback or public HTTPS URL.'); }
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
  endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
  throw new Error('Use an HTTPS MCP URL, or an HTTP loopback URL for local testing, without credentials or query parameters.');
}
const client = new Client({ name: 'dodona-reservation-demo', version: '1.0.0' });
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(`Demo step ${name} did not complete.`);
  return response.structuredContent;
};
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const requirements = await call('get_reservation_requirements');
  const starts = Date.parse(requirements.serverTime) + 86400000;
  const quote = await call('quote_demo_reservation', {
    gpuType: 'H100', gpuCount: 1, gpuHours: 100, region: 'US East (demo preference)',
    usageStartsAt: new Date(starts).toISOString(), usageEndsAt: new Date(starts + 5 * 86400000).toISOString(),
    maxUpfrontUsd: 20, maxTotalIfUsedUsd: 320,
  });
  console.log('DEMO ONLY: $20 upfront for protection; $300 for compute if used; $320 total before taxes or other charges.');
  // This scripted demo intentionally simulates confirmation. It never joins the
  // real waitlist, takes a payment, reserves capacity, or creates a stored booking.
  const receipt = await call('confirm_demo_reservation', { quoteToken: quote.quoteToken, userConfirmed: true });
  if (receipt.mode !== 'demo' || receipt.status !== 'simulated' || receipt.paymentCharged !== false || receipt.capacityHeld !== false || receipt.realReservationCreated !== false || receipt.persisted !== false) throw new Error('Unexpected reservation mode.');
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/mcp-demo-receipt.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
  console.log('Simulated receipt created. No money charged, capacity held, or reservation stored. See artifacts/mcp-demo-receipt.json.');
} catch {
  console.error('MCP demo failed. Start the Node app or configure a reachable MCP_SERVER_URL. No real booking was attempted.');
  process.exitCode = 1;
} finally { await client.close(); }
