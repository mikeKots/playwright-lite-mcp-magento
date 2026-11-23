import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from './browser.js';
import { detectLayer, readCacheStatus } from './cache.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: unknown) => Promise<Result>;

const hits = new Map<string, number>();
const seenCookies: Array<string | undefined> = [];
let otherRequests = 0;

const PUBLIC = 'max-age=86400, public, s-maxage=86400';
const UNCACHEABLE = 'max-age=0, must-revalidate, no-cache, no-store';

function startSite(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const page = (headers: Record<string, string | string[]>) =>
      res.writeHead(200, { 'content-type': 'text/html', ...headers }).end('<title>page</title>');
    switch (path) {
      case '/cached.html': // built-in FPC in developer mode: MISS, then HIT
        return page({ 'x-magento-cache-debug': n === 1 ? 'MISS' : 'HIT', 'x-magento-tags': 'cat_c_3,store,cms_b', 'cache-control': PUBLIC });
      case '/varnish.html': // Varnish: one transaction id on a miss, two on a hit; client sees no-store
        return page({
          'x-varnish': n === 1 ? '100' : `${100 + n} 100`,
          via: '1.1 varnish (Varnish/7.5)',
          'cache-control': UNCACHEABLE,
          'x-magento-tags': 'cat_p_1',
        });
      case '/checkout/cart/':
        return page({ 'cache-control': UNCACHEABLE, pragma: 'no-cache' });
      case '/uncacheable-product.html':
        return page({ 'cache-control': UNCACHEABLE, 'x-magento-tags': 'cat_p_7' });
      case '/miss.html':
        return page({
          'x-magento-cache-debug': 'MISS',
          'x-magento-tags': 'cat_p_9',
          'cache-control': PUBLIC,
          'set-cookie': ['PHPSESSID=abc; Path=/', 'form_key=xyz; Path=/'],
        });
      case '/plain.html':
        return page({});
      case '/leave':
        return res.writeHead(302, { location: `${otherOrigin}/` }).end();
      case '/set-cookie':
        return page({ 'set-cookie': 'X-Magento-Vary=logged-in; Path=/' });
      case '/echo.html':
        seenCookies.push(req.headers.cookie);
        return page({ 'x-magento-cache-debug': 'MISS', 'cache-control': PUBLIC });
      default:
        return res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let site: Server;
let other: Server;
let origin: string;
let otherOrigin: string;
let browser: BrowserSession;
let call: (name: string, args: unknown) => Promise<Result & { text: string }>;

beforeAll(async () => {
  site = await startSite();
  other = createServer((_req, res) => {
    otherRequests++;
    res.end('other');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const cfg = loadConfig({ PW_ALLOWED_ORIGINS: origin, LOG_LEVEL: 'error', PW_COOKIE_WAIT_MS: '0' });
  browser = new BrowserSession(cfg, createLogger(cfg.LOG_LEVEL));
  const tools = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  registerTools(fakeServer, { cfg, log: createLogger(cfg.LOG_LEVEL), browser, mutex: new Mutex() });
  call = async (name, args) => {
    const result = await tools.get(name)!(args);
    return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
  };
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => site.close(r));
  await new Promise((r) => other.close(r));
});
beforeEach(() => {
  hits.clear();
  seenCookies.length = 0;
  otherRequests = 0;
});

const line = (text: string, path: string) => text.split('\n').find((l) => l.includes(`${origin}${path} `) || l.endsWith(`${origin}${path}`)) ?? '';

describe('magento_cache_check', () => {
  it('reports a page that turns from MISS into HIT as cached, with the cache layer', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/cached.html`] });
    expect(r.isError).toBeUndefined();
    expect(line(r.text, '/cached.html')).toMatch(/^CACHED .*MISS \d+ms → HIT \d+ms \| via X-Magento-Cache-Debug \| tags: 3/);
    expect(r.text).toContain('Layer: Magento built-in FPC');
    expect(r.text).toContain('Summary: 1/1 cached');
  });

  it('reads Varnish hits from X-Varnish and ignores the client-facing no-store that Varnish sends', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/varnish.html`], requests: 3 });
    expect(line(r.text, '/varnish.html')).toMatch(/^CACHED .*MISS .* → HIT .* → HIT .*via X-Varnish/);
    expect(r.text).toContain('Layer: Varnish');
    expect(hits.get('/varnish.html')).toBe(3);
  });

  it('separates expected uncacheable pages from pages broken by cacheable="false"', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/checkout/cart/`, `${origin}/uncacheable-product.html`] });
    expect(line(r.text, '/checkout/cart/')).toMatch(/^NOT_CACHEABLE/);
    expect(r.text).toContain('expected: Magento never caches cart/checkout/customer pages');
    expect(line(r.text, '/uncacheable-product.html')).toMatch(/^NOT_CACHEABLE/);
    expect(r.text).toContain('cacheable="false"');
  });

  it('explains a cacheable page that stays MISS, including cookies set by the response', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/miss.html`] });
    expect(line(r.text, '/miss.html')).toMatch(/^MISS/);
    expect(r.text).toContain('response sets cookies (PHPSESSID, form_key)');
    expect(r.text).toContain('bin/magento cache:status full_page');
  });

  it('says UNKNOWN when there are no cache headers at all', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/plain.html`] });
    expect(line(r.text, '/plain.html')).toMatch(/^UNKNOWN/);
    expect(r.text).toContain('no X-Magento-Tags header');
  });

  it('reports redirects without following them, and refuses non-allowlisted URLs', async () => {
    const r = await call('magento_cache_check', { urls: [`${origin}/leave`, `${otherOrigin}/page.html`] });
    expect(r.text).toContain(`redirects (302) to ${otherOrigin}/`);
    expect(r.text).toContain('not in PW_ALLOWED_ORIGINS');
    expect(otherRequests).toBe(0);
  });

  it('requests as a cookie-less guest by default and with the browser cookies when withSession is set', async () => {
    await call('browser_navigate', { url: `${origin}/set-cookie` });
    await call('magento_cache_check', { urls: [`${origin}/echo.html`] });
    expect(seenCookies).toEqual([undefined, undefined]);
    seenCookies.length = 0;
    const r = await call('magento_cache_check', { urls: [`${origin}/echo.html`], withSession: true });
    expect(seenCookies[0]).toContain('X-Magento-Vary=logged-in');
    expect(r.text).toContain('with the browser session cookies');
  });
});

describe('cache header parsing', () => {
  it('understands Fastly, Cloudflare, Varnish and Age', () => {
    expect(readCacheStatus({ 'x-cache': 'MISS, HIT' })).toEqual({ cache: 'HIT', source: 'X-Cache' });
    expect(readCacheStatus({ 'x-cache': 'MISS, MISS' })).toEqual({ cache: 'MISS', source: 'X-Cache' });
    expect(readCacheStatus({ 'cf-cache-status': 'DYNAMIC' })).toEqual({ cache: 'MISS', source: 'CF-Cache-Status' });
    expect(readCacheStatus({ 'cf-cache-status': 'HIT' })).toEqual({ cache: 'HIT', source: 'CF-Cache-Status' });
    expect(readCacheStatus({ 'x-varnish': '32770 3' })).toEqual({ cache: 'HIT', source: 'X-Varnish' });
    expect(readCacheStatus({ age: '0' })).toEqual({ cache: 'MISS', source: 'Age' });
    expect(readCacheStatus({})).toEqual({});
    expect(detectLayer({ 'x-served-by': 'cache-fra-123, cache-ams-456' })).toBe('Fastly');
    expect(detectLayer({ 'cf-ray': 'abc' })).toBe('Cloudflare');
  });
});
