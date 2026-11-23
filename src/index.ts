#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

const SHUTDOWN_TIMEOUT_MS = 5_000;
// package.json sits next to dist/ in the repo, the npm package and the Docker image.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const browser = new BrowserSession(cfg, log);

  const server = new McpServer(
    { name: 'playwright-lite', version },
    {
      instructions:
        'Browser automation. Typical flow: browser_navigate -> browser_snapshot -> browser_click / browser_fill. ' +
        'Prefer { role, name } targets from the snapshot over CSS selectors. ' +
        'Use page_health_check for quick smoke tests of several pages. Only allowlisted origins can be opened.' +
        (cfg.PW_ALLOW_SCRIPTS
          ? ' For multi-step flows prefer browser_run: one Playwright script, one call, only the result comes back.'
          : ''),
    },
  );
  registerTools(server, { cfg, log, browser, mutex: new Mutex() });

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    // Never hang forever on a stuck browser: a zombie Chromium is worse than a hard exit.
    setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await browser.close();
      await server.close();
    } catch (err) {
      log.error('error during shutdown', { error: String(err) });
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The client (Claude Code) closed our stdin: the session is over, clean up the browser.
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err.stack ?? String(err) });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: String(reason) });
  });

  await server.connect(new StdioServerTransport());
  log.info('server ready', {
    version,
    engine: cfg.PW_BROWSER,
    allowedOrigins: cfg.PW_ALLOWED_ORIGINS,
    scripts: cfg.PW_ALLOW_SCRIPTS,
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
