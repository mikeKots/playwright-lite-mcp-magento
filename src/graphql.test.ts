import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

// magento_graphql_check against a fake Magento GraphQL endpoint that answers by query shape.

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: unknown) => Promise<Result>;

const api = {
  zeroPrice: false,
  broken: false,
  gets: [] as Array<{ query: string; variables?: string }>,
  storeHeaders: [] as Array<string | undefined>,
  cacheHits: 0,
};

const product = (sku: string, type: string, price = 34) => ({
  __typename: type,
  sku,
  name: sku,
  stock_status: 'IN_STOCK',
  price_range: { minimum_price: { final_price: { value: price, currency: 'USD' } } },
});

function answer(query: string, variables: Record<string, unknown>, req: IncomingMessage) {
  if (query.includes('storeConfig')) {
    api.storeHeaders.push(req.headers['store'] as string | undefined);
    const code = (req.headers['store'] as string | undefined) ?? 'default';
    return { data: { storeConfig: { store_code: code, store_name: 'Fake Store', base_currency_code: 'USD', locale: 'en_US', root_category_uid: 'Mg==' } } };
  }
  if (query.includes('categoryList')) {
    return { data: { categoryList: [{ name: 'Default Category', children: [{ name: 'Gear', product_count: 34 }, { name: 'Men', product_count: 0 }] }] } };
  }
  if (query.includes('currentPage')) {
    // SKU scan: page 1 has only configurables, page 2 the first simple product.
    const page = variables['page'] as number;
    const items =
      page === 1
        ? Array.from({ length: 100 }, (_, i) => ({ __typename: 'ConfigurableProduct', sku: `CONF-${i}`, stock_status: 'IN_STOCK' }))
        : [{ __typename: 'SimpleProduct', sku: '24-MB01', stock_status: 'IN_STOCK' }];
    return { data: { products: { total_count: 101, items } } };
  }
  if (query.includes('products(filter')) {
    return {
      data: {
        products: {
          total_count: 181,
          items: [product('MH01', 'ConfigurableProduct', 52), product('MH02', 'ConfigurableProduct', api.zeroPrice ? 0 : 70)],
        },
      },
    };
  }
  if (query.includes('nope')) {
    return { errors: [{ message: 'Cannot query field "nope" on type "ProductInterface".', extensions: { category: 'graphql-input' }, path: ['products', 'items'] }] };
  }
  if (query.includes('createEmptyCart')) return { data: { createEmptyCart: 'cart123' } };
  if (query.includes('addProductsToCart')) {
    if (variables['sku'] === 'MH01') {
      return { data: { addProductsToCart: { cart: { total_quantity: 0, prices: null }, user_errors: [{ code: 'REQUIRED_PARAMETER_MISSING', message: 'You need to choose options for your item.' }] } } };
    }
    const total = { value: 34, currency: 'USD' };
    return { data: { addProductsToCart: { cart: { total_quantity: 1, prices: { subtotal_excluding_tax: total, grand_total: total } }, user_errors: [] } } };
  }
  if (query.includes('bigList')) return { data: { bigList: 'x'.repeat(5000) } };
  return { data: { echo: variables } };
}

function startApi(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/graphql') return res.writeHead(404).end();
    if (api.broken) return res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>There has been an error processing your request</h1>');
    const reply = (query: string, variables: Record<string, unknown>, headers: Record<string, string> = {}) =>
      res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(answer(query, variables, req)));
    if (req.method === 'GET') {
      const query = url.searchParams.get('query') ?? '';
      const variables = url.searchParams.get('variables') ?? undefined;
      api.gets.push({ query, variables });
      // Like Varnish in front of Magento: GET queries are cached, the repeat is a HIT.
      const hit = api.cacheHits++ > 0;
      return reply(query, variables ? JSON.parse(variables) : {}, {
        'x-magento-cache-debug': hit ? 'HIT' : 'MISS',
        'x-magento-cache-id': 'abc',
      });
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
      reply(json.query, json.variables ?? {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let site: Server;
let origin: string;
let browser: BrowserSession;
let call: (args: unknown) => Promise<Result & { text: string }>;

beforeAll(async () => {
  site = await startApi();
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const cfg = loadConfig({ PW_ALLOWED_ORIGINS: origin, LOG_LEVEL: 'error' });
  browser = new BrowserSession(cfg, createLogger(cfg.LOG_LEVEL));
  const tools = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  registerTools(fakeServer, { cfg, log: createLogger(cfg.LOG_LEVEL), browser, mutex: new Mutex() });
  call = async (args) => {
    const result = await tools.get('magento_graphql_check')!(args);
    return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
  };
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => site.close(r));
});
beforeEach(() => {
  Object.assign(api, { zeroPrice: false, broken: false, gets: [], storeHeaders: [], cacheHits: 0 });
});

describe('magento_graphql_check', () => {
  it('runs all presets with one line each, from any store URL', async () => {
    const r = await call({ storeUrl: `${origin}/gear/bags.html` });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(`GraphQL: ${origin}/graphql`);
    expect(r.text).toMatch(/OK {3}store \d+ms \| default "Fake Store", USD, en_US/);
    expect(r.text).toContain('2 top-level categories: Gear (34), Men (0)');
    expect(r.text).toContain('181 products; first 2: 2 Configurable');
    // No simple product in the listing: the cart check pages through SKUs and finds one on page 2.
    expect(r.text).toContain('guest cart + 24-MB01 ×1 → qty 1, subtotal 34.00 USD');
    expect(r.text).toMatch(/GET storeConfig: MISS \d+ms → HIT \d+ms via X-Magento-Cache-Debug, X-Magento-Cache-Id present/);
    expect(r.text).toContain('Summary: 5/5 OK');
  });

  it('flags products with a zero price', async () => {
    api.zeroPrice = true;
    const r = await call({ storeUrl: origin, checks: ['products'] });
    expect(r.text).toMatch(/FAIL products .*ZERO PRICE: MH02/);
    expect(r.text).toContain('Summary: 0/1 OK');
  });

  it('reports cart user_errors such as a configurable SKU', async () => {
    const r = await call({ storeUrl: origin, checks: ['cart'], sku: 'MH01' });
    expect(r.text).toContain('FAIL cart');
    expect(r.text).toContain('REQUIRED_PARAMETER_MISSING: You need to choose options for your item.');
  });

  it('returns GraphQL errors of a custom query with category and path', async () => {
    const r = await call({ storeUrl: origin, query: '{ products(search: "bag") { items { sku nope } } }' });
    expect(r.text).toContain('FAIL POST HTTP 200');
    expect(r.text).toContain('Cannot query field "nope" on type "ProductInterface". [graphql-input at products.items]');
  });

  it('sends a custom GET query with variables and shows the cache status, truncating big data', async () => {
    const r = await call({
      storeUrl: `${origin}/graphql`,
      query: 'query ($n: Int) { bigList }',
      variables: { n: 1 },
      method: 'GET',
      maxChars: 100,
    });
    expect(api.gets[0]).toEqual({ query: 'query ($n: Int) { bigList }', variables: '{"n":1}' });
    expect(r.text).toContain('OK   GET HTTP 200');
    expect(r.text).toContain('cache MISS via X-Magento-Cache-Debug');
    expect(r.text).toMatch(/Data \(\d+ chars, truncated/);
    expect(r.text.length).toBeLessThan(600);
  });

  it('passes the store view code as the Store header', async () => {
    const r = await call({ storeUrl: origin, checks: ['store'], storeCode: 'de' });
    expect(api.storeHeaders).toEqual(['de']);
    expect(r.text).toContain('(store: de)');
    expect(r.text).toContain('| de "Fake Store"');
  });

  it('describes a non-JSON error page instead of crashing', async () => {
    api.broken = true;
    const r = await call({ storeUrl: origin, checks: ['store'] });
    expect(r.text).toContain('FAIL store');
    expect(r.text).toContain('HTTP 500, not JSON: <h1>There has been an error processing your request</h1>');
  });

  it('refuses a store URL outside the allowlist', async () => {
    const r = await call({ storeUrl: 'https://evil.example/graphql' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not in PW_ALLOWED_ORIGINS');
  });
});
