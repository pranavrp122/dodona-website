# Dodona · Milestone 1

A responsive landing page for proposed GPU rental-price protection, with a private Supabase-backed early-access waitlist and an MCP reservation demo. The original plain HTML/CSS/JavaScript approach is retained. A small Node server provides the same-origin API and MCP endpoint; there is no frontend framework, required build step, live pricing engine, or trading functionality.

The proposed product is **delivery-backed compute options**. A call holder can trade during its trading life when a counterparty is available, or choose to exercise by the deadline, pay the strike, and claim defined GPU-hours in the agreed usage window. Delivery means usable compute access. The intended backing is reserved capacity or binding provider commitments; actual supplier arrangements and delivery remedies are still in development. This milestone implements the landing page and waitlist only, not trading, exercise processing, or provisioning.

The public copy explains the product through compute-budget protection: secure a rental price, use it if costs rise, or rent elsewhere if a lower price is available. It uses an insurance analogy without presenting the agreement as an insurance policy. The secured price does not automatically fall with the market, and the upfront fee is non-refundable. Technical option mechanics remain the underlying proposed model.

The static example covers 100 H100 GPU-hours at a $3/GPU-hour secured price with a $20 upfront protection payment to the supplier and a separate $2 Dodona booking fee. Using the compute costs an additional $300, or $322 including protection and booking, excluding taxes or other charges. The $4/hour comparison saves $78 versus renting without protection; choosing an available $2/hour rental instead costs $222 including the original protection and booking payments. Letting protection expire unused does not refund those payments.

The proposed business model earns booking fees, transaction fees on completed user-to-user resales, and service margins on supplier-funded buybacks. The intended booking-fee policy is non-refundable across use, resale, buyback, and expiry, subject to required refund rights. Supplier failure, protection-payment refunds, and capacity backing still require final funded arrangements and terms; the demo does not claim those arrangements exist.

Customers could list protection at their original purchase price or another asking price; completion depends on a willing buyer. The resale illustration shows a $20 sale less a 5% transaction fee, paying the seller $19. Buybacks require a supplier's committed funds before acceptance, and use current executable value rather than a fixed discount from original purchase price. The illustration shows a funded $20 purchase value less a total $1.50 deduction (7.5%), paying the customer $18.50 with no additional resale fee. The deduction covers processing and Dodona's service margin, including its risk allowance. These are explanatory examples, not a final fee schedule, guaranteed quote, or promise of profit. Booking fees remain paid and do not transfer as a refundable balance. Selling transfers the remaining compute access under the original agreement's terms. The existing protection price, quantity, and usage window remain fixed.

All figures are illustrative; there is no current capacity offer, live price, real trading, resale, buyback, exercise processing, or provisioning implementation. The public site explains customer fees and payouts; business costs and margins are documented here rather than presented as customer promises.

The design follows the supplied Dodona HTML: cream, navy, lime, lavender, rounded term sheets, and purple cards. Bricolage Grotesque and Albert Sans are self-hosted with their OFL licenses in `assets/fonts/`, so no external font connection is needed.

The demo’s public identity is stored in `site.json`: **Dodona**, with **dodonamarkets@gmail.com** as its contact address. The owner’s current preference is to keep waitlist details until removal is requested. `/privacy` explains the short demo policy; no scheduled data expiry is enabled. `OPERATOR_NAME`, `CONTACT_EMAIL`, and optional `WAITLIST_RETENTION_DAYS` can override these settings later. No founder biographies or supplier agreements have been invented.

The signup form offers **Check again**, retries availability every 30 seconds while visible, and rechecks when connectivity or focus returns. Recovery preserves entered details. The illustration uses readable mobile cards, and hypothetical $4/$2 rental-price comparisons explain the exercise decision. A local social-sharing image is included; setting `APP_ORIGIN` supplies absolute sharing URLs and canonical links.

## Human and agent access

The landing page uses short descriptions, separate cost and payout examples, native FAQ controls, and a section menu that also works on mobile. Important product information is server-rendered, so readers and crawlers do not need JavaScript to read it. Keyboard navigation, visible focus, labels, and live form status remain supported. JavaScript powers the signup form and paper-order demo; agents can use the signup API directly.

### Browser paper orders

“How it works” includes a browser-only paper-order form at `/#paper-order`. Choose H100, GPU count, total GPU-hours, region preference, and a usage window in UTC. The cost summary updates with quantity. Review the complete request and fees, acknowledge that it is a demo, then place the paper order. The receipt can be downloaded as JSON or cleared by starting another order or refreshing.

Pricing and window/budget checks come from `demo-model.js`, shared with the MCP reservation demo. The example is $0.20 per GPU-hour for protection, a $2 booking fee, and $3 per GPU-hour for compute if used. The UI rejects past/short windows and invalid quantities. A review expires after 15 minutes or when its usage window starts; changed details require a fresh review. Counts represent parallel GPUs, not an extra multiplier on the total GPU-hours.

Paper orders make **no API writes**, take no payment, hold no capacity, create no account, and do not join the waitlist. Their state lives only in page memory, without localStorage or sessionStorage. Receipts use a `PAPER-` reference and explicitly set payment, capacity, real-reservation, and persistence flags to false. They are not the signed MCP quotes or durable booking records. The self-contained HTML preview bundles the same model and UI, so paper orders work offline while real signup collection remains disabled.

Public discovery routes:

| Route | Purpose |
| --- | --- |
| `/agents` | Readable integration guide, linked from the footer |
| `/llms.txt` | Short text guide with links |
| `/llms-full.txt` | Product terms, illustrative figures, and signup instructions |
| `/api/site` | JSON product summary and capability flags; no live pricing or signup records |
| `/openapi.json` | OpenAPI 3.1 schema for the product and waitlist API |
| `/robots.txt` | Crawl rules and the configured sitemap URL |
| `/sitemap.xml` | Home, privacy, and agent documentation URLs |

HTTP `Link` headers advertise the guides and API schema; HTML alternate links advertise the text guide and product JSON. The home page includes Schema.org WebSite and Organization JSON-LD with public contact information, and no invented offers, ratings, or live availability. Its script receives a matching CSP hash; arbitrary inline scripts remain blocked.

Canonical URLs, absolute discovery links, and the sitemap use **only `APP_ORIGIN`**, never incoming Host or forwarded-host headers. Without a configured public origin, document links stay relative and `/sitemap.xml` returns 503 instead of inventing a public address. The text guide is a discovery aid, not a guarantee that search engines or agents will index the site. A public HTTPS deployment and a real domain are still required for public discovery.

Agents may submit a signup only when a user asks to join and provides their email. They fetch a token from `GET /api/waitlist/status`, wait at least 1.5 seconds, then POST the JSON fields described by the schema. A confirmed `200 {"status":"saved"}` is the only success signal; configured Supabase remains required. The existing token checks, origin checks, rate limits, validation, and duplicate handling apply. No cross-origin browser permissions or credential access were added. API interest values retain the original vocabulary; the guide maps them to the clearer form labels. Agent instructions do not expose an endpoint to trade, request a buyback, provision compute, or read/remove signup records.

## MCP reservation demo

The app serves a **stateless Streamable HTTP MCP server at `/mcp`**, using the pinned official SDK. Connect `http://127.0.0.1:3000/mcp` from a local compatible MCP client. For remote Claude/ChatGPT clients that support MCP connectors, first deploy the app behind HTTPS and add `<APP_ORIGIN>/mcp` in that client's connector settings. The endpoint must be connected before a chat can use its tools. The code has been verified with the SDK client, not by connecting a user's Claude or ChatGPT account. No public deployment or automatic connector registration has been performed.

Once connected, ask: **“Help me book a demo H100 reservation with Dodona.”** The server supplies these tools:

| Tool | Purpose |
| --- | --- |
| `get_product` | Read the product, proposed terms, and example figures |
| `get_reservation_requirements` | Get missing-detail questions, supported values, and server time |
| `quote_demo_reservation` | Validate preferences and return a signed illustrative quote |
| `confirm_demo_reservation` | Return a simulated receipt after user confirmation |
| `get_waitlist_status` | Check real signup availability and obtain a token |
| `join_waitlist` | Save an authorized signup through the existing storage integration |

Resources: `dodona://product`, `dodona://guide`. Prompt: `reserve_compute_demo`. All tool responses include text and structured JSON, and failures use `isError: true`. Tool metadata identifies the real waitlist write separately from read-only information and stateless simulations.

The reservation conversation collects GPU type/count, **total** GPU-hours, start/end times with explicit timezone, and region. It asks only for missing details. Optional `maxUpfrontUsd` and `maxTotalIfUsedUsd` caps prevent silently exceeding the user's budget. H100 only; 1–8 GPUs; 1–10,000 total GPU-hours; a future usage window starting within one year and long enough for the requested hours divided by GPU count. Regions are preferences, not provider inventory.

Demo prices scale the site's illustrative example: $3/GPU-hour compute, $0.20/GPU-hour protection, and a $2 booking fee. Monetary results are integer cents. For 100 GPU-hours, the quote shows $22 upfront and another $300 if the compute is used, totaling $322 before taxes or other charges. The agent must show the amounts, window, deadline, terms, and demo disclaimer, then ask for confirmation. Quote tokens bind those exact details, expire after 15 minutes or when the usage window starts, and reject tampering. Repeated confirmation of the same valid token gives the same receipt ID. Stable `WAITLIST_FORM_SECRET` is also used to sign demo quotes; production already requires it.

**No money is charged, no capacity is held, and no reservation is saved.** The receipt includes `mode: "demo"`, `status: "simulated"`, `paymentCharged: false`, `capacityHeld: false`, `realReservationCreated: false`, and `persisted: false`. It is an agent interaction demo, not a simulated successful payment or a live capacity offer. Signup remains an independent, real write when Supabase is configured; its token, validation, and per-client limits are shared across REST and MCP. MCP signup needs `userConsent: true` and an aged status token; it never signs someone up merely because they requested a demo reservation.

Run the local scripted walkthrough after starting the server:

```sh
npm run demo:mcp
```

It calls the actual MCP endpoint, programmatically confirms **only the demo**, and writes an ignored example receipt at `artifacts/mcp-demo-receipt.json`. It never calls the signup tool. Optional `MCP_SERVER_URL` selects another reachable HTTPS endpoint; local HTTP is restricted to loopback addresses. This script uses sample dates from the server's clock and a clearly named demo region preference.

MCP requests are POST-only, accept JSON and event-stream response types per the protocol, and receive JSON responses. GET/DELETE return 405; there are no persistent sessions. Request bodies are limited to 4 KB; default transport limit is 120 requests/client/minute, using the same trusted-proxy address resolver as the site. Host and Origin checks prevent unconfigured hosts and cross-site browser requests; reverse proxies must preserve the configured Host or a loopback Host. No permissive CORS or OAuth is added for public read/demo tools. The app does not log tool arguments or emails. The SDK and zod are pinned runtime dependencies; Docker installs them with `npm ci --omit=dev --ignore-scripts`.

The updated image has been built and its MCP demo tested with production dependencies only. In this cloud environment the Docker builder needed proxy build arguments, a mapping for the proxy hostname, and the platform's trusted CA supplied as the optional `npm_ca` BuildKit secret. Those are build-environment settings, not app configuration. The certificate and proxy values are not copied into the image. Normal hosts with public registry access can use `docker build` directly; keep TLS verification enabled when configuring a corporate or platform proxy.

Real bookings require a separate implementation and launch review: authenticated customer identity, live supplier inventory and enforceable capacity backing, final fees/terms, hosted checkout, verified payment webhooks, durable reservation records, idempotent booking/fulfillment, and funded failure/refund handling. Those systems cannot be replaced by MCP. Until they exist, the reservation tools remain explicitly demo-only.

## Run the review preview

Requires **Node 24 or later**. Install the pinned MCP SDK and validation dependencies with `npm ci --ignore-scripts` before starting the app. The frontend remains plain HTML/CSS/JavaScript.

```sh
cd /workspace/dodona-website
npm ci --ignore-scripts
npm start
```

The server uses port 3000 and binds to `127.0.0.1` by default. `HOST` and `PORT` override those defaults. On a host that needs container ingress, set `HOST=0.0.0.0` in the host settings. Use HTTPS through the hosting platform before collecting real signups. Serve the HTML and API together; a static-only host cannot collect signups.

**Without Supabase configuration, the landing page works and the form honestly says signups are temporarily unavailable.** It cannot display signup success without a confirmed database write. There are no production mock-success modes, localStorage fallbacks, or public signup-list routes.

For a self-contained design preview that can be opened without the server, run `npm run preview:html` and open `artifacts/dodona-preview.html` in a browser. It embeds the fonts, styles, and navigation behavior. Its form explicitly cannot collect signups; use the Node server and configured Supabase for real collection. Generated previews and screenshots are ignored by Git.

## Connect shared, durable waitlist storage

1. Create or select a Supabase project controlled by Dodona. In its authenticated **SQL Editor**, run [`supabase/waitlist.sql`](supabase/waitlist.sql). This creates the `public.waitlist` table, a unique email constraint, row-level security, and server-role permissions. The table has no public access policies, and grants are revoked from `public`, `anon`, and `authenticated`.
2. In local development, copy `.env.example` to `.env`. In hosting, use the platform’s **server-side secret/environment settings**, not files in the public site. Set:
   - `SUPABASE_URL`: the project URL, such as `https://your-project.supabase.co`.
   - `SUPABASE_SERVICE_ROLE_KEY`: the **legacy `service_role` key** in the project API key settings. This implementation expects the JWT service-role key, not an anon/publishable key or the newer `sb_secret_` format. Never put it in client JavaScript, a public environment prefix, chat, Git, or build output.
   - `APP_ORIGIN`: the exact deployed HTTPS origin, with no path or trailing slash. For local checks, leave it empty or use the exact local origin including its port.
   - `WAITLIST_FORM_SECRET`: a private random value shared by all server instances. Generate one locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. A single local process can use the generated in-memory default. Set a stable value in production to keep form tokens valid across restarts/replicas.
3. If your environment restricts outbound traffic, allow HTTPS to **your exact Supabase project hostname**. Node runs with normal certificate validation and proxy support (`--use-env-proxy`). Do not disable TLS checks.
4. Restart the Node server. `/api/waitlist/status` checks access to the table without returning signup data. The form becomes available only when that check succeeds. Failures are cached for at most 2 seconds; use **Check again** after fixing configuration. Healthy results are cached for up to 30 seconds.
5. Run the real storage check below before enabling collection publicly.

The current cloud machine has no Supabase URL or service-role credential. Therefore a real durable write, removal of its test row, and live verification of Supabase permissions **remain blocked by external setup**. The supplied migration and integration are ready for configuration; local fixture tests do not establish that a Supabase project works.

## Verify real storage and remove the test record

```sh
npm run verify:storage
```

With real configuration, this command starts a temporary local API, submits a unique `dodona-verification-<uuid>@example.invalid` address twice, reads the private Supabase table to verify there is exactly one row, and deletes **only that generated test record**. It then checks that the record is absent. It exits nonzero on unavailable storage, failure, or unconfirmed cleanup. If cleanup cannot be verified, it prints only the test address for the owner to remove in the private dashboard. No credentials are logged.

For an owner-run manual check, submit your own test address through the page, confirm it appears in the private Table Editor, and delete that exact test row afterward.

## Owner access to submissions

Sign in to the **Supabase dashboard** with your owner/team account and open **Table Editor → `waitlist`**. The columns are `email`, `interest`, `use_case`, and `created_at`, plus the row ID. Restrict Supabase project membership to authorized Dodona team members. Use the dashboard’s authenticated export controls if you need a CSV, and keep exports private. There is intentionally no public or unauthenticated list/export endpoint on this website. The service-role key grants privileged database access and must stay on the server.

For a private local CSV, run `npm run waitlist:export` with server-side Supabase configuration. It writes only email, interest, use case, and signup time into the Git-ignored `exports/` directory, with private file permissions and spreadsheet-formula protection. It never prints signup details or credentials, and the server does not serve exported files.

For this demo, review the private table regularly and manage product-update emails through the owner’s existing email workflow. A signup does not trigger an automatic confirmation or notification email. Verify unsubscribe/deletion requests from the signup address, remove that exact record in the private dashboard, and remove it from any private mailing exports too. The website’s contact and privacy links provide the request address. Do not use the list for unrelated campaigns or publish exports. Automated mailing and visitor analytics are not connected in this demo.

Duplicate email addresses are normalized and ignored atomically by Postgres. They produce the same successful acknowledgement as new signups, without revealing whether an address was already on the list. Existing signup preferences are preserved rather than overwritten by a duplicate request. A lost response may follow a committed write; retrying safely checks the same unique address.

## Validation and basic spam protection

The server enforces required email syntax and length, the three allowed interests, the 280-character optional use case, and a 4 KB request-body limit. It requires a server-signed, short-lived form token with a minimum completion time, rejects a populated honeypot, checks request origins, accepts only JSON, and limits each TCP peer to 20 attempts per 10 minutes. SQL uniqueness handles concurrent duplicate submissions.

The rate limiter is intentionally basic and in-memory. Direct connections use their socket address. For a reverse-proxy deployment, set `TRUSTED_PROXY_CIDRS` to the exact proxy addresses or private networks controlled by your host. The server walks `X-Forwarded-For` from the socket toward the first untrusted hop, so different visitors are counted separately and client-prepended identities cannot replace the real visitor. Untrusted peers and malformed chains use the socket address. IPv4-mapped and IPv6 addresses are normalized. All-network trust (`/0` or `*`) is rejected.

Only trust a proxy that appends or overwrites visitor addresses correctly, and keep the app’s port private behind that proxy. Do not guess a broad trust network just to make limits work. Use hosting-edge limits for multiple replicas and keep `WAITLIST_FORM_SECRET` shared. The status endpoints have their own request limits. This milestone does not add CAPTCHA, email verification, automated mail delivery, or a marketing dashboard.

Public assets are explicitly allowlisted; `.env`, server code, SQL, tests, and directory listings are not served. The API does not return addresses, storage error details, or service credentials. The page uses a restrictive content-security policy, visible focus states, labeled controls, accessible status/error messages, and reduced-motion support.

## Tests

Backend tests use Node’s built-in test runner:

```sh
npm test
```

Browser tests use pinned dev dependencies and an installed Chromium:

```sh
npm ci --ignore-scripts
npm run test:browser
```

`tests/browser.mjs` uses `/usr/bin/chromium` by default. Set `BROWSER_EXECUTABLE` to your installed Chromium path on another machine. The prepared cloud machine already has Chromium. The browser tests generate ignored desktop/mobile screenshots in `artifacts/`, check layouts at 320, 390, 768, 1024, 1440, and 1920 px, run axe accessibility checks, and exercise keyboard navigation and waitlist states.

`tests/fixture.mjs` is a **test-only, in-memory PostgREST fixture**. It verifies HTTP integration, validation, duplicate/concurrent writes, confirmation timing, spam controls, storage failures, and recovery without touching a live project. It is never served or enabled in the production app. Test-fixture success does not mean genuine expressions of interest were stored in Supabase.

## Review and deployment

The local preview is for review; no production domain has been published. Once the owner supplies Supabase settings and the real storage check passes, deploy the same Node app behind HTTPS, set `APP_ORIGIN`, and restart it with server-side secrets. The page must continue to state that Dodona is in development and real-money trading is unavailable. Signup is for product updates and possible early access, not a purchase or a guarantee of trading eligibility.

`Dockerfile` installs the lockfile's production dependencies with lifecycle scripts disabled and excludes test tools, exports, and `.env` files. It runs the app as the unprivileged `node` user. To review the demo in a container with signups unavailable:

```sh
docker build --tag dodona-demo:review .
docker run --rm --publish 127.0.0.1:3101:3000 --env NODE_ENV=development dodona-demo:review
```

In this cloud workspace, Docker’s usual config directory is read-only. If needed, use `DOCKER_CONFIG=/tmp/dodona-docker-config` for those commands. This isolated Docker config was used for the verified build.

Before external collection, run:

```sh
npm run check:deployment -- --verify
npm run verify:storage
```

The first command validates the required settings and read-only storage connectivity without logging values; the second verifies an actual signup, duplicate handling, and test-record cleanup. Both must succeed before live collection is claimed. Production mode requires an exact HTTPS `APP_ORIGIN` and a stable private `WAITLIST_FORM_SECRET` of at least 32 characters. The Docker image defaults to production mode; supply runtime settings through the host’s secret settings or a private `--env-file`, never bake them into an image.

Use `/healthz` for server liveness and `/readyz` for waitlist readiness. `/readyz` returns 503 until storage is genuinely available. Set up an external readiness alert on the chosen host before collecting publicly. An operational web server alone does not prove signup storage works. Configure the host’s TLS termination, domain, private proxy network, and runtime secrets once the host is selected. These external settings and live Supabase verification remain outstanding.
