# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

### Changed
- CI validates the Claude Code plugin manifests (`claude plugin validate .`) on every push and pull request.
- GitHub Actions upgraded to their Node 24 majors (checkout, setup-node, Docker actions, action-gh-release); the release build sets `package-manager-cache: false`.
- README: npm, CI, Docker image and license badges.

## [0.1.1] - 2026-11-24

### Added
- README: quick start with `npx playwright-lite-mcp` (no Docker), including the browser install step.

### Changed
- A missing Playwright browser is reported with the exact install command (`npx playwright@<version> install chromium`) instead of a cut-off Playwright banner.
- Release workflow publishes to npm through trusted publishing (OIDC) instead of an `NPM_TOKEN` secret; each npm version gets a provenance attestation. The release build no longer uses the npm dependency cache.
- Dev: vitest 5 (fixes the critical tinypool advisories GHSA-5gmw-xhrv-c9v3 and GHSA-85c8-ppgw-ccpr; dev dependencies only, the published package was not affected). Building and testing from source need Node.js 22.12+.

## [0.1.0] - 2026-11-24

First public version.

### Tools
- `magento_guest_checkout`: product → cart → standard Magento checkout as a guest → shipping → payment, optionally Place Order. Reports totals, offered shipping/payment methods, step timings, console errors per step and failed requests. Configurable products via `options`: `"first"` (first in-stock variant) or attribute → value labels such as `{ "Size": "M", "Color": "Blue" }`; values and stock come from GraphQL, the options are chosen on the page (Luma swatches, Hyvä radios, dropdowns), and the cart is checked to hold the chosen variant's SKU. Bundle products and Hyvä Checkout are detected and reported as unsupported.
- `magento_product_check`: price and stock of each product page compared with Magento GraphQL, as a guest. Verdict per product (OK / MISMATCH / UNKNOWN / ERROR) with likely causes (stale full page cache, tax display, indexer, special price); flags zero prices, configurables without in-stock variants, a missing Add to Cart button, and JSON-LD / `product:price` meta that disagree with GraphQL. Works with Luma and Hyvä.
- `magento_cache_check`: full page cache verdict per URL (CACHED / NOT_CACHEABLE / MISS / UNKNOWN / ERROR) for Varnish, Fastly, Cloudflare and the built-in cache, with likely causes.
- `magento_graphql_check`: preset checks (store, catalog, products with zero-price detection, guest cart, GET caching) or a custom query with errors, timing and truncated data.
- `page_health_check`: status, load time and JS errors for a list of pages.
- `browser_run` (code mode, opt-in with `PW_ALLOW_SCRIPTS=true`): one Playwright script per call, with a `magento` helper API (`url`, `health`, `cache`, `graphql`, `graphqlChecks`, `product`, `checkout`, `cart`) that returns plain data.
- Basic browser tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_console_errors`, `browser_reset`.

### Transports
- stdio (default), for a local client or `docker run -i`.
- Streamable HTTP (`MCP_TRANSPORT=http`) on `/mcp`, for a team or a QA box: required bearer token (`MCP_HTTP_TOKEN`), Host/Origin checks against DNS rebinding, one browser context per MCP session (one shared browser process), a session limit, idle expiry and `GET /healthz`. `browser_run` is never available over HTTP: the server refuses to start with `PW_ALLOW_SCRIPTS=true`.

### Claude Code plugin
- `/plugin install playwright-lite-mcp --marketplace mikeKots/playwright-lite-mcp-magento` installs the MCP server (the Docker image over stdio, configured through the plugin options: allowed origins, code mode, a local store hostname, HTTPS errors) and the `magento-qa` skill, a QA playbook for the agent.

### Security
- Origin allowlist (`PW_ALLOWED_ORIGINS`, required), enforced on tool input and on every top-level navigation, including each hop of a server redirect chain.
- Tool arguments are never logged; typed values are not echoed back.

### Tested
- Mage-OS 4.0.0 + Hyvä in developer and production mode, and with the Luma theme (`sample-store/check.sh`).
- In production mode Magento hides `X-Magento-Cache-Control`: `magento_cache_check` then infers that cart/checkout/customer pages are uncacheable by design, explains that the reason for other MISS pages is hidden, and no longer shows the proxy-rewritten `Cache-Control`.
- On Luma, option inputs of configurable products are rendered after page load: `magento_guest_checkout` still fails fast with the "product has options" explanation.

### Distribution
- Docker image with Node and Chromium's headless shell only (~1.2 GB); `PW_IGNORE_HTTPS_ERRORS` for local dev stores.
- GitHub Actions: CI (typecheck, tests, build, Docker build, the image started over stdio and HTTP) and Release (GHCR image for amd64/arm64, GitHub release, optional npm publish).
- `sample-store/`: Mage-OS + Hyvä demo store on Warden, an end-to-end MCP smoke test (stdio, HTTP, Docker) and a token benchmark against `@playwright/mcp`.
