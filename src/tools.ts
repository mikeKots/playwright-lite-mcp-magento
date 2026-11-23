import type { McpServer } from '@modelcontextprotocol/server';
import type { Locator, Page } from 'playwright';
import * as z from 'zod/v4';
import type { BrowserSession } from './browser.js';
import { checkUrlCache, formatCacheReport, type UrlReport } from './cache.js';
import type { Config } from './config.js';
import { ToolError, describeError } from './errors.js';
import { GRAPHQL_CHECKS, runGraphqlCheck } from './graphql.js';
import { checkPages, gotoSettled } from './health.js';
import { HELPERS_DOC, createMagentoHelpers } from './helpers.js';
import type { Logger } from './logger.js';
import type { Mutex } from './mutex.js';
import { formatCheckoutReport, magentoGuestCheckout } from './magento.js';
import { assertUrlAllowed } from './security.js';
import { ScriptTimeoutError, formatResult, runScript } from './script.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };
type AriaRole = Parameters<Page['getByRole']>[0];

export interface ToolDeps {
  cfg: Config;
  log: Logger;
  browser: BrowserSession;
  mutex: Mutex;
}

// ---------- shared schemas and helpers ----------

const TargetSchema = z
  .object({
    role: z.string().optional().describe('ARIA role, e.g. "button", "link", "textbox", "checkbox"'),
    name: z.string().optional().describe('Accessible name used with role, as shown in browser_snapshot'),
    label: z.string().optional().describe('Label text of a form field'),
    text: z.string().optional().describe('Visible text of the element'),
    selector: z.string().optional().describe('CSS selector. Last resort: prefer role + name'),
    exact: z.boolean().optional().describe('Exact match for name, label or text (default false)'),
  })
  .describe('How to find the element: role (+ name), label, text or selector');

type Target = z.infer<typeof TargetSchema>;

function resolveTarget(page: Page, t: Target, nth?: number): Locator {
  const exact = t.exact ?? false;
  let locator: Locator;
  if (t.role) locator = page.getByRole(t.role as AriaRole, t.name ? { name: t.name, exact } : {});
  else if (t.label) locator = page.getByLabel(t.label, { exact });
  else if (t.text) locator = page.getByText(t.text, { exact });
  else if (t.selector) locator = page.locator(t.selector);
  else throw new ToolError('Target is empty: provide role, label, text or selector.');
  // Without nth, Playwright strict mode rejects ambiguous matches, which is what we want.
  return nth === undefined ? locator : locator.nth(nth);
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars; pass a larger maxChars if needed]`;
}

async function pageSummary(page: Page): Promise<string> {
  return `URL: ${page.url()}\nTitle: ${await page.title()}`;
}

// ---------- input schemas ----------

const NavigateInput = z.object({
  url: z.string().describe('Absolute URL to open; its origin must be allowlisted'),
});
const SnapshotInput = z.object({
  maxChars: z.number().int().positive().max(100_000).optional().describe('Snapshot size limit in characters'),
});
const ClickInput = z.object({
  target: TargetSchema,
  nth: z.number().int().min(0).optional().describe('0-based index when several elements match'),
});
const FillInput = z.object({
  target: TargetSchema,
  value: z.string().describe('Text to type into the field (replaces current value)'),
  submit: z.boolean().optional().describe('Press Enter after filling'),
  nth: z.number().int().min(0).optional(),
});
const ScreenshotInput = z.object({
  fullPage: z.boolean().optional().describe('Capture the whole scrollable page'),
  target: TargetSchema.optional().describe('Capture only this element'),
});
const EmptyInput = z.object({});
const RunInput = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'Body of an async function; `page` (Playwright Page) is in scope. Use `return` to send back a ' +
        'JSON-serializable result. Example: await page.goto("https://shop.test/"); ' +
        'return await page.locator("h1").innerText();',
    ),
  timeoutMs: z.number().int().positive().max(300_000).optional().describe('Script time limit in ms'),
});
const HealthCheckInput = z.object({
  urls: z.array(z.string()).min(1).max(20).describe('Pages to check, e.g. home, category, product, cart'),
});
const CacheCheckInput = z.object({
  urls: z.array(z.string()).min(1).max(20).describe('Pages to check, e.g. home, category, product, CMS page'),
  requests: z
    .number()
    .int()
    .min(2)
    .max(5)
    .optional()
    .describe('Requests per URL (default 2: the first may warm the cache, the last must be a HIT)'),
  withSession: z
    .boolean()
    .optional()
    .describe('Send the browser session cookies (logged-in customer, cart). Default false: cookie-less guest'),
});
const GraphqlCheckInput = z.object({
  storeUrl: z
    .string()
    .describe('Any URL of the store (endpoint becomes <origin>/graphql), or the full GraphQL endpoint URL'),
  checks: z
    .array(z.enum(GRAPHQL_CHECKS))
    .optional()
    .describe(
      'Preset checks: store (storeConfig), catalog (top categories), products (listing, stock, zero prices), ' +
        'cart (guest cart + add SKU, leaves an abandoned cart), cache (GET query cached). Default: all, unless query is given',
    ),
  query: z.string().optional().describe('Custom GraphQL query or mutation; returns status, errors and truncated data'),
  variables: z.record(z.string(), z.unknown()).optional().describe('Variables for the custom query'),
  method: z.enum(['POST', 'GET']).optional().describe('HTTP method for the custom query (GET shows cache status). Default POST'),
  sku: z.string().optional().describe('SKU for the cart check (default: first in-stock simple product)'),
  storeCode: z.string().optional().describe('Store view code, sent as the Store header'),
  maxChars: z.number().int().positive().max(50_000).optional().describe('Limit for custom query data (default 2000)'),
});
const GuestCheckoutInput = z.object({
  productUrl: z.string().describe('Product page URL of a SIMPLE product (no required options); origin must be allowlisted'),
  qty: z.number().int().positive().max(1000).optional().describe('Quantity to add (default: the page default, usually 1)'),
  email: z.string().optional().describe('Guest email (default guest@example.com)'),
  address: z
    .object({
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      street: z.string().optional(),
      city: z.string().optional(),
      postcode: z.string().optional(),
      countryId: z.string().optional().describe('ISO-2 country code, e.g. "US", "DE"'),
      region: z.string().optional().describe('Region/state name as shown in the dropdown, e.g. "Texas"'),
      telephone: z.string().optional(),
    })
    .optional()
    .describe('Shipping address; every field defaults to a US test address (Austin, Texas)'),
  shippingMethod: z.string().optional().describe('carrier_method code, e.g. "flatrate_flatrate" (default: first offered)'),
  paymentMethod: z.string().optional().describe('Payment method code (default: "checkmo" if offered, else the first)'),
  placeOrder: z
    .boolean()
    .optional()
    .describe('Actually place the order (creates a real order in the store). Default false: stop on the payment step'),
  keepSession: z
    .boolean()
    .optional()
    .describe('Keep current cookies/cart instead of starting as a fresh guest (default false)'),
});

// ---------- registration ----------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { cfg, log, browser, mutex } = deps;

  /**
   * Common wrapper for every tool:
   * serialized execution, lazy browser start, timing logs, and failures returned
   * as isError results (the agent can read and recover) instead of protocol errors.
   * Tool arguments are never logged: they may contain passwords or personal data.
   */
  function run<A>(tool: string, handler: (args: A, page: Page) => Promise<ToolResult>) {
    return (args: A): Promise<ToolResult> =>
      mutex.run(async () => {
        const started = Date.now();
        try {
          const page = await browser.getPage();
          const result = await handler(args, page);
          log.info('tool ok', { tool, ms: Date.now() - started });
          return result;
        } catch (err) {
          const message = describeError(err);
          log.warn('tool failed', { tool, ms: Date.now() - started, error: message });
          return { isError: true, content: [{ type: 'text', text: `${tool} failed: ${message}` }] };
        }
      });
  }

  server.registerTool(
    'browser_navigate',
    {
      title: 'Open URL',
      description: 'Open a URL in the browser. Returns HTTP status, final URL and title (not the page content).',
      inputSchema: NavigateInput,
    },
    run<z.infer<typeof NavigateInput>>('browser_navigate', async ({ url }, page) => {
      const target = assertUrlAllowed(url, cfg.PW_ALLOWED_ORIGINS);
      const response = await gotoSettled(page, target.toString(), 'domcontentloaded');
      const status = response ? `HTTP ${response.status()}` : 'No response (same-document navigation)';
      const consent = await browser.acceptCookies(page);
      const consentNote = consent ? `\nCookie banner accepted ("${consent}").` : '';
      return text(
        `${status}\n${await pageSummary(page)}${consentNote}\nNext: call browser_snapshot to see the page structure.`,
      );
    }),
  );

  server.registerTool(
    'browser_snapshot',
    {
      title: 'Page structure',
      description:
        'Accessibility tree of the current page (roles, names, text) in compact YAML, truncated to save tokens. ' +
        'Use the roles and names from here as click/fill targets.',
      inputSchema: SnapshotInput,
      annotations: { readOnlyHint: true },
    },
    run<z.infer<typeof SnapshotInput>>('browser_snapshot', async ({ maxChars }, page) => {
      const snapshot = await page.locator('body').ariaSnapshot();
      return text(`${await pageSummary(page)}\n\n${truncate(snapshot, maxChars ?? cfg.PW_SNAPSHOT_MAX_CHARS)}`);
    }),
  );

  server.registerTool(
    'browser_click',
    {
      title: 'Click element',
      description: 'Click an element. Prefer target { role, name } taken from browser_snapshot.',
      inputSchema: ClickInput,
    },
    run<z.infer<typeof ClickInput>>('browser_click', async ({ target, nth }, page) => {
      await resolveTarget(page, target, nth).click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      return text(`Clicked.\n${await pageSummary(page)}`);
    }),
  );

  server.registerTool(
    'browser_fill',
    {
      title: 'Fill field',
      description: 'Fill a text field, optionally pressing Enter afterwards.',
      inputSchema: FillInput,
    },
    run<z.infer<typeof FillInput>>('browser_fill', async ({ target, value, submit, nth }, page) => {
      const field = resolveTarget(page, target, nth);
      await field.fill(value);
      if (submit) {
        await field.press('Enter');
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
      // The value itself is not echoed back: it may be a password.
      return text(`Filled ${value.length} chars${submit ? ' and pressed Enter' : ''}.\n${await pageSummary(page)}`);
    }),
  );

  server.registerTool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'JPEG screenshot of the viewport, the full page or one element. Costs many tokens: use only for visual checks.',
      inputSchema: ScreenshotInput,
      annotations: { readOnlyHint: true },
    },
    run<z.infer<typeof ScreenshotInput>>('browser_screenshot', async ({ fullPage, target }, page) => {
      const image = target
        ? await resolveTarget(page, target).screenshot({ type: 'jpeg', quality: 70 })
        : await page.screenshot({ type: 'jpeg', quality: 70, fullPage: fullPage ?? false });
      return {
        content: [
          { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
          { type: 'text', text: await pageSummary(page) },
        ],
      };
    }),
  );

  server.registerTool(
    'browser_console_errors',
    {
      title: 'Console errors',
      description: 'JavaScript console errors and uncaught exceptions since the previous call.',
      inputSchema: EmptyInput,
      annotations: { readOnlyHint: true },
    },
    run<z.infer<typeof EmptyInput>>('browser_console_errors', async () => {
      const errors = browser.drainErrors();
      return text(errors.length > 0 ? errors.join('\n') : 'No console errors since the last check.');
    }),
  );

  server.registerTool(
    'browser_reset',
    {
      title: 'Reset session',
      description: 'Clear cookies, storage and the open page (for example, to test as a new guest customer).',
      inputSchema: EmptyInput,
    },
    run<z.infer<typeof EmptyInput>>('browser_reset', async () => {
      await browser.reset();
      return text('Browser session reset: cookies, storage and page cleared.');
    }),
  );

  // Code mode: one agent-written script replaces a chain of navigate/snapshot/click calls,
  // and only the final result travels back into the agent's context. Opt-in, see script.ts.
  if (cfg.PW_ALLOW_SCRIPTS) {
    server.registerTool(
      'browser_run',
      {
        title: 'Run Playwright script',
        description:
          'Run a Playwright script against the current page in ONE call and get back only its return value. ' +
          'Prefer this over long chains of navigate/click/snapshot calls (multi-step flows, loops, data extraction). ' +
          'Top-level navigation to non-allowlisted origins is blocked. Console errors stay available via browser_console_errors. ' +
          HELPERS_DOC,
        inputSchema: RunInput,
      },
      run<z.infer<typeof RunInput>>('browser_run', async ({ code, timeoutMs }, page) => {
        try {
          const result = await runScript(page, code, timeoutMs ?? cfg.PW_SCRIPT_TIMEOUT_MS, {
            magento: createMagentoHelpers(page, cfg, browser),
          });
          return text(`${truncate(formatResult(result), cfg.PW_SNAPSHOT_MAX_CHARS)}\n\n${await pageSummary(page)}`);
        } catch (err) {
          // A timed-out script may still be running: closing the page makes its pending
          // Playwright calls fail fast. Cookies survive, the next call gets a fresh page.
          if (err instanceof ScriptTimeoutError) await page.close().catch(() => undefined);
          throw err;
        }
      }),
    );
  }

  // Domain tool: the reason to own an MCP server. One call replaces dozens of
  // navigate/snapshot round-trips and returns a compact report.
  server.registerTool(
    'page_health_check',
    {
      title: 'Smoke-check pages',
      description:
        'Open each URL and report HTTP status, load time and JS console errors. ' +
        'Good for smoke tests after a deploy (home, category, product, cart, checkout).',
      inputSchema: HealthCheckInput,
      annotations: { readOnlyHint: true },
    },
    run<z.infer<typeof HealthCheckInput>>('page_health_check', async ({ urls }, page) => {
      const results = await checkPages(page, urls, browser, cfg.PW_ALLOWED_ORIGINS);
      const lines = results.map((r) =>
        r.failure
          ? `FAIL --- ${r.url} | ${r.failure}`
          : `${r.ok ? 'OK  ' : 'FAIL'} ${r.status} ${r.ms}ms ${r.url}` +
            (r.errors.length > 0 ? ` | ${r.errors.length} JS error(s), first: ${r.errors[0]}` : ''),
      );
      const failed = results.filter((r) => !r.ok).length;
      return text(`${urls.length - failed}/${urls.length} passed\n${lines.join('\n')}`);
    }),
  );

  server.registerTool(
    'magento_cache_check',
    {
      title: 'Magento full page cache check',
      description:
        'Request each URL several times over HTTP and report whether the full page cache serves it: HIT/MISS per ' +
        'request with timings, cache layer (Varnish, Fastly, Cloudflare, built-in FPC), Magento cacheability ' +
        '(X-Magento-Cache-Control, X-Magento-Tags) and likely causes when a page is not cached. Redirects are reported, not followed.',
      inputSchema: CacheCheckInput,
      annotations: { readOnlyHint: true },
    },
    run<z.infer<typeof CacheCheckInput>>('magento_cache_check', async ({ urls, requests, withSession }, page) => {
      const count = requests ?? 2;
      // A guest gets the shared cache entry; the browser context may carry a session or X-Magento-Vary cookie.
      const client = withSession ? page.request : await browser.newGuestRequest();
      const reports: UrlReport[] = [];
      try {
        for (const raw of urls) {
          let url: string;
          try {
            url = assertUrlAllowed(raw, cfg.PW_ALLOWED_ORIGINS).toString();
          } catch (err) {
            reports.push({ url: raw, verdict: 'ERROR', hops: [], setCookies: [], notes: [describeError(err)] });
            continue;
          }
          reports.push(await checkUrlCache(client, url, count));
        }
      } finally {
        if (!withSession) await client.dispose();
      }
      return text(formatCacheReport(reports, count, withSession ?? false));
    }),
  );

  server.registerTool(
    'magento_graphql_check',
    {
      title: 'Magento GraphQL check',
      description:
        'Check the Magento GraphQL API in ONE call. Without a query: preset checks (store config, catalog, product ' +
        'listing with stock and zero-price detection, guest cart, GET caching), one line each. With a query: HTTP ' +
        'status, GraphQL errors with category and path, timing and truncated data. Sent as a cookie-less guest.',
      inputSchema: GraphqlCheckInput,
    },
    run<z.infer<typeof GraphqlCheckInput>>('magento_graphql_check', async (args) => {
      const base = assertUrlAllowed(args.storeUrl, cfg.PW_ALLOWED_ORIGINS);
      const endpoint = /\/graphql\/?$/.test(base.pathname) ? base.toString() : new URL('/graphql', base.origin).toString();
      const client = await browser.newGuestRequest();
      try {
        return text(
          await runGraphqlCheck(client, {
            endpoint,
            checks: args.checks,
            query: args.query,
            variables: args.variables,
            method: args.method,
            sku: args.sku,
            storeCode: args.storeCode,
            maxChars: args.maxChars ?? 2000,
          }),
        );
      } finally {
        await client.dispose();
      }
    }),
  );

  server.registerTool(
    'magento_guest_checkout',
    {
      title: 'Magento guest checkout',
      description:
        'Magento 2 / Adobe Commerce / Mage-OS: add a simple product to the cart and go through the standard checkout ' +
        'as a guest (address, shipping method, payment method) in ONE call. Returns offered shipping/payment methods, ' +
        'order totals, step timings, JS console errors and failed HTTP requests. Stops before Place Order unless ' +
        'placeOrder is true. Works with Luma and Hyvä (luma-checkout fallback) storefronts, not with Hyvä Checkout.',
      inputSchema: GuestCheckoutInput,
    },
    run<z.infer<typeof GuestCheckoutInput>>('magento_guest_checkout', async (args, current) => {
      const productUrl = assertUrlAllowed(args.productUrl, cfg.PW_ALLOWED_ORIGINS).toString();
      let page = current;
      if (!args.keepSession) {
        // A guest checkout must not reuse a logged-in session or a cart left by earlier calls.
        // reset() re-applies PW_STORAGE_STATE, so also drop its cookies (a logged-in session).
        await browser.reset();
        page = await browser.getPage();
        if (cfg.PW_STORAGE_STATE) await page.context().clearCookies();
      }
      const report = await magentoGuestCheckout(page, {
        ...args,
        productUrl,
        stepTimeoutMs: cfg.PW_NAV_TIMEOUT_MS,
        afterNavigate: (p) => browser.acceptCookies(p),
        drainConsole: () => browser.drainErrors(),
      });
      const result = text(formatCheckoutReport(report, args.placeOrder ?? false));
      return report.ok ? result : { ...result, isError: true };
    }),
  );
}
