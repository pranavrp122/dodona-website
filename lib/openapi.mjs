export function openApiDocument(origin = '') {
  const response = (description, schema, headers) => ({ description, content: { 'application/json': { schema } }, ...(headers ? { headers } : {}) });
  const error = { $ref: '#/components/schemas/Error' };
  return {
    openapi: '3.1.0',
    info: { title: 'Dodona public API', version: '1.0.0', description: 'Read the proposed product and join the waitlist with user consent. MCP is available separately at /mcp; see /agents for the demo reservation flow. No live reservation, purchase, trading, resale, buyback, or compute access endpoints exist. Signup requires healthy configured storage; 503 means unavailable.' },
    servers: [{ url: origin || '/', description: origin ? 'Configured Dodona origin' : 'Same origin as this document' }],
    paths: {
      '/api/site': { get: { operationId: 'readProduct', summary: 'Read product terms, illustrative figures, and supported capabilities', responses: { '200': response('Public product summary. Examples are not live offers or final prices.', { type: 'object' }) } } },
      '/api/waitlist/status': { get: {
        operationId: 'checkWaitlist', summary: 'Check whether signup is available and obtain a short-lived token',
        description: 'Read-only. Default limit: 120 status/readiness requests per client per minute. A token must be at least 1.5 seconds old at submission and expires after two hours. This endpoint does not save signup details.',
        responses: {
          '200': response('Available; token issued.', { type: 'object', required: ['available', 'token'], properties: { available: { const: true }, token: { type: 'string', maxLength: 160 } } }),
          '503': response('Unavailable; no token issued.', { type: 'object', required: ['available', 'message'], properties: { available: { const: false }, message: { type: 'string' } } }),
          '429': response('Rate limit reached. Respect Retry-After.', error, { 'Retry-After': { schema: { type: 'string' }, description: 'Seconds to wait.' } }),
          '500': response('Unexpected server error.', error),
        },
      } },
      '/api/waitlist': { post: {
        operationId: 'joinWaitlist', summary: 'Join the waitlist after the user asks to join',
        description: 'Use the user-provided email and preferences only with permission to join. Fetch a token first and wait at least 1.5 seconds. No API key is needed. Server-to-server clients may submit JSON; browser requests must use the Dodona origin. Maximum body size: 4 KB. Default limit: 20 attempts per client per 10 minutes. Duplicate emails return the same saved acknowledgement without overwriting preferences or revealing membership. No automated email is sent. A lost response may follow a committed write; retry the same email safely.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Signup' } } } },
        responses: {
          '200': response('Storage confirmed a saved signup or an existing duplicate.', { type: 'object', required: ['status'], properties: { status: { const: 'saved' } } }),
          '400': response('Malformed JSON or invalid body shape.', error),
          '403': response('Rejected origin or token. FORM_EXPIRED requires a new token.', error),
          '413': response('Request body exceeds 4 KB.', error),
          '415': response('Content-Type must be application/json.', error),
          '422': response('Invalid email, interest, useCase, or populated website spam trap.', error),
          '429': response('FORM_TOO_FAST or RATE_LIMIT. Respect Retry-After.', error, { 'Retry-After': { schema: { type: 'string' }, description: 'Seconds to wait.' } }),
          '503': response('Signup was not confirmed. Do not report success.', error),
          '500': response('Unexpected server error. Do not report success.', error),
        },
      } },
    },
    components: { schemas: {
      Signup: {
        type: 'object', required: ['email', 'token'], properties: {
          email: { type: 'string', format: 'email', maxLength: 254, description: 'The email supplied by the user who asked to join. Trimmed and lowercased by the server.' },
          token: { type: 'string', maxLength: 160, description: 'Signed token from GET /api/waitlist/status. Do not construct or alter it.' },
          interest: { type: 'string', enum: ['', 'Individual trading', 'Business hedging', 'Partnership'], description: 'Optional. Existing API values map to personal project, business budget, and compute provider on the form.' },
          useCase: { type: 'string', maxLength: 280, description: 'Optional user-supplied description; control characters are rejected.' },
          website: { type: 'string', const: '', description: 'Spam trap. Omit or leave empty; do not put a URL here.' },
        },
      },
      Error: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, code: { type: 'string', enum: ['FORM_EXPIRED', 'FORM_TOO_FAST', 'RATE_LIMIT'] }, field: { type: 'string', const: 'email' }, retryAfter: { type: 'integer' } } },
    } },
  };
}
