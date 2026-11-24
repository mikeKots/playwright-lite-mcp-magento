#!/usr/bin/env node
// End-to-end smoke test: starts dist/index.js over stdio (like Claude Code does), speaks raw
// MCP JSON-RPC, runs page_health_check, browser_run (code mode), magento_cache_check,
// magento_graphql_check, magento_product_check and magento_guest_checkout against the sample store.
// With --http the server runs the Streamable HTTP transport: browser_run must then be absent.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startMcpHttpServer, startMcpServer } from './mcp-client.mjs';

// Usage: node sample-store/mcp-smoke.mjs [base-url] [--docker <image>] [--http]
const args = process.argv.slice(2);
const dockerAt = args.indexOf('--docker');
const image = dockerAt >= 0 ? args.splice(dockerAt, 2)[1] : undefined;
const httpAt = args.indexOf('--http');
const http = httpAt >= 0 && args.splice(httpAt, 1).length > 0;
const base = (args[0] ?? 'https://app.hyva-demo.test').replace(/\/$/, '');
const origin = new URL(base).origin;
const port = 8941;
const token = randomBytes(24).toString('hex');
const env = http
  ? { PW_ALLOWED_ORIGINS: origin, PW_HEADLESS: 'true', MCP_TRANSPORT: 'http', MCP_HTTP_PORT: String(port), MCP_HTTP_TOKEN: token }
  : { PW_ALLOWED_ORIGINS: origin, PW_HEADLESS: 'true', PW_ALLOW_SCRIPTS: 'true' };

// Same server either way: local dist/, or the Docker image as Claude Code would start it.
// Inside Docker a local .test domain needs --add-host, and the dev CA is not trusted there.
const [command, commandArgs] = image
  ? [
      'docker',
      [
        'run', ...(http ? ['-p', `${port}:${port}`] : ['-i']), '--rm', '--init',
        '--add-host', `${new URL(base).hostname}:host-gateway`,
        ...Object.entries({ ...env, PW_IGNORE_HTTPS_ERRORS: 'true', ...(http ? { MCP_HTTP_HOST: '0.0.0.0' } : {}) })
          .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        image,
      ],
    ]
  : [process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))]];

const server = http
  ? await startMcpHttpServer(command, commandArgs, { env, port, token })
  : await startMcpServer(command, commandArgs, { env });
const call = (name, toolArgs) => server.call(name, toolArgs);

let failed = 0;
const report = (label, { ok, text }) => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}\n${text.replace(/^/gm, '     ')}`);
};

try {
  const tools = await server.listTools();
  const names = tools.map((t) => t.name);
  // Code mode is stdio-only: over HTTP the tool must not exist at all.
  const toolsOk = names.includes('browser_run') !== http;
  if (!toolsOk) failed++;
  console.log(`${toolsOk ? 'OK  ' : 'FAIL'} tools${http ? ' (HTTP, no browser_run)' : ''}: ${names.join(', ')}`);

  const health = await call('page_health_check', {
    urls: [`${base}/`, `${base}/gear.html`, `${base}/catalogsearch/result/?q=bag`, `${base}/checkout/cart/`],
  });
  // JS errors on a page count as FAIL in page_health_check; the summary line says how many passed.
  report('page_health_check', { ok: health.ok && /^(\d+)\/\1 passed/.test(health.text), text: health.text });

  if (!http) {
    const script = await call('browser_run', {
      code: `
        await page.goto('${base}/gear/bags.html');
        const names = await page.locator('.product-item-link, .product-item a.product-item-photo + * a, form.item.product a[href$=".html"]')
          .allInnerTexts();
        const products = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
        return { title: await page.title(), products: products.slice(0, 5), count: products.length };
      `,
    });
    report('browser_run (code mode)', { ok: script.ok && /"count":\s*[1-9]/.test(script.text), text: script.text });
  }

  // Varnish runs in front of the demo store: cacheable pages must end as HIT, the cart must not be cached.
  const cache = await call('magento_cache_check', {
    urls: [`${base}/`, `${base}/gear.html`, `${base}/joust-duffle-bag.html`, `${base}/checkout/cart/`],
  });
  report('magento_cache_check', {
    ok: cache.ok && /Summary: 3\/4 cached, 1 not cacheable/.test(cache.text),
    text: cache.text,
  });

  const graphql = await call('magento_graphql_check', { storeUrl: base });
  report('magento_graphql_check', { ok: graphql.ok && /Summary: 5\/5 OK/.test(graphql.text), text: graphql.text });

  // Price and stock on the page must match GraphQL: simple, configurable, bundle and grouped products.
  const product = await call('magento_product_check', {
    urls: ['joust-duffle-bag', 'breathe-easy-tank', 'sprite-yoga-companion-kit', 'set-of-sprite-yoga-straps'].map((p) => `${base}/${p}.html`),
  });
  report('magento_product_check', { ok: product.ok && /^4\/4 OK/.test(product.text), text: product.text });

  // Code mode with the magento helpers: GraphQL → cache check of every Gear category → two guest
  // checkouts, all in one call; only the small summary comes back.
  if (!http) {
    const codeMode = await call('browser_run', {
      timeoutMs: 120000,
      code: `
        await page.goto('${base}/');
        const cats = await magento.graphql('{ categoryList(filters: { url_path: { in: ["gear", "gear/bags", "gear/fitness-equipment", "gear/watches"] } }) { url_path } }');
        const cache = await magento.cache(cats.data.categoryList.map((c) => magento.url('/' + c.url_path + '.html')));
        const products = await magento.graphql('{ products(filter: { sku: { in: ["24-MB01", "24-WB01"] } }) { items { sku url_key url_suffix } } }');
        const checkouts = [];
        for (const p of products.data.products.items) {
          const r = await magento.checkout({ productUrl: magento.url('/' + p.url_key + p.url_suffix) });
          checkouts.push({ sku: p.sku, ok: r.ok, total: r.totals.find(([k]) => k === 'Order Total')?.[1], errors: r.consoleErrors.length + r.failedRequests.length });
        }
        return {
          cache: cache.map((c) => c.verdict + ' ' + new URL(c.url).pathname),
          checkouts,
          pageStillOn: page.url(),
        };
      `,
    });
    report('browser_run + magento helpers', {
      ok: codeMode.ok && !/"ok": false/.test(codeMode.text) && /"CACHED/.test(codeMode.text),
      text: codeMode.text,
    });
  }

  // Stops on the payment step (no placeOrder), so running the check does not create orders.
  const checkout = await call('magento_guest_checkout', { productUrl: `${base}/joust-duffle-bag.html` });
  report('magento_guest_checkout', { ok: checkout.ok && /Order Total/.test(checkout.text), text: checkout.text });

  // Configurable product: options picked on the page, the variant in the cart is verified by SKU.
  const configurable = await call('magento_guest_checkout', {
    productUrl: `${base}/breathe-easy-tank.html`,
    options: { Size: 'M', Color: 'Yellow' },
  });
  report('magento_guest_checkout (configurable)', {
    ok: configurable.ok && /WT09-M-Yellow/.test(configurable.text) && /Order Total/.test(configurable.text),
    text: configurable.text,
  });
} catch (err) {
  failed++;
  console.log(`FAIL ${err.message}`);
} finally {
  server.close();
}
process.exit(failed > 0 ? 1 : 0);
