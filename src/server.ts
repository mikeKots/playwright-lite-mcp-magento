import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import type { BrowserSession } from './browser.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

// package.json sits next to dist/ in the repo, the npm package and the Docker image.
export const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

/** One MCP server with all tools bound to one browser session (stdio: the only one; HTTP: one per MCP session). */
export function createMcpServer(cfg: Config, log: Logger, browser: BrowserSession): McpServer {
  const server = new McpServer(
    { name: 'playwright-lite', version: VERSION },
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
  return server;
}
