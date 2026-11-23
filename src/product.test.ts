import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Mutex } from './mutex.js';
import { compareProduct, parsePrice, parseStructured, type ApiProduct, type PageProduct } from './product.js';
import { registerTools } from './tools.js';

describe('parsePrice', () => {
  it.each([
    ['$34.00', 34],
    ['$1,234.56', 1234.56],
    ['1.234,56 €', 1234.56],
    ['34,00 €', 34],
    ['As low as $45.00', 45],
    ['CHF 1\'234.50', 1234.5],
    ['1 234,50 zł', 1234.5],
    ['¥1,234', 1234],
    ['12.345.678', 12345678],
    ['Free', undefined],
    [undefined, undefined],
  ])('%s → %s', (text, expected) => {
    expect(parsePrice(text)).toBe(expected);
  });
});

describe('parseStructured', () => {
  it('reads Product offers, ProductGroup variants and the price meta', () => {
    const product = { '@type': 'Product', offers: { '@type': 'Offer', price: '34.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
    const group = {
      '@type': 'ProductGroup',
      hasVariant: [
        { '@type': 'Product', offers: { price: 40, priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' } },
        { '@type': 'Product', offers: { price: 36, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } },
      ],
    };
    const out = parseStructured([JSON.stringify([{ '@type': 'BreadcrumbList' }, product]), JSON.stringify({ '@graph': [group] }), '{broken'], '34.00', 'USD');
    expect(out).toEqual([
      { source: 'JSON-LD Product', price: 34, currency: 'USD', inStock: true },
      { source: 'JSON-LD ProductGroup', price: 36, currency: 'USD', inStock: true },
      { source: 'meta product:price:amount', price: 34, currency: 'USD' },
    ]);
  });

  it('reads AggregateOffer lowPrice', () => {
    const out = parseStructured([JSON.stringify({ '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 61, highPrice: 77, priceCurrency: 'EUR' } })]);
    expect(out).toEqual([{ source: 'JSON-LD Product', price: 61, currency: 'EUR', inStock: undefined }]);
  });
});

describe('compareProduct', () => {
  const usd = (value: number) => ({ value, currency: 'USD' });
  const api = (over: Partial<ApiProduct> = {}): ApiProduct => ({
    type: 'simple',
    sku: 'S1',
    name: 'Bag',
    stockStatus: 'IN_STOCK',
    minFinal: usd(34),
    minRegular: usd(34),
    maxFinal: usd(34),
    ...over,
  });
  const shown = (over: Partial<PageProduct> = {}): PageProduct => ({
    status: 200,
    finalPrice: 34,
    stock: 'IN_STOCK',
    stockText: 'In stock',
    addToCart: true,
    structured: [],
    ...over,
  });

  it('OK when price and stock agree', () => {
    const r = compareProduct('u', api(), shown());
    expect(r.verdict).toBe('OK');
    expect(r.problems).toEqual([]);
  });

  it('hints at tax when the page price is the GraphQL price plus a tax-like ratio', () => {
    const r = compareProduct('u', api(), shown({ finalPrice: 40.8 }));
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems[0]).toMatch(/page 40\.80 ≠ GraphQL final 34\.00 USD.*looks like tax/);
  });

  it('checks the old price of a special price', () => {
    expect(compareProduct('u', api({ minFinal: usd(30), maxFinal: usd(30) }), shown({ finalPrice: 30, oldPrice: 34 })).verdict).toBe('OK');
    const wrongOld = compareProduct('u', api({ minFinal: usd(30), maxFinal: usd(30) }), shown({ finalPrice: 30, oldPrice: 36 }));
    expect(wrongOld.problems).toEqual([expect.stringMatching(/old price: page 36\.00 ≠ GraphQL regular 34\.00/)]);
    const noOld = compareProduct('u', api({ minFinal: usd(30), maxFinal: usd(30) }), shown({ finalPrice: 30 }));
    expect(noOld.verdict).toBe('OK');
    expect(noOld.notes[0]).toMatch(/shows no old price/);
    const expired = compareProduct('u', api(), shown({ oldPrice: 40 }));
    expect(expired.problems[0]).toMatch(/GraphQL has no discount/);
  });

  it('flags zero prices, missing Add to Cart and configurables without stock', () => {
    const r = compareProduct(
      'u',
      api({ type: 'configurable', minFinal: usd(0), minRegular: usd(0), maxFinal: usd(0), variants: { inStock: 0, total: 4 } }),
      shown({ finalPrice: 0, addToCart: false }),
    );
    expect(r.problems).toEqual([
      expect.stringMatching(/ZERO PRICE/),
      'in stock in GraphQL, but the page has no Add to Cart button',
      'parent IN_STOCK, but all 4 variants are out of stock',
    ]);
  });

  it('UNKNOWN when the page price is not found; structured data only warns', () => {
    const r = compareProduct('u', api(), shown({ finalPrice: undefined, structured: [{ source: 'meta product:price:amount', price: 30 }] }));
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.notes).toEqual([expect.stringMatching(/price not found/), 'WARNING meta product:price:amount price 30.00 ≠ GraphQL 34.00 USD']);
  });
});

// magento_product_check end to end against a fake store: GraphQL `route` plus product pages in
// Luma markup (data-price-amount) and Hyvä markup (price text rendered by script after load).

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: unknown) => Promise<Result>;

const store = { lumaPrice: 34, hyvaStock: 'IN_STOCK' };

const gqlProduct = (sku: string, price: number, stock: string, typename = 'SimpleProduct') => ({
  __typename: typename,
  sku,
  name: sku,
  stock_status: stock,
  only_x_left_in_stock: null,
  price_range: {
    minimum_price: { regular_price: { value: price, currency: 'USD' }, final_price: { value: price, currency: 'USD' } },
    maximum_price: { final_price: { value: price, currency: 'USD' } },
  },
});

const LUMA = `<title>Luma bag</title><div class="product-info-main">
  <div class="price-box price-final_price"><span class="price-container">
    <span data-price-amount="34" data-price-type="finalPrice" class="price-wrapper"><span class="price">$34.00</span></span>
  </span></div>
  <div class="stock available"><span>In stock</span></div>
  <form id="product_addtocart_form"><button type="submit" id="product-addtocart-button">Add to Cart</button></form>
</div>
<script type="application/ld+json">{"@type":"Product","offers":{"price":"34.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
<div class="block related"><div class="product-item"><div class="price-box"><span data-price-amount="99" data-price-type="finalPrice"><span class="price">$99.00</span></span></div></div></div>`;

const HYVA = `<title>Hyvä tank</title><section class="product-info-main">
  <div class="price-box price-final_price"><div class="final-price"><span class="price"></span></div></div>
  <p class="stock available" title="Availability"><span>In stock</span></p>
  <form id="product_addtocart_form"><button type="submit">Add to Cart</button></form>
  <div class="product-item"><div class="price-box"><div class="final-price"><span class="price">$12.00</span></div></div></div>
</section>
<script>setTimeout(() => { document.querySelector('.final-price .price').textContent = '1.234,50 €'; }, 150)</script>`;

function startStore(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/graphql') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { variables } = JSON.parse(body) as { variables: Record<string, string> };
        const route =
          variables['url'] === 'luma-bag.html'
            ? gqlProduct('LUMA-1', store.lumaPrice, 'IN_STOCK')
            : variables['url'] === 'hyva-tank.html'
              ? { ...gqlProduct('HYVA-1', 1234.5, store.hyvaStock, 'ConfigurableProduct'), variants: [{ product: { stock_status: 'IN_STOCK' } }] }
              : variables['url'] === 'gear.html'
                ? { __typename: 'CategoryTree' }
                : null;
        const data = variables['key'] !== undefined ? { products: { items: [] } } : { route };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      });
      return;
    }
    const pages: Record<string, [string, Record<string, string>]> = {
      '/luma-bag.html': [LUMA, { 'x-magento-cache-debug': 'HIT' }],
      '/hyva-tank.html': [HYVA, {}],
    };
    const page = pages[url.pathname];
    if (!page) return res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>404</h1>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...page[1] }).end(page[0]);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let site: Server;
let origin: string;
let browser: BrowserSession;
let tools: Map<string, Handler>;
const call = async (name: string, args: unknown) => {
  const result = await tools.get(name)!(args);
  return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
};

beforeAll(async () => {
  site = await startStore();
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const cfg = loadConfig({ PW_ALLOWED_ORIGINS: origin, LOG_LEVEL: 'error', PW_NAV_TIMEOUT_MS: '5000', PW_ALLOW_SCRIPTS: 'true' });
  browser = new BrowserSession(cfg, createLogger(cfg.LOG_LEVEL));
  tools = new Map();
  const fakeServer = { registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler) } as unknown as McpServer;
  registerTools(fakeServer, { cfg, log: createLogger(cfg.LOG_LEVEL), browser, mutex: new Mutex() });
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => site.close(r));
});
beforeEach(() => {
  store.lumaPrice = 34;
  store.hyvaStock = 'IN_STOCK';
});

describe('magento_product_check', () => {
  it('reads Luma and Hyvä product pages, ignoring related product prices', async () => {
    const r = await call('magento_product_check', { urls: [`${origin}/luma-bag.html`, `${origin}/hyva-tank.html`] });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('2/2 OK');
    expect(r.text).toContain('OK       LUMA-1 "LUMA-1" (simple)');
    expect(r.text).toContain('price page 34.00 / GraphQL 34.00 USD | stock page "In stock" / GraphQL IN_STOCK | page cache HIT via X-Magento-Cache-Debug');
    expect(r.text).toContain('price page 1234.50 / GraphQL 1234.50 USD');
    expect(r.text).toContain('(1/1 variants in stock)');
  });

  it('reports a cached page that disagrees with GraphQL as a stale full page cache', async () => {
    store.lumaPrice = 39;
    store.hyvaStock = 'OUT_OF_STOCK';
    const r = await call('magento_product_check', { urls: [`${origin}/luma-bag.html`, `${origin}/hyva-tank.html`] });
    expect(r.text).toContain('0/2 OK, 2 MISMATCH');
    expect(r.text).toContain('- price: page 34.00 ≠ GraphQL final 39.00 USD (page served from cache, HIT via X-Magento-Cache-Debug: stale full page cache?)');
    expect(r.text).toContain('· WARNING JSON-LD Product price 34.00 ≠ GraphQL 39.00 USD');
    expect(r.text).toContain('- stock: page "In stock" ≠ GraphQL OUT_OF_STOCK');
  });

  it('explains URLs that are not products or not allowed', async () => {
    const r = await call('magento_product_check', { urls: [`${origin}/gear.html`, `${origin}/missing.html`] });
    expect(r.text).toContain('0/2 OK, 2 ERROR');
    expect(r.text).toContain('GraphQL: the URL is a CategoryTree, not a product');
    expect(r.text).toContain('GraphQL: no product for this URL (route and url_key)');
    const blocked = await call('magento_product_check', { urls: ['https://evil.example/p.html'] });
    expect(blocked.isError).toBe(true);
  });

  it('is available in browser_run as magento.product()', async () => {
    const r = await call('browser_run', {
      code: `const [p] = await magento.product(['${origin}/luma-bag.html']); return { verdict: p.verdict, sku: p.api.sku, price: p.page.finalPrice };`,
    });
    expect(r.text).toContain('"verdict": "OK"');
    expect(r.text).toContain('"sku": "LUMA-1"');
    expect(r.text).toContain('"price": 34');
  });
});
