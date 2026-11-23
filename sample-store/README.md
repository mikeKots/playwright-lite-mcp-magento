# Demo store: Mage-OS + Hyvä on Warden

A local Magento store for testing `playwright-lite-mcp`: **https://app.hyva-demo.test**.

- **Mage-OS**: a public distribution of Magento Open Source (`repo.mage-os.org`). No `repo.magento.com` keys needed.
- **Hyvä** (open source since November 2025, OSL-3.0/AFL-3.0): packages come straight from `github.com/hyva-themes`, no Hyvä Packagist key needed.
- Sample data (the Luma catalog), Varnish full page cache, Redis, OpenSearch. Checkout runs through `hyva-themes/magento2-luma-checkout` (Luma fallback), because Hyvä Checkout is a paid product.

## Requirements

- Docker Desktop running
- Warden: `brew install wardenenv/warden/warden`, then `warden svc up` once
- ~10 GB of disk, 20–40 min for the first install (longer on a slow connection: the Docker images alone are ~1.4 GB)

## Install

```bash
~/Documents/playwright-lite-mcp/sample-store/setup.sh            # store goes to ~/Documents/hyva-demo
```

Options via env: `ENV_NAME` (default `hyva-demo` → domain `app.hyva-demo.test`),
`MAGEOS_VERSION` (`4.0.0`), `SAMPLE_DATA=0` (no catalog), `ADMIN_USER`, `ADMIN_PASS`.

The script can be re-run after a failure: each step checks whether it already ran.

What the script does:
1. `warden env-init hyva-demo magento2`, disables RabbitMQ, `warden sign-certificate hyva-demo.test`, `warden env up`
2. `composer create-project` Mage-OS
3. adds the Hyvä VCS repositories, `composer require hyva-themes/magento2-default-theme hyva-themes/magento2-luma-checkout`
4. `sampledata:deploy`, `setup:install` (DB, OpenSearch, Redis, Varnish)
5. disables 2FA, developer mode, Varnish as FPC, theme `Hyva/default`, reindex

Admin: https://app.hyva-demo.test/backend — `admin` / `Admin123!demo`.

## Check

```bash
npm run build                                  # mcp-smoke.mjs needs dist/
sample-store/check.sh                          # or: check.sh https://another-store.test
EXPECT_THEME=Magento/luma sample-store/check.sh   # store running Luma; EXPECT_THEME=any skips the theme check
```

To try the tools on Luma, switch the demo store's theme (ids: `SELECT theme_id, theme_path FROM theme`):

```bash
cd ~/Documents/hyva-demo
warden env exec php-fpm bin/magento config:set design/theme/theme_id 4    # Magento/luma (5 = Hyva/default)
warden env exec php-fpm bin/magento cache:flush
```

`check.sh` checks the store with curl (home page 200, Hyvä active, search finds products,
GraphQL, Varnish `HIT` — Warden's VCL reports it as `X-Cache`, the stock Magento VCL as
`X-Magento-Cache-Debug` — and the cart). Then `mcp-smoke.mjs` starts `dist/index.js` the same
way Claude Code does (stdio, JSON-RPC) and calls `page_health_check`, `browser_run` (code mode),
`magento_cache_check` (3 pages must be HIT, the cart not cacheable), `magento_graphql_check`
(all 5 presets), `magento_product_check` (4 product types: page price and stock match GraphQL) and `magento_guest_checkout`. The checkout stops before Place Order, so the check does not create orders.

The same checks against the Docker image (as Claude Code would start it):

```bash
docker build -t playwright-lite-mcp .
node sample-store/mcp-smoke.mjs https://app.hyva-demo.test --docker playwright-lite-mcp
```

Token benchmark against the official `@playwright/mcp` (needs Google Chrome; the official server is fetched with npx):

```bash
node sample-store/benchmark.mjs
```

Connect to Claude Code (code mode on for all projects, scope `user`):

```bash
claude mcp remove playwright-lite -s user
claude mcp add -s user playwright-lite \
  -e PW_ALLOWED_ORIGINS="https://app.hyva-demo.test" \
  -e PW_HEADLESS=false \
  -e PW_ALLOW_SCRIPTS=true \
  -- node /absolute/path/to/playwright-lite-mcp/dist/index.js
```

Restart Claude Code → `/mcp` → `playwright-lite: connected`. Example prompts:
- "Run `magento_guest_checkout` for https://app.hyva-demo.test/joust-duffle-bag.html with tablerate shipping and tell me the order total"
- "Run `magento_cache_check` on the home page, a category and a product page of https://app.hyva-demo.test"
- "Run `magento_graphql_check` on https://app.hyva-demo.test and tell me what fails"
- "Run `magento_product_check` on https://app.hyva-demo.test/joust-duffle-bag.html and https://app.hyva-demo.test/breathe-easy-tank.html"
- "Using `browser_run`, add the first product from https://app.hyva-demo.test/gear/bags.html to the cart and return the subtotal"

Simple products in the sample data for checkout: `joust-duffle-bag.html`, `strive-shoulder-pack.html`, `crown-summit-backpack.html`. Configurable (pass `options`): `breathe-easy-tank.html` (Color: Purple/White/Yellow, Size: XS–XL).

## Manage

```bash
cd ~/Documents/hyva-demo
warden env stop        # stop (data is kept)
warden env start
warden shell           # bin/magento, composer
warden env down -v     # remove completely, including the database
```

## Troubleshooting

- **`curl: (60) SSL certificate problem`**: `warden sign-certificate hyva-demo.test`, then `warden svc restart`.
- **Pages without Hyvä styles**: `bin/magento config:show design/theme/theme_id` must point to `Hyva/default`; `bin/magento cache:flush`.
- **Empty search**: `bin/magento indexer:reindex`; check `warden env logs opensearch`.
- **GitHub rate limit during composer**: `composer config -g github-oauth.github.com <token>`.
