import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NodeStreamableHTTPServerTransport, hostHeaderValidation, originValidation } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import { BrowserSession, SharedBrowser } from './browser.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { createMcpServer } from './server.js';

/**
 * Streamable HTTP transport (stateful). Every MCP session gets its own McpServer and BrowserSession
 * (browser context, page, cookies, cart, tool queue); all sessions share one browser process.
 *
 * Request pipeline: Host and Origin check (DNS rebinding) → bearer token → session routing.
 * browser_run is never registered here: config.ts refuses PW_ALLOW_SCRIPTS with this transport.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const SWEEP_INTERVAL_MS = 60_000;

interface Session {
  id: string;
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  browser: BrowserSession;
  lastActive: number;
  /** Open HTTP exchanges (a tool call in progress, an SSE stream): such a session is never idle. */
  inflight: number;
  /** Set once cleanup starts: every caller (DELETE, transport close, idle sweep, shutdown) awaits the same work. */
  closing?: Promise<void>;
}

export interface HttpServerHandle {
  url: string;
  sessionCount(): number;
  close(): Promise<void>;
}

export async function startHttpServer(cfg: Config, log: Logger): Promise<HttpServerHandle> {
  const shared = new SharedBrowser(cfg, log);
  const sessions = new Map<string, Session>();
  const hostnames = allowedHostnames(cfg);
  const validateHost = hostHeaderValidation(hostnames);
  const validateOrigin = originValidation(hostnames);
  const tokenDigest = digest(cfg.MCP_HTTP_TOKEN ?? '');

  const isAuthorized = (req: IncomingMessage): boolean => {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] ?? '');
    // Hashing first makes the comparison constant-time regardless of the presented length.
    return !!match && timingSafeEqual(digest(match[1]!.trim()), tokenDigest);
  };

  const dispose = (session: Session, reason: string): Promise<void> =>
    (session.closing ??= (async () => {
      sessions.delete(session.id);
      log.info('session closed', { session: shortId(session.id), reason, sessions: sessions.size });
      await session.browser.close();
      await session.server.close().catch(() => undefined);
    })());

  async function openSession(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (sessions.size >= cfg.MCP_MAX_SESSIONS) {
      log.warn('session limit reached', { max: cfg.MCP_MAX_SESSIONS });
      return jsonRpcError(res, 503, -32000, `Too many sessions (MCP_MAX_SESSIONS=${cfg.MCP_MAX_SESSIONS}): close one or try later`);
    }
    const browser = new BrowserSession(cfg, log, shared);
    const server = createMcpServer(cfg, log, browser);
    let session: Session | undefined;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session = { id, transport, server, browser, lastActive: Date.now(), inflight: 1 };
        sessions.set(id, session);
        log.info('session opened', { session: shortId(id), sessions: sessions.size });
      },
      onsessionclosed: () => {
        if (session) void dispose(session, 'client DELETE');
      },
    });
    transport.onclose = () => {
      if (session) void dispose(session, 'transport closed');
    };
    await server.connect(transport);
    res.on('close', () => {
      if (session) {
        session.inflight--;
        session.lastActive = Date.now();
      }
    });
    await transport.handleRequest(req, res, body);
    if (!session) {
      // initialize was rejected (bad protocol version, invalid params): nothing to keep.
      await browser.close();
      await server.close().catch(() => undefined);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
      return;
    }
    if (path !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: the MCP endpoint is /mcp');
      return;
    }
    if (!isAuthorized(req)) {
      res
        .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="playwright-lite-mcp"' })
        .end(JSON.stringify({ error: 'invalid_token', error_description: 'Send Authorization: Bearer <MCP_HTTP_TOKEN>' }));
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJson(req);
      } catch (err) {
        const tooLarge = err instanceof BodyTooLargeError;
        return jsonRpcError(res, tooLarge ? 413 : 400, tooLarge ? -32600 : -32700, (err as Error).message);
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (!session) return jsonRpcError(res, 404, -32001, 'Session not found: initialize a new session');
      session.inflight++;
      session.lastActive = Date.now();
      res.on('close', () => {
        session.inflight--;
        session.lastActive = Date.now();
      });
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === 'POST' && isInitializeRequest(body)) return openSession(req, res, body);
    return jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header required (send initialize first)');
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error('http request failed', { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
      else res.end();
    });
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.inflight <= 0 && now - session.lastActive > cfg.MCP_SESSION_IDLE_MS) {
        void session.transport.close().finally(() => dispose(session, 'idle'));
      }
    }
  }, Math.min(SWEEP_INTERVAL_MS, cfg.MCP_SESSION_IDLE_MS));
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.MCP_HTTP_PORT, cfg.MCP_HTTP_HOST, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;

  return {
    url: `http://${host}:${address.port}/mcp`,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.all([...sessions.values()].map((s) => s.transport.close().finally(() => dispose(s, 'shutdown'))));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await shared.close();
    },
  };
}

/** Localhost always; the bind address when it is a concrete one; plus MCP_HTTP_ALLOWED_HOSTS. */
export function allowedHostnames(cfg: Pick<Config, 'MCP_HTTP_HOST' | 'MCP_HTTP_ALLOWED_HOSTS'>): string[] {
  const out = new Set([...LOCAL_HOSTNAMES, ...cfg.MCP_HTTP_ALLOWED_HOSTS]);
  const bind = cfg.MCP_HTTP_HOST.toLowerCase();
  if (bind !== '0.0.0.0' && bind !== '::' && bind !== '[::]') out.add(bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind);
  return [...out];
}

class BodyTooLargeError extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError(`Request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Parse error: request body is not valid JSON');
  }
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Session ids are not logged in full. */
function shortId(id: string): string {
  return id.slice(0, 8);
}
