import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { publicSite, agentGuide } from './discovery.mjs';
import { createDemoReservations, DemoReservationError, reservationInput } from './demo-reservations.mjs';
import { registerQuoteCap } from './mcp-quote.mjs';

const instructions = `Dodona is in development. Purchases, real reservations, payments, trading, resale, buybacks, and GPU access are unavailable.
When a user asks to reserve compute, explain that you can demonstrate the flow only. Call get_reservation_requirements, then ask for missing GPU type/count, total GPU-hours, usage dates and timezone, and region. Ask about an upfront budget if the user gives one. Do not invent details or choose another GPU silently.
Call quote_demo_reservation and show the upfront protection payment, booking fee, later compute payment, usage window, access deadline, and terms. Clearly say no payment or capacity hold will occur. Ask the user to confirm before confirm_demo_reservation; present its result as a simulated receipt, never a real booking.
Waitlist signup is separate. Use join_waitlist only when the user asks to join and supplies their email. Fetch a status token first and let it age at least 1.5 seconds. Never claim signup success if unavailable or unconfirmed. Never ask for card details or server credentials.`;

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const result = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError });

export async function handleMcp(request, response, body, { settings, origin, contractValues = false, secret, now, address, getWaitlistStatus, joinWaitlist, logger }) {
  const server = new McpServer({ name: 'dodona', version: '1.0.0' }, { instructions });
  const demos = createDemoReservations({ secret, now });
  const guard = callback => async args => {
    try { return result(await callback(args)); }
    catch (error) {
      if (error instanceof DemoReservationError || error.status) return result({ status: 'not_completed', code: error.code || error.details?.code || 'UNAVAILABLE', message: error.message, ...(error.details?.code === 'FORM_TOO_FAST' ? { retryAfterSeconds: 2 } : error.details?.retryAfter ? { retryAfterSeconds: error.details.retryAfter } : {}) }, true);
      logger.error('[mcp] Tool failed.');
      return result({ status: 'not_completed', code: 'INTERNAL_ERROR', message: 'The request was not confirmed. Try again later.' }, true);
    }
  };

  server.registerTool('get_product', { title: 'Read Dodona product information', description: 'Read terms, example fees, and supported capabilities. No live offers.', inputSchema: z.object({}).strict(), annotations: readOnly }, guard(() => publicSite(settings, origin)));
  server.registerTool('get_reservation_requirements', {
    title: 'Get demo reservation questions', description: 'Read the questions needed for a demo reservation. No real capacity or payments are available.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, guard(() => ({
    mode: 'demo', supportedGpuTypes: ['H100'], serverTime: new Date(now()).toISOString(),
    questions: [
      { fields: ['gpuType', 'gpuCount', 'gpuHours'], question: 'Which GPU, how many together, and how many total GPU-hours do you need?' },
      { fields: ['usageStartsAt', 'usageEndsAt'], question: 'When should the usage window start and end, and in which timezone?' },
      { fields: ['region'], question: 'Which region would you prefer?' },
      { fields: ['maxUpfrontUsd', 'maxTotalIfUsedUsd'], optional: true, question: 'Do you want a limit on the upfront payment or the total if you use the compute?' },
    ],
    constraints: { gpuCount: { min: 1, max: 8 }, gpuHours: { min: 1, max: 10000 }, window: 'Future, starts within a year, long enough for the GPU-hours divided by GPU count.', quoteValidMinutes: 15 },
    disclaimer: 'Demo only. No payment, capacity hold, or real reservation. Ask only for details the user has not already provided.',
  })));
  server.registerTool('quote_demo_reservation', {
    title: 'Prepare a demo reservation quote', description: 'Generate an illustrative signed quote for GPU price protection. Does not check supplier inventory, charge money, or reserve compute. Present all costs, dates, and terms and obtain user confirmation before the next tool.',
    inputSchema: reservationInput, annotations: readOnly,
  }, guard(args => demos.quote(args)));
  server.registerTool('confirm_demo_reservation', {
    title: 'Confirm a simulated reservation', description: 'Return a DEMO receipt after the user confirms the displayed quote and terms. No real booking, payment, capacity hold, or stored reservation is created. Retrying the same quote returns the same receipt identifier.',
    inputSchema: z.object({ quoteToken: z.string().max(3500), userConfirmed: z.literal(true).describe('True only after the user confirms this specific demo quote and terms.') }).strict(),
    annotations: readOnly,
  }, guard(args => demos.confirm(args)));
  server.registerTool('get_waitlist_status', {
    title: 'Check real signup availability', description: 'Check private storage availability and obtain a signed signup token when available. Does not save details. Wait at least 1.5 seconds before using the token.',
    inputSchema: z.object({}).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, guard(() => getWaitlistStatus(address)));
  server.registerTool('join_waitlist', {
    title: 'Join the Dodona waitlist', description: 'Save a real signup only after the user asks to join and supplies the email. Requires a token from get_waitlist_status aged at least 1.5 seconds. Shares the website’s validation, limits, storage confirmation, and duplicate handling. Does not book compute or send an automatic email.',
    inputSchema: z.object({
      email: z.string().max(254), token: z.string().max(160), userConsent: z.literal(true),
      interest: z.enum(['', 'Individual trading', 'Business hedging', 'Partnership']).optional(), useCase: z.string().max(280).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, guard(({ userConsent, ...args }) => joinWaitlist(args, address)));
  registerQuoteCap(server, { now });
  server.registerResource('product', 'dodona://product', { title: 'Product and terms', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(publicSite(settings, origin)) }] }));
  server.registerResource('guide', 'dodona://guide', { title: 'Agent guide', mimeType: 'text/plain' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: agentGuide(settings, origin, true, contractValues) }] }));
  server.registerPrompt('reserve_compute_demo', { title: 'Walk through a demo reservation', description: 'Ask the reservation questions, review the costs, and confirm a simulated receipt.' }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Walk me through a demo GPU price-protection reservation. Ask only for missing details, show the full quote and terms, and ask me to confirm. Tell me clearly that no money or compute capacity is involved.' } }] }));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.once('close', () => { void server.close().catch(() => {}); });
  await server.connect(transport);
  try { await transport.handleRequest(request, response, body); }
  catch (error) { await server.close(); throw error; }
}
