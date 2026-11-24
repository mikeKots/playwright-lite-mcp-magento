# playwright-lite-mcp

A token-efficient MCP server for **Magento 2 / Adobe Commerce / Mage-OS QA** by AI coding agents: health, full page cache, GraphQL and guest checkout checks in one call each, plus a Playwright **code mode** with a `magento` helper API for everything else. TypeScript, MCP SDK v2, Playwright.

**A guest checkout check costs ~3,000 tokens instead of ~20,000** with the official `@playwright/mcp` ([benchmark](#token-benchmark)).

It works with any MCP client (Claude Code, Cursor, Codex, VS Code, an agent on a local model): the server only drives a browser and sends HTTP requests to the store. It calls no LLM itself and needs no API key; the client's model does the reasoning and its tokens are billed to the client as usual.

## Quick start (Claude Code plugin)

The plugin brings the MCP server (the Docker image, started by Claude Code) and a `magento-qa` skill: a playbook that tells the agent which tool answers which question, to use code mode for multi-page work, how to read the verdicts, and never to place orders on production. Requires Docker.

```
/plugin install playwright-lite-mcp --marketplace mikeKots/playwright-lite-mcp-magento
```

(On Claude Code before 2.1.275: `/plugin marketplace add mikeKots/playwright-lite-mcp-magento`, then `/plugin install playwright-lite-mcp@playwright-lite-mcp-magento`.)

The install asks for its options; change them later with `/plugin configure playwright-lite-mcp`:

| Option | Default | |
|---|---|---|
| Allowed store origins | required | `PW_ALLOWED_ORIGINS`, e.g. `https://staging.example.com,https://*.example.com` |
| Code mode (`browser_run`) | on | `PW_ALLOW_SCRIPTS`: scripts run inside the container |
| Local store hostname | `host.docker.internal` | a store on this machine (Warden, DDEV, Valet), e.g. `app.mystore.test`: the container resolves it to the host |
| Ignore HTTPS errors | off | `PW_IGNORE_HTTPS_ERRORS`: needed for a local store, whose CA the container does not trust |

Then run `/mcp` and check that `plugin:playwright-lite-mcp:playwright-lite` is connected, and ask, for example: *"Smoke-test the checkout and the page cache of https://staging.example.com"*. For other settings (`PW_COOKIE_ACCEPT`, timeouts, a logged-in session) use the manual setup below.

## Quick start (Docker, one command)

Without the plugin, or with another MCP client. Requires Docker. Claude Code starts the container itself; the image is pulled on first use:

```bash
claude mcp add -s user playwright-lite -- docker run -i --rm --init \
  -e PW_ALLOWED_ORIGINS="https://your-store.example.com" \
  -e PW_ALLOW_SCRIPTS=true \
  ghcr.io/mikekots/playwright-lite-mcp-magento:latest
```

Restart Claude Code, run `/mcp` and check `playwright-lite: connected`. Then ask, for example: *"Run magento_guest_checkout for https://your-store.example.com/some-simple-product.html and tell me the order total"*.

For a **local dev store** (Warden, DDEV, Valet) the container needs to reach the host and accept the local CA:

```bash
claude mcp add -s user playwright-lite -- docker run -i --rm --init \
  --add-host app.hyva-demo.test:host-gateway \
  -e PW_ALLOWED_ORIGINS="https://app.hyva-demo.test" \
  -e PW_ALLOW_SCRIPTS=true \
  -e PW_IGNORE_HTTPS_ERRORS=true \
  ghcr.io/mikekots/playwright-lite-mcp-magento:latest
```

## Quick start (npx, no Docker)

Requires Node.js 20+. Install the browser once (the version must match the Playwright the package uses), then register the server:

```bash
npx playwright@1.63.0 install chromium
claude mcp add -s user playwright-lite \
  -e PW_ALLOWED_ORIGINS="https://your-store.example.com" \
  -e PW_ALLOW_SCRIPTS=true \
  -- npx -y playwright-lite-mcp
```

A local `.test` store works directly here (no `--add-host`, and the host trusts its local CA). If the browser is missing, the tools answer with the exact install command. Other MCP clients: command `npx`, arguments `-y playwright-lite-mcp`, the same environment variables.

From source: [Step 1](#step-1-install) and [Step 6](#step-6-connect-to-claude-code). One shared server for a team or a QA box: [HTTP transport](#step-8-http-transport). A ready-made demo store to try it on: [sample-store/](sample-store/README.md).

## Tools

| Tool | One call does |
|---|---|
| `magento_guest_checkout` | product (simple or configurable with options) → cart → checkout → shipping → payment (→ Place Order); totals, offered methods, console errors per step, failed requests |
| `magento_cache_check` | full page cache verdict per URL (Varnish, Fastly, Cloudflare, built-in), with the reason when a page is not cached |
| `magento_product_check` | price and stock on each product page vs. GraphQL, as a guest; catches a stale full page cache, indexer and special price bugs, zero prices, wrong JSON-LD |
| `magento_graphql_check` | GraphQL presets (store, catalog, products incl. zero prices, guest cart, GET caching) or your own query |
| `page_health_check` | HTTP status, load time and JS errors for a list of pages |
| `browser_run` | code mode: one Playwright script with `page` and the `magento` helpers, only its return value comes back |
| `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_console_errors`, `browser_reset` | the basics, for anything else |

## Token benchmark

Same task on both servers: guest checkout of a simple product up to the payment step, then read the totals and the console errors (`node sample-store/benchmark.mjs`, against the demo store):

| Server | Tool calls | Tool results | Tool definitions | Total (one task) |
|---|---|---|---|---|
| `@playwright/mcp@0.0.86` (tool chain) | 16 | ~15,000 tok | ~5,300 tok | ~20,300 tok |
| playwright-lite: `magento_guest_checkout` | 1 | ~136 tok | ~2,900 tok | ~3,000 tok (85% less) |
| playwright-lite: `browser_run` + `magento.checkout` | 1 | ~67 tok | ~2,900 tok | ~2,900 tok (85% less) |

Tokens are estimated as characters / 4. The official server gets its cheapest realistic sequence (a snapshot only when element refs are needed, one `fill_form` for all address fields); each of its three page snapshots alone is ~4,300 tokens. A real agent also re-sends the growing conversation with each of those 16 model requests, so the real difference is bigger.

## Tested on

| Store | Mode | Result |
|---|---|---|
| Mage-OS 4.0.0 (Magento 2.4.x) + Hyvä 1.5, Varnish | developer | all tools pass |
| same store, Hyvä | production | all tools pass (`magento_product_check` not run in production yet) |
| same store, Luma | developer | all tools pass |
| Adobe Commerce Cloud (Fastly) | — | not tested yet: reports and PRs welcome |

Known limitations:
- **Hyvä Checkout** (Magewire) is not supported by `magento_guest_checkout`: it is a paid product, so it cannot be tested here. It is detected and reported as unsupported; the standard `Magento_Checkout` works on Luma and on Hyvä with `hyva-themes/magento2-luma-checkout`. `browser_run` can script other checkouts.
- **Bundle products** cannot be added to the cart by `magento_guest_checkout`: script them with `browser_run`.

The demo store and the checks are in [sample-store/](sample-store/README.md): `sample-store/check.sh` runs every tool against a store over MCP.

## Why another one, when there is the official @playwright/mcp

The official server is general-purpose, and therefore heavy: large page snapshots and many tools eat the agent's context. This server gives three things:

1. **Fewer tokens.** Page snapshots are truncated to a limit, and domain tools such as `page_health_check`, `magento_cache_check`, `magento_graphql_check` and `magento_guest_checkout` replace dozens of navigate → snapshot round-trips with one call and a compact report.
2. **Security.** The browser only opens allowlisted origins. Deny by default: without `PW_ALLOWED_ORIGINS` the server refuses to start.
3. **Domain tools.** Add your own, like the built-in guest checkout for Magento.

## Step 1. Install

From source. Building and testing need Node.js 22.12+ (the published package runs on Node.js 20+).

```bash
npm install
npm run browsers        # downloads Chromium for Playwright
npm run typecheck
npm test
npm run build
```

## Step 2. Layout

```
src/
  index.ts          entry point: picks the transport, graceful shutdown
  server.ts         McpServer factory (one per stdio process / per HTTP session)
  http.ts           Streamable HTTP transport: auth, Host/Origin checks, sessions
  config.ts         env config validated with zod (fail fast)
  security.ts       origin allowlist
  script.ts         code mode: runs the agent's Playwright script (browser_run)
  browser.ts        browser lifecycle: lazy start, auto-restart, redirect blocking
  tools.ts          MCP tools
  magento.ts        Magento guest checkout flow (magento_guest_checkout)
  options.ts        configurable product options for the checkout
  product.ts        price and stock check (magento_product_check)
  cache.ts          full page cache check (magento_cache_check)
  graphql.ts        GraphQL API check (magento_graphql_check)
  health.ts         page health check (page_health_check, magento.health)
  helpers.ts        the `magento` helper API for browser_run scripts
  mutex.ts          serialized tool execution
  logger.ts         JSON logs to stderr
  errors.ts         turns Playwright errors into short, agent-readable messages
  *.test.ts         tests: allowlist, cookies, code mode, tool integration, checkout, cache, GraphQL, product, HTTP transport
skills/magento-qa/  Claude Code plugin skill: the QA playbook for the agent
.claude-plugin/     plugin manifest (plugin.json) and marketplace (marketplace.json)
.mcp.json           the plugin's MCP server: the Docker image over stdio
sample-store/       demo store (Mage-OS + Hyvä on Warden): setup.sh, check.sh, mcp-smoke.mjs, benchmark.mjs
.github/workflows/  CI (tests + Docker build) and Release (GHCR image, GitHub release, npm)
```

There is a ready-made store to test against: see [sample-store/README.md](sample-store/README.md).

## Step 3. Production-ready principles (what is done here)

**stdout belongs to the protocol.** With the stdio transport, JSON-RPC goes over stdout, so any `console.log` breaks the connection. All logs go to stderr (`logger.ts`). This is the most common reason a server "does not connect".

**Errors are returned as results, not thrown.** A tool returns `isError: true` with a short message and a hint ("call browser_snapshot to re-inspect"). The agent reads it and recovers instead of crashing.

**Serialized execution.** Agents may call several tools in parallel. Two clicks on one page at the same time give flaky results, so a `Mutex` runs calls one by one.

**Timeouts everywhere.** Navigation and actions have configurable limits, so a hung page never blocks the agent forever.

**Two layers of URL protection.** First: the tool argument is checked. Second: `context.route` blocks top-level navigation to other origins after a click or a server redirect. Playwright only intercepts the first request of a redirect chain, so each hop is fetched with `maxRedirects: 0` and its `Location` is checked separately (test `blocks a server redirect…`). Iframes and sub-resources (CDNs, payment widgets) are not blocked, so checkout keeps working.

**No secrets in logs.** Tool arguments are never logged, and `browser_fill` does not echo the typed value, because it may be a password.

**Resilience.** The browser starts lazily on the first tool call, so the client handshake is fast. If Chromium crashes, it is relaunched on the next call.

**Graceful shutdown.** SIGINT/SIGTERM, a closed stdin (stdio: the client ended the session) or an unexpected error close the browser (HTTP: every session, then the shared browser). A hard 5-second timeout makes sure no zombie Chromium is left behind.

## Step 4. Configuration

| Variable | Default | Description |
|---|---|---|
| `PW_ALLOWED_ORIGINS` | required | Comma-separated: `http://localhost:3000,https://*.example.com`. `*` allows any site |
| `PW_BROWSER` | `chromium` | `chromium`, `firefox`, `webkit` |
| `PW_HEADLESS` | `true` | `false` to watch the browser window |
| `PW_NAV_TIMEOUT_MS` | `30000` | Navigation timeout (also the limit for slow checkout steps) |
| `PW_ACTION_TIMEOUT_MS` | `10000` | Click, fill, etc. timeout |
| `PW_SNAPSHOT_MAX_CHARS` | `15000` | Page snapshot size limit |
| `PW_STORAGE_STATE` | none | JSON file with cookies/localStorage, to start logged in |
| `PW_COOKIE_ACCEPT` | none | Cookie-consent button names separated by `\|`, e.g. `Accept & Close\|Accept all`. Clicked automatically after navigation |
| `PW_COOKIE_WAIT_MS` | `2000` | How long to wait for the cookie banner after navigation |
| `PW_ALLOW_SCRIPTS` | `false` | `true` enables the `browser_run` tool (code mode). Runs agent code in the Node process: local or Docker only |
| `PW_SCRIPT_TIMEOUT_MS` | `60000` | Time limit of one `browser_run` script |
| `PW_IGNORE_HTTPS_ERRORS` | `false` | `true` accepts self-signed certificates (local Warden/DDEV/Valet stores, mainly inside Docker). Never for real sites |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MCP_TRANSPORT` | `stdio` | `http` serves Streamable HTTP instead, see [Step 8](#step-8-http-transport) |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` inside Docker |
| `MCP_HTTP_PORT` | `8940` | Port; the endpoint is `/mcp`, `/healthz` answers without a token |
| `MCP_HTTP_TOKEN` | required for http | Bearer token, at least 24 characters (`openssl rand -hex 32`) |
| `MCP_HTTP_ALLOWED_HOSTS` | none | Extra `Host`/`Origin` hostnames besides localhost and the bind address, comma-separated |
| `MCP_MAX_SESSIONS` | `5` | Concurrent HTTP sessions; each has its own browser context |
| `MCP_SESSION_IDLE_MS` | `1800000` | An HTTP session without requests for this long is closed |

Create a `PW_STORAGE_STATE` file with `npx playwright codegen --save-storage=auth-state.json https://your-site`: log in in the window that opens, then close it. The file is in `.gitignore`, since it holds live session cookies.

## Step 5. Try it with MCP Inspector

```bash
PW_ALLOWED_ORIGINS="https://*.example.com,https://example.com" npm run inspect
```

A web UI opens where you can call each tool by hand and see raw responses. Do this before connecting an agent: it makes it easy to tell a server bug from odd model behavior.

## Step 6. Connect to Claude Code

```bash
claude mcp add --scope user playwright-lite \
  -e PW_ALLOWED_ORIGINS="http://localhost:3000" \
  -e PW_HEADLESS=false \
  -e PW_ALLOW_SCRIPTS=true \
  -- node /absolute/path/to/playwright-lite-mcp/dist/index.js
```

`--scope user` makes the server (and code mode) available in every project; use `--scope project` to limit it to one. Then run `/mcp` in a session and check the server is connected. If the official Playwright MCP is also connected, disable it for the project so the agent does not mix up the tools.

## Step 7. Docker

The image contains Node and Chromium's headless shell only (~1.2 GB). Build it locally:

```bash
docker build -t playwright-lite-mcp .
claude mcp add -s user playwright-lite -- docker run -i --rm --init \
  -e PW_ALLOWED_ORIGINS="https://staging.example.com" -e PW_ALLOW_SCRIPTS=true playwright-lite-mcp
```

Released versions are published to `ghcr.io/mikekots/playwright-lite-mcp-magento:<version>` and `:latest` for amd64 and arm64 (see [Releases](#releases)).

Details:
- `-i` is required, stdio does not work without it. `--init` forwards signals correctly.
- `localhost` inside the container is not your host: use `http://host.docker.internal:3000` and allowlist it.
- A local `.test` domain resolves to `127.0.0.1` only on your host: add `--add-host <domain>:host-gateway`, and `-e PW_IGNORE_HTTPS_ERRORS=true` because the local CA is not trusted inside the container.
- The image runs headless Chromium only, so `PW_BROWSER=firefox|webkit` does not work in Docker.
- Check an image end to end: `node sample-store/mcp-smoke.mjs https://app.hyva-demo.test --docker playwright-lite-mcp`.

## Step 8. HTTP transport

By default the server speaks stdio: the client starts it, one client per process. With `MCP_TRANSPORT=http` it serves [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) instead, so one server (a QA box, a Docker host) can serve several agents:

```bash
TOKEN=$(openssl rand -hex 32)
docker run -d --name playwright-lite -p 127.0.0.1:8940:8940 \
  -e MCP_TRANSPORT=http -e MCP_HTTP_HOST=0.0.0.0 -e MCP_HTTP_TOKEN="$TOKEN" \
  -e PW_ALLOWED_ORIGINS="https://staging.example.com" \
  ghcr.io/mikekots/playwright-lite-mcp-magento:latest

claude mcp add --transport http -s user playwright-lite http://localhost:8940/mcp \
  --header "Authorization: Bearer $TOKEN"
```

How it works:
- **One browser context per MCP session.** Every client that connects gets its own McpServer, page, cookies, cart and tool queue; all sessions share one Chromium process. Two agents never see each other's checkout.
- **Bearer token** on every `/mcp` request (`MCP_HTTP_TOKEN`, compared in constant time). Without it: `401`.
- **DNS rebinding protection.** `Host` and `Origin` must be localhost, the bind address or one of `MCP_HTTP_ALLOWED_HOSTS`; otherwise `403`. Serving it under another name (`http://qa-box:8940/mcp`)? Add `MCP_HTTP_ALLOWED_HOSTS=qa-box`.
- **No code mode over HTTP.** `browser_run` runs agent code inside the server process, so the server refuses to start with `PW_ALLOW_SCRIPTS=true` and `MCP_TRANSPORT=http`. All domain tools and basic browser tools are available.
- **Limits.** `MCP_MAX_SESSIONS` (default 5, a new session beyond it gets `503`) and `MCP_SESSION_IDLE_MS` (default 30 minutes without requests closes the session and its context). A client ending its session (`DELETE /mcp`) frees it at once.
- `GET /healthz` returns `{"status":"ok","sessions":N}` without a token, for Docker or load balancer health checks.

The token protects the endpoint, not the traffic: plain HTTP is fine on localhost or inside a private network. Anything beyond that belongs behind a reverse proxy with TLS. Check it end to end: `node sample-store/mcp-smoke.mjs https://app.hyva-demo.test --http` (add `--docker <image>` for the image).

## Step 9. Code mode (`browser_run`)

Instead of a navigate → snapshot → click → snapshot chain, the agent writes one Playwright script, the server runs it, and only the result goes back into the agent's context. Fewer tokens, and loops and conditions become possible.

Enable with `PW_ALLOW_SCRIPTS=true`. Without it the tool is not registered.

```json
{ "code": "await page.goto('https://shop.test/'); await page.getByRole('link', { name: 'Shoes' }).click(); return await page.locator('.product-item-name').allInnerTexts();" }
```

- `code` is the body of an async function with `page` in scope. `return` sends back a JSON result.
- On timeout (`timeoutMs` or `PW_SCRIPT_TIMEOUT_MS`) the page is closed, cookies survive, and the next call gets a fresh page.
- Navigation to other origins is blocked by the same `context.route`.

> **Not a sandbox.** The script runs in the Node process with the user's permissions: it can reach `process`, files and the network. The allowlist only restricts browser navigation. Enable it only locally or in Docker, and never expose it over an HTTP transport.

### The `magento` helpers

Inside a script, `magento` is in scope next to `page`. The helpers are the domain tools, but they return plain data instead of text, so the script can loop, filter and aggregate, and only its final summary reaches the agent:

| Helper | Returns |
|---|---|
| `magento.url(path)` | absolute URL on the current page's store |
| `magento.health(urls)` | `[{ url, ok, status, ms, errors }]` (navigates the script's page) |
| `magento.cache(urls, { requests?, withSession? })` | `[{ url, verdict, hops, notes, ... }]` |
| `magento.graphql(query, variables?, { method?, storeUrl?, storeCode? })` | `{ status, ms, data, errors }` |
| `magento.graphqlChecks({ checks?, sku? })` | `[{ ok, name, ms, detail }]` |
| `magento.product(urls, { storeCode? })` | `[{ url, verdict, problems, notes, api, page }]`: price and stock check in a fresh guest context |
| `magento.checkout({ productUrl, qty?, shippingMethod?, paymentMethod?, placeOrder? })` | `{ ok, failedStep, error, cart, shippingMethods, totals, orderNumber, consoleErrors, failedRequests, steps }`; runs in a separate fresh guest context, so the script's page is untouched |
| `magento.cart()` | `{ items, subtotal }` of the script's own session, or `null` |

Example: categories from GraphQL → cache check of each → guest checkout of two products, in one call:

```js
await page.goto('https://app.hyva-demo.test/');
const cats = await magento.graphql('{ categoryList(filters: { url_path: { in: ["gear", "gear/bags"] } }) { url_path } }');
const cache = await magento.cache(cats.data.categoryList.map((c) => magento.url('/' + c.url_path + '.html')));
const checkouts = [];
for (const path of ['/joust-duffle-bag.html', '/voyage-yoga-bag.html']) {
  const r = await magento.checkout({ productUrl: magento.url(path) });
  checkouts.push({ path, ok: r.ok, total: r.totals.find(([k]) => k === 'Order Total')?.[1] });
}
return { cache: cache.map((c) => `${c.verdict} ${c.url}`), checkouts };
```

A guest checkout takes 5–10 s: pass a larger `timeoutMs` for loops. Every URL still goes through the allowlist.

Example prompt for Claude Code: "Using `browser_run` and the magento helpers, check the cache of every Gear category on https://app.hyva-demo.test and run a guest checkout for two bags; return only problems".

## Step 10. Magento guest checkout (`magento_guest_checkout`)

One call goes through the real storefront like a customer: product page → Add to Cart → checkout → shipping address → shipping method → payment method → (optionally) Place Order. It returns a compact QA report:

```
Guest checkout: OK (stopped before Place Order; pass placeOrder: true to place it)
Product: Joust Duffle Bag | cart: 1 item(s), subtotal $34.00
Shipping: flatrate_flatrate | offered: flatrate_flatrate (Flat Rate - Fixed, $5.00); tablerate_bestway (Best Way - Table Rate, $15.00)
Payment: checkmo | offered: checkmo
Totals: Cart Subtotal $34.00 | Shipping Flat Rate - Fixed $5.00 | Order Total $39.00
Steps: add_to_cart 0.5s, checkout_load 1.1s, shipping_address 0.0s, shipping_method 2.3s, payment 2.3s
Console errors: none
Failed requests: none
```

Input (only `productUrl` is required):

| Field | Default | |
|---|---|---|
| `productUrl` | — | Product page of a simple or configurable product |
| `qty` | page default | |
| `options` | — | Configurable products: `"first"` (first in-stock variant) or attribute → value labels, e.g. `{ "Size": "M", "Color": "Blue" }`; attributes you leave out are taken from the first in-stock match |
| `email` | `guest@example.com` | |
| `address` | US test address (Austin, Texas) | Any of `firstname`, `lastname`, `street`, `city`, `postcode`, `countryId`, `region`, `telephone` |
| `shippingMethod` | first offered | `carrier_method` code, e.g. `flatrate_flatrate` |
| `paymentMethod` | `checkmo`, else first | |
| `placeOrder` | `false` | `true` creates a real order and returns its number |
| `keepSession` | `false` | By default every call starts as a fresh guest (cookies and cart cleared, also those from `PW_STORAGE_STATE`) |

Behavior worth knowing:
- Console errors are tagged with the step they happened in (`[payment] console: ...`), and the store's own 4xx/5xx responses are listed: these are usually the actual checkout bug.
- The 404 on `guest-carts/.../totals` right after Place Order is normal Magento behavior (the quote is closed once the order exists) and is not reported.
- On failure the result is `isError: true` with the failed step and the reason, and the page is left at that step, so the agent can call `browser_snapshot` to look.
- Configurable products: the option values and which combinations are in stock come from GraphQL; the options are then chosen on the page the way a customer does it (Luma swatches clicked, Hyvä radios checked, dropdowns selected). The cart is then checked to hold exactly the chosen variant's SKU, so a theme bug that adds the wrong variant is caught. Unknown values and out-of-stock combinations are explained before anything is clicked.
- Without `options`, a product with options fails immediately with an explanation. Bundle products are not supported: use `browser_run`.
- Supported: the standard `Magento_Checkout` (Luma, and Hyvä with `hyva-themes/magento2-luma-checkout`). Hyvä Checkout (Magewire) and other one-step checkouts are detected and reported as unsupported.

## Step 11. Full page cache check (`magento_cache_check`)

Requests each URL several times over plain HTTP and tells whether the full page cache serves it, and if not, why:

```
Cache check: 2 requests per URL, as a guest without cookies. Layer: Varnish
CACHED        https://app.hyva-demo.test/gear.html | HIT 2ms age=1685 → HIT 2ms age=1685 | via X-Cache | tags: 10
CACHED        https://app.hyva-demo.test/gear/bags.html?product_list_order=price | MISS 342ms → HIT 22ms | via X-Cache | tags: 21
NOT_CACHEABLE https://app.hyva-demo.test/checkout/cart/ | MISS 125ms → MISS 117ms | via X-Cache | cache-control: max-age=0, must-revalidate, no-cache, no-store
  - Magento marked the page uncacheable (X-Magento-Cache-Control: max-age=0, must-revalidate, no-cache, no-store)
  - expected: Magento never caches cart/checkout/customer pages
Summary: 2/3 cached, 1 not cacheable
```

Input: `urls` (up to 20), `requests` (2–5, default 2: the first may warm the cache, the last must be a HIT), `withSession` (default `false`: a cookie-less guest, which is what the shared cache entry is for; `true` sends the browser's cookies, e.g. a logged-in customer or `X-Magento-Vary`).

How it decides:
- **Cache status** from whichever header the stack provides: `X-Magento-Cache-Debug` (built-in FPC, or stock Varnish VCL in developer mode), `X-Cache` (Warden VCL, Fastly / Adobe Commerce Cloud, many CDNs; `MISS, HIT` from Fastly counts as a hit), `CF-Cache-Status` (Cloudflare), `X-Varnish` (two transaction ids = hit), `Age`.
- **Cacheability** from what Magento itself sent: `X-Magento-Cache-Control` and `X-Magento-Tags`. Behind Varnish the client-facing `Cache-Control` is always `no-store` (the VCL rewrites it), so it is ignored there.
- **Verdicts:** `CACHED`; `NOT_CACHEABLE` (marked expected for cart/checkout/customer pages, otherwise a hint to look for a `cacheable="false"` layout block); `MISS` (looks cacheable but is not served from cache: lists `Set-Cookie` on the response, query strings, and the config to check); `UNKNOWN` (no status headers, e.g. production mode hides `X-Magento-Cache-Debug`); `ERROR` (4xx/5xx or not allowlisted).
- Redirects are reported, not followed.

## Step 12. GraphQL check (`magento_graphql_check`)

Checks the GraphQL API that headless/PWA storefronts and many Hyvä/Luma widgets depend on. Without a query it runs preset checks, one line each:

```
GraphQL: https://app.hyva-demo.test/graphql
OK   store 85ms | default "Default Store View", USD, en_US
OK   catalog 90ms | 6 top-level categories: What's New (0), Women (0), Men (0), Gear (34), Training (0), Sale (0)
OK   products 290ms | 181 products; first 20: 20 Configurable
OK   cart 732ms | guest cart + 24-WG02 ×1 → qty 1, subtotal 92.00 USD, grand total 92.00 USD (an abandoned guest cart is left behind)
OK   cache 4ms | GET storeConfig: HIT 6ms → HIT 4ms via X-Cache, X-Magento-Cache-Id present
Summary: 5/5 OK
```

| Preset | What it checks |
|---|---|
| `store` | `storeConfig`: store code, name, currency, locale |
| `catalog` | children of the root category with product counts |
| `products` | product listing: total, types, out-of-stock items, **zero final prices** (a classic indexing/price-scope bug) |
| `cart` | `createEmptyCart` + `addProductsToCart` with `sku` (default: the first in-stock simple product it finds) and the cart prices; reports `user_errors`. Leaves an abandoned guest cart |
| `cache` | the same GET query twice: Magento caches GraphQL GET requests, so the second one should be a HIT |

With `query` (and optional `variables`, `method: "GET"` to see the cache status) it runs your query instead and returns HTTP status, GraphQL errors with category and path, timing and the data truncated to `maxChars` (default 2000). Other input: `storeUrl` (any store URL, or the full endpoint), `checks` (a subset of presets), `storeCode` (sent as the `Store` header). Requests are sent as a cookie-less guest; non-JSON answers (an HTML error page, a redirect) are described instead of failing the call.

## Step 13. Price and stock check (`magento_product_check`)

Compares what a guest sees on each product page with what Magento GraphQL reports for the same product (found by URL through `route`, falling back to the `url_key`). The page is opened in a fresh guest context, so both sides use the NOT LOGGED IN customer group. Here the price was changed in the database without a cache flush, so Varnish still serves the old page:

```
0/1 OK, 1 MISMATCH
MISMATCH 24-MB01 "Joust Duffle Bag" (simple) https://app.hyva-demo.test/joust-duffle-bag.html
         price page 34.00 / GraphQL 39.00 USD | stock page "IN STOCK" / GraphQL IN_STOCK | page cache HIT via X-Cache
         - price: page 34.00 ≠ GraphQL final 39.00 USD (page served from cache, HIT via X-Cache: stale full page cache?)
         · WARNING JSON-LD Product price 34.00 ≠ GraphQL 39.00 USD
         · WARNING meta product:price:amount price 34.00 ≠ GraphQL 39.00 USD
```

| Check | Problem (`-`, makes the verdict MISMATCH) when |
|---|---|
| price | the main price on the page ≠ GraphQL `price_range.minimum_price.final_price` (configurable, bundle, grouped: the minimum). Hints: page served from cache (stale FPC), a tax-like ratio (catalog price display incl./excl. tax), otherwise indexer / catalog price rule / special price dates |
| old price | GraphQL has a discount and the struck-through price ≠ the regular price, or the page shows an old price GraphQL does not have |
| stock | the page label (In stock / Out of stock) ≠ GraphQL `stock_status`; in stock without an Add to Cart button; a configurable whose parent is in stock but no variant is |
| zero price | GraphQL final price is 0 |

Verdicts: `OK`, `MISMATCH`, `UNKNOWN` (the page price was not found: theme markup not recognized), `ERROR` (page or GraphQL failed, the URL is not a product). JSON-LD offers (`Product`, `ProductGroup` variants, `AggregateOffer`) and the `product:price:amount` meta tag are compared too, as warnings (`·`) that do not change the verdict. Prices are read from the first `.price-box` in `.product-info-main` outside related/upsell lists: `data-price-amount` on Luma, the formatted text on Hyvä (any locale format, e.g. `1.234,50 €`). Input: `urls` (up to 20), `storeCode` (sent to GraphQL as the `Store` header).

## Step 14. Adding your own tool

```ts
const CartTotalInput = z.object({ productUrl: z.string() });

server.registerTool(
  'cart_add_and_total',
  {
    title: 'Add to cart and read total',
    description: 'Open a product page, add it to cart and return the cart total.',
    inputSchema: CartTotalInput,
  },
  run<z.infer<typeof CartTotalInput>>('cart_add_and_total', async ({ productUrl }, page) => {
    await page.goto(assertUrlAllowed(productUrl, cfg.PW_ALLOWED_ORIGINS).toString());
    await page.getByRole('button', { name: /add to cart/i }).click();
    await page.goto(new URL('/checkout/cart', productUrl).toString());
    const total = await page.getByTestId('cart-total').innerText();
    return text(`Cart total: ${total}`);
  }),
);
```

Rules: describe the input with a zod schema with `.describe()` on every field (the model reads these descriptions), keep the response short and to the point, and always run through `run()`.

## Releases

Versions follow [semantic versioning](https://semver.org), starting at `0.1.0` (`0.x` = the tool set may still change). `CHANGELOG.md` lists the changes. To release:

`main` is protected, so a version bump goes through a pull request like any other change, and the tag is pushed after the merge:

```bash
git switch -c release/0.1.1 origin/main
npm version patch --no-git-tag-version      # or minor; edits package.json + package-lock.json
# move the CHANGELOG "unreleased" notes under the new version, commit, push, open a PR, merge it
git fetch origin && git tag v0.1.1 origin/main && git push origin v0.1.1
```

The `Release` workflow (started by the tag) then tests, builds and pushes the Docker image to GitHub Container Registry, creates a GitHub release and publishes the npm package (so it can also run with `npx playwright-lite-mcp`). npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers): no token is stored; on npmjs.com the package's trusted publisher is this repository with the workflow `release.yml`, and each version gets a provenance attestation. `CI` runs typecheck, tests, build and a Docker build on every push and pull request.
