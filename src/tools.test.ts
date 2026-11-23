import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

// Integration tests: real tool handlers, a real headless browser and a local HTTP site.
// A fake McpServer captures the handlers, so no MCP transport is needed.

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: unknown) => Promise<Result>;

const PAGES: Record<string, string> = {
  '/': `<title>Home</title><h1>Store</h1>
        <label>Email <input id="email"></label>
        <button onclick="document.querySelector('#out').textContent='clicked:'+document.querySelector('#email').value">Subscribe</button>
        <p id="out"></p>
        <a href="/product">Product</a>`,
  '/product': '<title>Product</title><h1>Shoe</h1><span class="price">$99</span>',
  '/broken': '<title>Broken</title><script>throw new Error("checkout.js exploded")</script>',
};

function startSite(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/go-product') {
      res.writeHead(302, { location: '/product' }).end();
      return;
    }
    if (path === '/leave') {
      res.writeHead(302, { location: `${otherOrigin}/` }).end();
      return;
    }
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? '<title>404</title>not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let site: Server;
let other: Server;
let origin: string;
let otherOrigin: string;

beforeAll(async () => {
  site = await startSite();
  other = await startSite();
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => site.close(r));
  await new Promise((r) => other.close(r));
});

function setup(env: Record<string, string> = {}) {
  const cfg = loadConfig({ PW_ALLOWED_ORIGINS: origin, LOG_LEVEL: 'error', PW_COOKIE_WAIT_MS: '0', PW_ACTION_TIMEOUT_MS: '1500', ...env });
  const browser = new BrowserSession(cfg, createLogger(cfg.LOG_LEVEL));
  const tools = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  registerTools(fakeServer, { cfg, log: createLogger(cfg.LOG_LEVEL), browser, mutex: new Mutex() });
  const call = async (name: string, args: unknown = {}) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`tool ${name} is not registered`);
    const result = await handler(args);
    return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  return { tools, call, browser };
}

describe('tools', () => {
  let ctx: ReturnType<typeof setup>;

  beforeAll(() => {
    ctx = setup();
  });
  afterAll(async () => {
    await ctx.browser.close();
  });

  it('browser_navigate opens an allowlisted page and reports status and title', async () => {
    const r = await ctx.call('browser_navigate', { url: `${origin}/` });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('HTTP 200');
    expect(r.text).toContain('Title: Home');
  });

  it('browser_navigate refuses a non-allowlisted origin', async () => {
    const r = await ctx.call('browser_navigate', { url: `${otherOrigin}/` });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not in PW_ALLOWED_ORIGINS');
  });

  it('blocks a server redirect to a non-allowlisted origin', async () => {
    const r = await ctx.call('browser_navigate', { url: `${origin}/leave` });
    expect(r.isError).toBe(true);
  });

  it('still follows redirects that stay on an allowlisted origin', async () => {
    const r = await ctx.call('browser_navigate', { url: `${origin}/go-product` });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(`URL: ${origin}/product`);
    expect(r.text).toContain('Title: Product');
  });

  it('snapshot, fill and click work with role/label targets', async () => {
    await ctx.call('browser_navigate', { url: `${origin}/` });
    const snap = await ctx.call('browser_snapshot');
    expect(snap.text).toContain('heading "Store"');
    const fill = await ctx.call('browser_fill', { target: { label: 'Email' }, value: 'secret@example.com' });
    expect(fill.text).not.toContain('secret@example.com'); // values are never echoed back
    await ctx.call('browser_click', { target: { role: 'button', name: 'Subscribe' } });
    const after = await ctx.call('browser_snapshot');
    expect(after.text).toContain('clicked:secret@example.com');
  });

  it('click on a missing element returns an agent-readable error instead of throwing', async () => {
    await ctx.call('browser_navigate', { url: `${origin}/` });
    const r = await ctx.call('browser_click', { target: { role: 'button', name: 'Does not exist' } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('browser_click failed');
  });

  it('page_health_check reports OK pages, HTTP errors and JS errors in one call', async () => {
    const r = await ctx.call('page_health_check', { urls: [`${origin}/`, `${origin}/missing`, `${origin}/broken`] });
    expect(r.text).toContain('1/3 passed');
    expect(r.text).toMatch(/OK\s+200 .*\/ ?$/m);
    expect(r.text).toMatch(/FAIL 404/);
    expect(r.text).toContain('checkout.js exploded');
  });

  it('browser_run is not registered unless PW_ALLOW_SCRIPTS=true', () => {
    expect(ctx.tools.has('browser_run')).toBe(false);
  });
});

describe('browser_run (code mode)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeAll(() => {
    ctx = setup({ PW_ALLOW_SCRIPTS: 'true' });
  });
  afterEach(async () => {
    await ctx.call('browser_reset');
  });
  afterAll(async () => {
    await ctx.browser.close();
  });

  it('runs a multi-step flow in one call and returns only the result', async () => {
    const r = await ctx.call('browser_run', {
      code: `
        await page.goto('${origin}/');
        await page.getByRole('link', { name: 'Product' }).click();
        return { name: await page.locator('h1').innerText(), price: await page.locator('.price').innerText() };
      `,
    });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.text.split('\n\nURL:')[0]!)).toEqual({ name: 'Shoe', price: '$99' });
    expect(r.text).toContain(`URL: ${origin}/product`);
  });

  it('keeps the allowlist: navigation to another origin fails', async () => {
    const r = await ctx.call('browser_run', { code: `await page.goto('${otherOrigin}/'); return 'escaped';` });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('escaped');
  });

  it('returns script errors as isError results', async () => {
    const r = await ctx.call('browser_run', { code: `throw new Error('no add-to-cart button')` });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no add-to-cart button');
  });

  it('times out a hung script, and the next call still works on a fresh page', async () => {
    const hung = await ctx.call('browser_run', { code: 'await new Promise(() => {});', timeoutMs: 300 });
    expect(hung.isError).toBe(true);
    expect(hung.text).toContain('timed out');
    const next = await ctx.call('browser_run', { code: `await page.goto('${origin}/'); return await page.title();` });
    expect(next.isError).toBeUndefined();
    expect(next.text).toContain('Home');
  });
});
