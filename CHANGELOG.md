# Changelog

All notable changes to this project. Versions follow [semantic versioning](https://semver.org).

## [0.1.0] - unreleased

First public version.

### Tools
- `magento_guest_checkout`: product → cart → standard Magento checkout as a guest → shipping → payment, optionally Place Order. Reports totals, offered shipping/payment methods, step timings, console errors per step and failed requests. Fails fast on products with options; detects Hyvä Checkout as unsupported.
- `magento_cache_check`: full page cache verdict per URL (CACHED / NOT_CACHEABLE / MISS / UNKNOWN / ERROR) for Varnish, Fastly, Cloudflare and the built-in cache, with likely causes.
- `magento_graphql_check`: preset checks (store, catalog, products with zero-price detection, guest cart, GET caching) or a custom query with errors, timing and truncated data.
- `page_health_check`: status, load time and JS errors for a list of pages.
- `browser_run` (code mode, opt-in with `PW_ALLOW_SCRIPTS=true`): one Playwright script per call, with a `magento` helper API (`url`, `health`, `cache`, `graphql`, `graphqlChecks`, `checkout`, `cart`) that returns plain data.
- Basic browser tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_console_errors`, `browser_reset`.

### Security
- Origin allowlist (`PW_ALLOWED_ORIGINS`, required), enforced on tool input and on every top-level navigation, including each hop of a server redirect chain.
- Tool arguments are never logged; typed values are not echoed back.

### Tested
- Mage-OS 4.0.0 + Hyvä in developer and production mode, and with the Luma theme (`sample-store/check.sh`).
- In production mode Magento hides `X-Magento-Cache-Control`: `magento_cache_check` then infers that cart/checkout/customer pages are uncacheable by design, explains that the reason for other MISS pages is hidden, and no longer shows the proxy-rewritten `Cache-Control`.
- On Luma, option inputs of configurable products are rendered after page load: `magento_guest_checkout` still fails fast with the "product has options" explanation.

### Distribution
- Docker image with Node and Chromium's headless shell only (~1.2 GB); `PW_IGNORE_HTTPS_ERRORS` for local dev stores.
- GitHub Actions: CI (typecheck, tests, build, Docker build) and Release (GHCR image for amd64/arm64, GitHub release, optional npm publish).
- `sample-store/`: Mage-OS + Hyvä demo store on Warden, an end-to-end MCP smoke test and a token benchmark against `@playwright/mcp`.
