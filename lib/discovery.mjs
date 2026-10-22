import { openApiDocument } from './openapi.mjs';

export const productSummary = 'Dodona is building a way to book GPU rental prices ahead of time. Pay for price protection and booking, then choose whether to use the agreed compute.';

export function publicSite(settings, origin = '') {
  const link = path => origin + path;
  return {
    schemaVersion: 1,
    name: 'Dodona',
    status: 'in_development',
    description: productSummary,
    contact: { operator: settings.operatorName, email: settings.contactEmail },
    capabilities: {
      readProduct: true,
      mcp: { url: link('/mcp'), transport: 'streamable_http', reservationMode: 'demo_only', requiresConnectorSetup: true },
      reservationDemo: { quote: true, confirm: true, paymentCharged: false, capacityHeld: false, persisted: false },
      browserPaperOrder: { url: link('/#paper-order'), localOnly: true, paymentCharged: false, capacityHeld: false, persisted: false },
      waitlist: { statusUrl: link('/api/waitlist/status'), submitUrl: link('/api/waitlist'), requiresUserConsent: true },
      purchaseProtection: false, trading: false, resale: false, buyback: false, computeAccess: false,
    },
    terms: {
      computeBacking: 'Intended backing: reserved capacity or binding provider commitments. Supplier arrangements and failure terms are not finalized.',
      bookingFee: 'Intended to remain paid on use, resale, buyback, or expiry, subject to required refund rights.',
      resale: 'The seller chooses an asking price. A willing buyer is required. A transaction fee applies only to a completed sale; remaining compute access transfers on the original terms.',
      buyback: 'Requires committed supplier funding. The payout uses current executable value less a disclosed deduction, not a fixed discount from the original payment. Quotes are not guaranteed.',
      expiry: 'Unused protection expires at its deadline. No compute is supplied, and the upfront protection and booking payments are not refunded.',
    },
    example: {
      illustrative: true, finalPricing: false, currency: 'USD', gpu: 'H100', gpuHours: 100,
      rentalPricePerGpuHour: 3, protectionPayment: 20, bookingFee: 2, upfrontTotal: 22,
      computePayment: 300, totalIfUsed: 322,
      comparison: { rentalAt4PerHour: 400, protectedTotal: 322, saving: 78, rentalElsewhereAt2PlusUpfront: 222 },
      resale: { salePrice: 20, transactionFeePercent: 5, fee: 1, sellerPayout: 19 },
      buyback: { fundedPurchaseValue: 20, deductionPercent: 7.5, deduction: 1.5, customerPayout: 18.5 },
      excludes: 'Taxes and any other charges. These are examples, not live offers.',
    },
    links: {
      home: link('/'), costs: link('/#example'), selling: link('/#flexibility'), signup: link('/#early-access'),
      questions: link('/#faq'), privacy: link('/privacy'), agents: link('/agents'),
      guide: link('/llms.txt'), fullGuide: link('/llms-full.txt'), openapi: link('/openapi.json'),
    },
  };
}

export function structuredData(settings, origin = '') {
  const organization = { '@type': 'Organization', name: settings.operatorName, email: settings.contactEmail };
  const website = { '@type': 'WebSite', name: 'Dodona', description: productSummary, inLanguage: 'en' };
  if (origin) {
    organization['@id'] = origin + '/#organization';
    organization.url = origin + '/';
    website['@id'] = origin + '/#website';
    website.url = origin + '/';
    website.publisher = { '@id': organization['@id'] };
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [organization, website] }).replaceAll('<', '\\u003c');
}

export function agentGuide(settings, origin = '', full = false) {
  const link = path => origin + path;
  let text = `# Dodona

> GPU rental-price protection. In development. This demo does not take payments, trade protection, arrange buybacks, or provide compute.

${productSummary}

## Read the site
- [Home](${link('/')}): product explanation and examples.
- [Costs](${link('/#example')}): example includes protection and booking payments.
- [Paper order](${link('/#paper-order')}): browser-only details, cost review, and simulated receipt; no account, payment, capacity hold, signup, or saved reservation.
- [Selling](${link('/#flexibility')}): resale and supplier-funded buyback examples.
- [Privacy](${link('/privacy')}): signup data, retention, and removal requests.
- [Contract values](${link('/contracts')}): sample GPU rental contracts with a daily Dodona Value (illustrative analytics, not ratings or offers). JSON at ${link('/api/contracts')} and ${link('/api/prices')}.
- [Agent instructions](${link('/agents')}): how to use the live signup API.
- [Product JSON](${link('/api/site')}): terms, example figures, and supported capabilities.
- [OpenAPI](${link('/openapi.json')}): request schemas, responses, and limits.
- [Cap quote](${link('/api/quote')}): GET a demo price-cap, floor or fixed-price quote (pricing v0); read-only, nothing is booked.
- [Full guide](${link('/llms-full.txt')}): terms and signup steps in one text document.
- [MCP connection guide](${link('/agents#mcp')}): remote Streamable HTTP endpoint at ${link('/mcp')}.

## Supported interaction
Read product information and check signup availability. Submit a waitlist signup only when the user has asked to join and supplied their own email. Signup depends on configured, healthy storage; a 503 means unavailable, never success. No signup records or credentials are public.

MCP supports a reservation demo: collect details, show an illustrative quote, ask the user to confirm, and return a simulated receipt. It never charges money, holds capacity, or stores a reservation. Add ${link('/mcp')} to a client that supports remote Streamable HTTP MCP first; visiting this URL in a browser is not a booking flow.

Contact: ${settings.contactEmail}
Public operator: ${settings.operatorName}
`;
  if (full) text += `
## MCP reservation demo
Endpoint: ${link('/mcp')}. Stateless Streamable HTTP with JSON responses. Use a compatible MCP client and connect the endpoint as a server/connector before asking it to book. MCP requests use POST with application/json and Accept: application/json, text/event-stream. GET and DELETE return 405; there is no persistent SSE session. Default transport limit: 120 requests per client per minute. Request bodies are limited to 4 KB. No OAuth or API key is required for this demo. Supabase and form secrets remain private.

Tools: get_product, get_reservation_requirements, quote_demo_reservation, confirm_demo_reservation, get_waitlist_status, join_waitlist. Resources: dodona://product and dodona://guide. Prompt: reserve_compute_demo.

Ask only for missing GPU type/count, total GPU-hours, usage window with timezone, region, and any budget limits. H100 only; 1–8 GPUs; 1–10,000 total GPU-hours; a future usage window starting within one year and long enough for the hours divided by GPU count. A region is a preference, not verified inventory. Optional maxUpfrontUsd and maxTotalIfUsedUsd are budget caps in USD; do not increase them silently.

Demo pricing scales the site example: $3 per GPU-hour for compute, $0.20 per GPU-hour for protection, plus a $2 booking fee. This is illustrative arithmetic, not a pricing engine or a supplier offer. Money fields use integer cents. Quotes are signed and expire after 15 minutes or when their usage window starts, whichever comes first.

Show the upfront payment, compute payment if used, total cost, usage window, access deadline, booking policy, and demo disclaimer before asking the user to confirm. Only then call confirm_demo_reservation with the exact quoteToken and userConfirmed=true. It returns a simulated receipt with paymentCharged=false, capacityHeld=false, realReservationCreated=false, persisted=false. The same token returns the same receipt identifier; no reservation database or checkout exists.

Waitlist tools are separate: get_waitlist_status returns the same signed form token as the website. join_waitlist requires email, token, userConsent=true, and optional interest/useCase. Wait at least 1.5 seconds after token issuance. They share the website's rate limits, validation, and storage confirmation. An MCP tool failure sets isError=true and status=not_completed; FORM_TOO_FAST and RATE_LIMIT include retryAfterSeconds. Do not report signup success on an error.

## Product terms
The booked rental price, covered GPU-hours, and usage window would be fixed at purchase. The holder can use the price even if the market falls, or rent elsewhere. Cheaper rentals may not be available. One GPU-hour means using one GPU for one hour.

Capacity backing is intended to use reserved capacity or binding provider commitments. Supplier arrangements, access terms, failure remedies, and final pricing are still being developed. This is a compute pricing agreement, not an insurance policy or expense reimbursement.

Dodona's booking fee is intended to remain paid after use, resale, buyback, or expiry, subject to required refund rights. Unused protection expires without supplying compute or refunding the upfront payments. A resale needs a willing buyer and carries a fee only on completion. The remaining compute access transfers on the same terms. Original-price resale is not guaranteed.

Buybacks require a supplier's committed funds. Quotes use current executable value less a disclosed deduction covering processing and Dodona's service margin. A quote is not guaranteed, and its value is not a fixed percentage of the original payment. The customer sees the payout before accepting.

## Example only (USD, not final pricing)
100 H100 GPU-hours at $3/hour. Protection payment $20 + booking fee $2 = $22 upfront. Compute costs another $300 if used, for $322 total. A comparable $4/hour rental costs $400; the example saves $78. A separate $2/hour rental, if available, plus the original $22 costs $222. Taxes and other charges are excluded.

Resale example: $20 sale - $1 transaction fee (5%) = $19 seller payout.
Buyback example: $20 committed supplier purchase value - $1.50 deduction (7.5%) = $18.50 customer payout. No additional resale fee applies in this example. Original booking fees remain paid.

## Waitlist API
1. Confirm the user wants to join and use the email and optional details they supplied. Do not generate signups or infer consent from a visit.
2. GET ${link('/api/waitlist/status')}. A 200 response with available=true supplies a signed token. A 503 means signup is unavailable; stop and report that nothing was saved.
3. Wait at least 1.5 seconds after token issuance. Tokens expire after two hours.
4. POST JSON to ${link('/api/waitlist')} with email and token. Optional fields are interest, useCase, and website. Leave website empty or omit it: it is a spam trap, not a URL field.
5. Only a 200 response with status="saved" confirms signup. Existing and new emails receive the same response; membership cannot be queried. Duplicate emails do not overwrite existing preferences.

Interest values use the existing API vocabulary:
- "Individual trading": the form labels this "Planning a personal project".
- "Business hedging": the form labels this "Protecting a business budget".
- "Partnership": the form labels this "Providing compute capacity".
- "" or omitted: no preference.

Email is required, maximum 254 characters. useCase is optional, maximum 280 characters. Request bodies are limited to 4 KB. A stable form secret and storage credentials are server-only; clients need neither.

Server-to-server requests are supported. Browser requests must originate from the Dodona site; cross-origin browser access is not enabled. Do not spoof Origin headers or bypass the form token or rate limits.

Errors: 400 malformed JSON; 403 invalid/expired token or rejected origin; 413 body too large; 415 wrong content type; 422 invalid fields; 429 too fast or rate-limited; 503 storage unavailable; 500 unexpected server failure. A 429 includes Retry-After. FORM_EXPIRED requires a new status request and token. Default limits: 20 signup attempts per client per 10 minutes, 120 status/readiness checks per minute. Respect Retry-After rather than looping.

If a response is lost, the write may have committed. Report uncertainty and retry the same email safely; do not claim success without confirmation. There is no list, update, delete, purchase, trading, resale, buyback, or provisioning API. For removal or correction, contact ${settings.contactEmail}.

Signup details are stored privately in Supabase when configured. ${settings.retentionDays ? `Retention is ${settings.retentionDays} days from signup.` : 'They are kept until the user asks for removal.'} No automated emails or analytics are connected in this demo.
`;
  return text;
}

export function discoveryDocument(path, { settings, origin = '' }) {
  const json = value => ({ type: 'application/json; charset=utf-8', body: JSON.stringify(value, null, 2) });
  if (path === '/api/site') return json(publicSite(settings, origin));
  if (path === '/openapi.json') return json(openApiDocument(origin));
  if (path === '/llms.txt' || path === '/llms-full.txt') return { type: 'text/plain; charset=utf-8', body: agentGuide(settings, origin, path === '/llms-full.txt') };
  if (path === '/robots.txt') return {
    type: 'text/plain; charset=utf-8',
    body: `User-agent: *\nAllow: /\nDisallow: /api/waitlist\nDisallow: /mcp\nDisallow: /healthz\nDisallow: /readyz\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`,
  };
  if (path === '/sitemap.xml') {
    if (!origin) return { status: 503, type: 'text/plain; charset=utf-8', body: 'The sitemap will be available when the public site URL is configured.\n' };
    const escapeXml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
    return { type: 'application/xml; charset=utf-8', body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/privacy', '/agents', '/contracts',
      '/methodology',
      '/signup',
      '/contact',
      '/rfq'].map(path => `<url><loc>${escapeXml(origin + path)}</loc></url>`).join('')}</urlset>\n` };
  }
  return null;
}
