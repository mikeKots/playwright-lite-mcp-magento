import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { allowedHostnames, startHttpServer, type HttpServerHandle } from './http.js';
import { createLogger } from './logger.js';

// The Streamable HTTP transport end to end: guards, auth, one browser context per session,
// session limit, DELETE and idle expiry. MCP is spoken as raw JSON-RPC over fetch.

const TOKEN = 'test-token-0123456789abcdef';
const PROTOCOL = '2025-06-18';

let site: Server;
let siteOrigin: string;
let mcp: HttpServerHandle;

function startSite(): Promise<Server> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>Page ${req.url}</title><h1>${req.url}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function start(extra: Record<string, string> = {}): Promise<HttpServerHandle> {
  const cfg = loadConfig({
    PW_ALLOWED_ORIGINS: siteOrigin,
    LOG_LEVEL: 'error',
    PW_COOKIE_WAIT_MS: '0',
    PW_NAV_TIMEOUT_MS: '5000',
    MCP_TRANSPORT: 'http',
    MCP_HTTP_PORT: '0',
    MCP_HTTP_TOKEN: TOKEN,
    ...extra,
  });
  return startHttpServer(cfg, createLogger(cfg.LOG_LEVEL));
}

interface RpcReply {
  status: number;
  sessionId?: string;
  body?: { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

/** One JSON-RPC message; the reply may come as JSON or as one SSE "message" event. */
async function rpc(url: string, message: object, opts: { sessionId?: string; token?: string } = {}): Promise<RpcReply> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${opts.token ?? TOKEN}`,
      'mcp-protocol-version': PROTOCOL,
      ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  const json = text.includes('data:') ? text.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : text;
  return { status: res.status, sessionId: res.headers.get('mcp-session-id') ?? undefined, body: json ? JSON.parse(json) : undefined };
}

async function openSession(url: string): Promise<string> {
  const init = await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  expect(init.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId: init.sessionId });
  return init.sessionId!;
}

const callTool = async (url: string, sessionId: string, name: string, args: object = {}) => {
  const r = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, { sessionId });
  const content = (r.body?.result?.['content'] as Array<{ text?: string }> | undefined) ?? [];
  return content.map((c) => c.text ?? '').join('\n');
};

/** node:http, because fetch does not let a caller set the Host header. */
function rawPost(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

beforeAll(async () => {
  site = await startSite();
  siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  mcp = await start({ MCP_MAX_SESSIONS: '2' });
});
afterAll(async () => {
  await mcp.close();
  await new Promise((r) => site.close(r));
});

describe('config', () => {
  const base = { PW_ALLOWED_ORIGINS: 'https://shop.test', MCP_TRANSPORT: 'http' };

  it('requires a long enough MCP_HTTP_TOKEN', () => {
    expect(() => loadConfig(base)).toThrow(/MCP_HTTP_TOKEN is required/);
    expect(() => loadConfig({ ...base, MCP_HTTP_TOKEN: 'short' })).toThrow(/at least 24 characters/);
    expect(loadConfig({ ...base, MCP_HTTP_TOKEN: TOKEN }).MCP_TRANSPORT).toBe('http');
  });

  it('never allows browser_run over HTTP', () => {
    expect(() => loadConfig({ ...base, MCP_HTTP_TOKEN: TOKEN, PW_ALLOW_SCRIPTS: 'true' })).toThrow(/stdio only/);
  });

  it('accepts localhost, a concrete bind address and extra hosts', () => {
    expect(allowedHostnames({ MCP_HTTP_HOST: '0.0.0.0', MCP_HTTP_ALLOWED_HOSTS: ['qa-box'] })).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'qa-box',
    ]);
    expect(allowedHostnames({ MCP_HTTP_HOST: '10.0.0.5', MCP_HTTP_ALLOWED_HOSTS: [] })).toContain('10.0.0.5');
  });
});

describe('HTTP transport', () => {
  it('serves /healthz without a token and 404 elsewhere', async () => {
    const base = mcp.url.replace(/\/mcp$/, '');
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('rejects a missing or wrong bearer token', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    expect((await rpc(mcp.url, init, { token: 'wrong-token-0123456789abcdef' })).status).toBe(401);
    const res = await fetch(mcp.url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('rejects foreign Host and Origin headers (DNS rebinding)', async () => {
    expect(await rawPost(mcp.url, { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` })).toBe(403);
    expect(await rawPost(mcp.url, { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` })).toBe(403);
  });

  it('asks for initialize first and reports unknown sessions', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const missing = await rpc(mcp.url, list);
    expect(missing.status).toBe(400);
    expect(missing.body?.error?.message).toMatch(/Mcp-Session-Id header required/);
    const unknown = await rpc(mcp.url, list, { sessionId: 'no-such-session' });
    expect(unknown.status).toBe(404);
    expect(unknown.body?.error?.code).toBe(-32001);
  });

  it('gives every session its own page, without browser_run', async () => {
    const a = await openSession(mcp.url);
    const b = await openSession(mcp.url);
    try {
      const tools = await rpc(mcp.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { sessionId: a });
      const names = (tools.body?.result?.['tools'] as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain('magento_product_check');
      expect(names).not.toContain('browser_run');

      expect(await callTool(mcp.url, a, 'browser_navigate', { url: `${siteOrigin}/from-a` })).toContain('Title: Page /from-a');
      expect(await callTool(mcp.url, b, 'browser_navigate', { url: `${siteOrigin}/from-b` })).toContain('Title: Page /from-b');
      // Each session still sees its own page: separate contexts, not one shared tab.
      expect(await callTool(mcp.url, a, 'browser_snapshot')).toContain(`URL: ${siteOrigin}/from-a`);
      expect(await callTool(mcp.url, b, 'browser_snapshot')).toContain(`URL: ${siteOrigin}/from-b`);

      // MCP_MAX_SESSIONS=2: a third client has to wait.
      const third = await rpc(mcp.url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'third', version: '1' } },
      });
      expect(third.status).toBe(503);
    } finally {
      for (const id of [a, b]) {
        const res = await fetch(mcp.url, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}`, 'mcp-session-id': id, 'mcp-protocol-version': PROTOCOL } });
        expect(res.status).toBe(200);
      }
    }
    expect(mcp.sessionCount()).toBe(0);
    const gone = await rpc(mcp.url, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { sessionId: a });
    expect(gone.status).toBe(404);
  });

  it('closes idle sessions', async () => {
    const idle = await start({ MCP_SESSION_IDLE_MS: '200' });
    try {
      await openSession(idle.url);
      expect(idle.sessionCount()).toBe(1);
      await new Promise((r) => setTimeout(r, 800));
      expect(idle.sessionCount()).toBe(0);
    } finally {
      await idle.close();
    }
  });
});
