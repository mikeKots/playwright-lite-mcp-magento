---
name: magento-qa
description: QA checks of a Magento 2 / Adobe Commerce / Mage-OS storefront with the playwright-lite MCP tools. Use when asked to test or smoke-test a Magento store, check a guest checkout, the full page cache (Varnish, Fastly), product prices or stock, GraphQL, or page errors, or to investigate a storefront bug on Luma or Hyvä.
---

# Magento QA with playwright-lite

The playwright-lite MCP server turns common Magento checks into one tool call each and returns a short verdict
instead of page snapshots. Use the domain tools first; fall back to the generic `browser_*` tools only for what they
do not cover.

## Pick the tool by the question

| Question | Tool |
|---|---|
| Do these pages load, with which status, how fast, any JS errors? | `page_health_check` (list of URLs) |
| Can a guest buy this product? What are the totals, shipping and payment methods? | `magento_guest_checkout` |
| Is this page served from the full page cache? If not, why? | `magento_cache_check` |
| Does the price / old price / stock on the page match the catalog? | `magento_product_check` |
| Does the GraphQL API work (store, catalog, products, cart, GET caching)? | `magento_graphql_check` (presets, or your own `query`) |
| Several of the above over many pages, loops, conditions, aggregation | `browser_run` (code mode), see below |
| Something no tool covers (a custom widget, a form, a layout question) | `browser_navigate` → `browser_snapshot` → `browser_click` / `browser_fill` |

Pass every URL of the same check in one call (`urls` takes up to 20) instead of one call per URL.

## Code mode first for multi-page work

If `browser_run` is available (the server runs with `PW_ALLOW_SCRIPTS=true`), use it whenever a task needs more
than two or three calls: one script, one call, only its return value comes back. Inside the script `page` and the
`magento` helpers are in scope: `magento.url`, `health`, `cache`, `graphql`, `graphqlChecks`, `product`, `checkout`,
`cart`. They return plain data, so filter in the script and return only the problems:

```js
await page.goto('https://shop.example.com/');
const cats = await magento.graphql('{ categoryList { children { url_path } } }');
const urls = cats.data.categoryList[0].children.map((c) => magento.url('/' + c.url_path + '.html'));
const cache = await magento.cache(urls);
return cache.filter((c) => c.verdict !== 'CACHED').map((c) => `${c.verdict} ${c.url}: ${c.notes.join('; ')}`);
```

A guest checkout takes 5–10 s: pass a larger `timeoutMs` when a script runs several. If `browser_run` is not listed,
code mode is off: use the domain tools and do not ask the user to enable it unless the task really needs it.

## Read the verdicts

- `magento_guest_checkout`: `OK` or `FAILED at <step>` (`add_to_cart`, `checkout_load`, `shipping_address`,
  `shipping_method`, `payment`, `place_order`) with the reason. Console errors are tagged with their step, and the
  store's own 4xx/5xx responses are listed: those are usually the real bug. After a failure the page stays at that
  step, so `browser_snapshot` shows what the customer sees. A product with options needs `options: "first"` or e.g.
  `{ "Size": "M" }`.
- `magento_cache_check`: `CACHED`; `NOT_CACHEABLE` (expected for cart, checkout and customer pages, otherwise look
  for a `cacheable="false"` block in the layout); `MISS` (cacheable but not served from cache: check the listed
  `Set-Cookie` and query strings); `UNKNOWN` (no cache headers, often production mode); `ERROR`.
- `magento_product_check`: `OK`, `MISMATCH` (lines starting with `-` are the problems; the hint says whether it
  looks like a stale full page cache, a tax display setting or an indexer / price rule issue), `UNKNOWN` (the theme
  markup was not recognized: verify on the page, do not call it a bug), `ERROR`. Lines starting with `·` are warnings
  (JSON-LD, meta tags) and do not change the verdict.
- `magento_graphql_check`: one `OK` / `FAIL` line per preset. The `cart` preset leaves an abandoned guest cart,
  which is harmless.

A problem the tool reports is a finding about the store, not about the tool: report it, with the evidence line.

## Safety rules

- **Never place an order on production.** `placeOrder` stays `false` (the default) unless the user explicitly asks
  for a real order on a dev or staging store. Stopping before Place Order already tests the whole checkout.
- Only allowlisted origins (`PW_ALLOWED_ORIGINS`) can be opened. If a URL is refused, tell the user which origin to
  add; do not try to work around it.
- Do not run `browser_run` scripts that read files, environment variables or the network outside the store: the
  script runs in the server process.

## Report briefly

Lead with the verdict per check (for example "3/4 pages cached; checkout OK, total $39.00"), then only the problems,
each with its evidence line from the tool output and a likely cause. Do not paste full tool output or list what
passed in detail unless asked.

## Known limits

- Hyvä Checkout (Magewire) and other one-step checkouts are not supported by `magento_guest_checkout`; the standard
  `Magento_Checkout` is (Luma, and Hyvä with the Luma checkout fallback).
- Bundle products cannot be added to the cart by `magento_guest_checkout`: script them with `browser_run`.
