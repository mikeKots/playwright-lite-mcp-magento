// Minimal MCP stdio client (raw JSON-RPC, newline-delimited), shared by mcp-smoke.mjs and benchmark.mjs.
// Starts a server the same way Claude Code does and lets scripts call its tools.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, timeoutMs?: number, quiet?: boolean }} [opts]
 */
export async function startMcpServer(command, args, opts = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', opts.quiet ? 'ignore' : 'inherit'],
  });
  const pending = new Map();
  let nextId = 1;

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
  });

  function request(method, params) {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error(`${method} timed out`)), opts.timeoutMs ?? 180_000).unref();
    });
  }

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'playwright-lite-mcp-sample-store', version: '1.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    request,
    /** Calls a tool; `text` is all text content joined, `chars` its size (what lands in the agent's context). */
    async call(name, args) {
      const res = await request('tools/call', { name, arguments: args });
      const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
      const images = res.content?.filter((c) => c.type === 'image').length ?? 0;
      return { ok: !res.isError, text, chars: text.length, images };
    },
    async listTools() {
      return (await request('tools/list', {})).tools;
    },
    close() {
      child.kill();
    },
  };
}

/**
 * Same interface over the Streamable HTTP transport: starts the server process with
 * MCP_TRANSPORT=http, waits for /healthz, then speaks JSON-RPC over POST /mcp with a session.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, port: number, token: string, timeoutMs?: number, quiet?: boolean }} opts
 */
export async function startMcpHttpServer(command, args, opts) {
  const child = spawn(command, args, {
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'ignore', opts.quiet ? 'ignore' : 'inherit'],
  });
  const base = `http://localhost:${opts.port}`;
  const started = Date.now();
  for (;;) {
    const up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
    if (up) break;
    if (child.exitCode !== null || Date.now() - started > 60_000) {
      child.kill();
      throw new Error(`HTTP server did not come up on ${base}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  let sessionId;
  let nextId = 1;
  async function post(message) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${opts.token}`,
        'mcp-protocol-version': '2025-06-18',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    sessionId ??= res.headers.get('mcp-session-id') ?? undefined;
    const text = await res.text();
    if (!text) return undefined;
    // A reply is either plain JSON or SSE events; the response is the event carrying our id.
    const payloads = text.includes('data:')
      ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
      : [JSON.parse(text)];
    const msg = payloads.find((p) => p.id === message.id) ?? payloads[0];
    if (msg?.error) throw new Error(JSON.stringify(msg.error));
    return msg?.result;
  }
  const request = (method, params) => post({ jsonrpc: '2.0', id: nextId++, method, params });

  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'playwright-lite-mcp-sample-store', version: '1.0.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    request,
    async call(name, toolArgs) {
      const res = await request('tools/call', { name, arguments: toolArgs });
      const text = res.content?.map((c) => c.text ?? '').join('\n') ?? '';
      const images = res.content?.filter((c) => c.type === 'image').length ?? 0;
      return { ok: !res.isError, text, chars: text.length, images };
    },
    async listTools() {
      return (await request('tools/list', {})).tools;
    },
    close() {
      child.kill('SIGTERM');
    },
  };
}
