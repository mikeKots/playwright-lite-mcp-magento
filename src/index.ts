#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { VERSION, createMcpServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);

  let closeAll: () => Promise<void> = async () => undefined;
  let shuttingDown = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    // Never hang forever on a stuck browser: a zombie Chromium is worse than a hard exit.
    setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await closeAll();
    } catch (err) {
      log.error('error during shutdown', { error: String(err) });
    }
    process.exit(exitCode);
  }

  let ready: Record<string, unknown>;
  if (cfg.MCP_TRANSPORT === 'http') {
    const http = await startHttpServer(cfg, log);
    closeAll = () => http.close();
    ready = { url: http.url, maxSessions: cfg.MCP_MAX_SESSIONS };
  } else {
    const browser = new BrowserSession(cfg, log);
    const server = createMcpServer(cfg, log, browser);
    closeAll = async () => {
      await browser.close();
      await server.close();
    };
    // The client (Claude Code) closed our stdin: the session is over, clean up the browser.
    process.stdin.on('close', () => void shutdown('stdin closed'));
    await server.connect(new StdioServerTransport());
    ready = {};
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err.stack ?? String(err) });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: String(reason) });
  });

  log.info('server ready', {
    version: VERSION,
    transport: cfg.MCP_TRANSPORT,
    engine: cfg.PW_BROWSER,
    allowedOrigins: cfg.PW_ALLOWED_ORIGINS,
    scripts: cfg.PW_ALLOW_SCRIPTS,
    ...ready,
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
