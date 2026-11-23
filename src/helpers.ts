import type { APIRequestContext, Page } from 'playwright';
import type { BrowserSession } from './browser.js';
import { checkUrlCache, type UrlReport } from './cache.js';
import type { Config } from './config.js';
import { GRAPHQL_CHECKS, graphqlRequest, runGraphqlPresets, type GraphqlCheck, type GraphqlLine } from './graphql.js';
import { acceptCookieBanner } from './consent.js';
import { checkPages, type PageHealth } from './health.js';
import { magentoGuestCheckout, type Address, type CheckoutReport } from './magento.js';
import { assertUrlAllowed } from './security.js';

/**
 * The `magento` object available inside browser_run scripts ("code mode").
 *
 * The domain tools return text for the agent; these helpers return plain data, so a script can
 * loop, filter and aggregate (e.g. "check the cache of every category page, return only failures")
 * and only the script's final return value travels back into the agent's context.
 * Every URL still goes through the allowlist.
 */
export interface MagentoHelpers {
  /** Absolute URL for a path on the current page's store, e.g. magento.url('/checkout/cart/'). */
  url(path: string): string;
  /** Opens each URL on the script's page: { url, ok, status, ms, errors, failure? }[]. */
  health(urls: string[]): Promise<PageHealth[]>;
  /** Full page cache verdict per URL (guest, no cookies unless withSession). */
  cache(urls: string[], opts?: { requests?: number; withSession?: boolean }): Promise<UrlReport[]>;
  /** One GraphQL request: { status, ms, data, errors }. */
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    opts?: { method?: 'POST' | 'GET'; storeUrl?: string; storeCode?: string },
  ): Promise<{ status: number; ms: number; data?: unknown; errors: Array<{ message: string; category?: string; path?: string }> }>;
  /** GraphQL preset checks: { ok, name, ms, detail }[]. */
  graphqlChecks(opts?: { checks?: GraphqlCheck[]; sku?: string; storeUrl?: string; storeCode?: string }): Promise<GraphqlLine[]>;
  /** Guest checkout in a separate fresh guest browser context (the script's page is untouched). */
  checkout(opts: {
    productUrl: string;
    qty?: number;
    email?: string;
    address?: Partial<Address>;
    shippingMethod?: string;
    paymentMethod?: string;
    placeOrder?: boolean;
  }): Promise<CheckoutReport>;
  /** Cart of the script's own session from Magento customer data: { items, subtotal } or null when empty. */
  cart(): Promise<{ items: number; subtotal: string } | null>;
}

/** Short API reference, included in the browser_run tool description (the model reads it). */
export const HELPERS_DOC =
  '`magento` is in scope too (plain data, allowlisted URLs): ' +
  'magento.url(path); magento.health(urls) → [{url, ok, status, ms, errors}]; ' +
  'magento.cache(urls, {requests?, withSession?}) → [{url, verdict: CACHED|NOT_CACHEABLE|MISS|UNKNOWN|ERROR, hops, notes}]; ' +
  'magento.graphql(query, variables?, {method?, storeUrl?, storeCode?}) → {status, ms, data, errors}; ' +
  'magento.graphqlChecks({checks?, sku?}) → [{ok, name, ms, detail}]; ' +
  'magento.checkout({productUrl, qty?, shippingMethod?, paymentMethod?, placeOrder?}) → ' +
  '{ok, failedStep, error, cart, shippingMethods, totals, orderNumber, consoleErrors, failedRequests, steps} ' +
  '(fresh guest context, ~5-10s each: raise timeoutMs for loops); magento.cart() → {items, subtotal} | null. ' +
  'Return a small summary, not whole reports.';

export function createMagentoHelpers(page: Page, cfg: Config, browser: BrowserSession): MagentoHelpers {
  const allowed = (url: string) => assertUrlAllowed(url, cfg.PW_ALLOWED_ORIGINS);

  const currentOrigin = (): string => {
    const current = page.url();
    if (!/^https?:/.test(current)) {
      throw new Error('The page has no store open yet: pass absolute URLs or call page.goto(...) first.');
    }
    return new URL(current).origin;
  };

  /** Resolves a possibly relative URL against the current page and checks the allowlist. */
  const resolve = (url: string): URL => allowed(/^https?:/.test(url) ? url : new URL(url, currentOrigin()).toString());

  const endpointFor = (storeUrl?: string): string => {
    const base = resolve(storeUrl ?? currentOrigin());
    return /\/graphql\/?$/.test(base.pathname) ? base.toString() : new URL('/graphql', base.origin).toString();
  };

  async function withGuestRequest<T>(fn: (req: APIRequestContext) => Promise<T>) {
    const req = await browser.newGuestRequest();
    try {
      return await fn(req);
    } finally {
      await req.dispose();
    }
  }

  return {
    url: (path) => resolve(path).toString(),

    health: (urls) => checkPages(page, urls.map((u) => resolve(u).toString()), browser, cfg.PW_ALLOWED_ORIGINS),

    async cache(urls, opts = {}) {
      const requests = Math.min(Math.max(opts.requests ?? 2, 2), 5);
      const run = async (req: Parameters<typeof checkUrlCache>[0]) => {
        const out: UrlReport[] = [];
        for (const u of urls) out.push(await checkUrlCache(req, resolve(u).toString(), requests));
        return out;
      };
      return opts.withSession ? run(page.request) : withGuestRequest(run);
    },

    async graphql(query, variables, opts = {}) {
      const endpoint = endpointFor(opts.storeUrl);
      const r = await withGuestRequest((req) =>
        graphqlRequest(req, endpoint, query, variables, opts.method ?? 'POST', opts.storeCode),
      );
      return {
        status: r.status,
        ms: r.ms,
        data: r.data,
        errors: [
          ...(r.transportError ? [{ message: r.transportError }] : []),
          ...r.errors.map((e) => ({ message: e.message, category: e.extensions?.category, path: e.path?.join('.') })),
        ],
      };
    },

    async graphqlChecks(opts = {}) {
      const endpoint = endpointFor(opts.storeUrl);
      const checks = opts.checks?.filter((c) => (GRAPHQL_CHECKS as readonly string[]).includes(c));
      return withGuestRequest((req) =>
        runGraphqlPresets(req, { endpoint, checks, sku: opts.sku, storeCode: opts.storeCode }),
      );
    },

    async checkout(opts) {
      const productUrl = resolve(opts.productUrl).toString();
      return browser.withIsolatedPage((guestPage, drainErrors) =>
        magentoGuestCheckout(guestPage, {
          ...opts,
          productUrl,
          stepTimeoutMs: cfg.PW_NAV_TIMEOUT_MS,
          drainConsole: drainErrors,
          afterNavigate: (p) =>
            cfg.PW_COOKIE_ACCEPT.length > 0
              ? acceptCookieBanner(p, cfg.PW_COOKIE_ACCEPT, cfg.PW_COOKIE_WAIT_MS)
              : Promise.resolve(undefined),
        }),
      );
    },

    async cart() {
      const res = await page.request.get(
        new URL('/customer/section/load/?sections=cart&force_new_section_timestamp=true', currentOrigin()).toString(),
        { headers: { 'X-Requested-With': 'XMLHttpRequest' }, maxRedirects: 0 },
      );
      if (!res.ok()) return null;
      const cart = ((await res.json().catch(() => ({}))) as { cart?: { summary_count?: number; subtotal?: string } }).cart;
      if (!cart?.summary_count) return null;
      return { items: cart.summary_count, subtotal: (cart.subtotal ?? '').replace(/<[^>]*>/g, '').trim() };
    },
  };
}
