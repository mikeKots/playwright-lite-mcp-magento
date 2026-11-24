import {
  chromium,
  firefox,
  request,
  webkit,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type { Config } from './config.js';
import { acceptCookieBanner } from './consent.js';
import type { Logger } from './logger.js';
import { isUrlAllowed } from './security.js';

const ENGINES = { chromium, firefox, webkit } as const;
const MAX_BUFFERED_ERRORS = 50;
const MAX_ERROR_LENGTH = 500;

/**
 * One browser process shared by several sessions (HTTP transport): launched on first use,
 * relaunched after a crash. Sessions get their own contexts, so cookies and carts never mix.
 */
export class SharedBrowser {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  get(): Promise<Browser> {
    if (this.browser?.isConnected()) return Promise.resolve(this.browser);
    this.launching ??= ENGINES[this.cfg.PW_BROWSER]
      .launch({ headless: this.cfg.PW_HEADLESS })
      .then((browser) => {
        this.log.info('launched shared browser', { engine: this.cfg.PW_BROWSER, headless: this.cfg.PW_HEADLESS });
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.launching = undefined;
      });
    return this.launching;
  }

  async close(): Promise<void> {
    const browser = this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }
}

/**
 * Owns one browser (or uses a SharedBrowser's), one context and one page.
 * Everything is created lazily on the first tool call (a fast MCP handshake),
 * and re-created automatically if the browser crashes or the page is closed.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private starting: Promise<Page> | undefined;
  private errors: string[] = [];
  private consentGiven = false;
  private onDisconnect: (() => void) | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
    /** When set, the browser process belongs to it: close() then closes only this session's context. */
    private readonly shared?: SharedBrowser,
  ) {}

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    // Concurrent callers share one startup instead of launching two browsers.
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Returns console/page errors collected since the previous call and clears the buffer. */
  drainErrors(): string[] {
    const collected = this.errors;
    this.errors = [];
    return collected;
  }

  /**
   * Clicks the configured cookie-consent button (PW_COOKIE_ACCEPT) after a navigation.
   * Consent lives in the context's cookies, so once accepted the wait is skipped until reset.
   */
  async acceptCookies(page: Page): Promise<string | undefined> {
    if (this.consentGiven || this.cfg.PW_COOKIE_ACCEPT.length === 0) return undefined;
    const clicked = await acceptCookieBanner(page, this.cfg.PW_COOKIE_ACCEPT, this.cfg.PW_COOKIE_WAIT_MS);
    if (clicked) {
      this.consentGiven = true;
      this.log.info('cookie banner accepted', { button: clicked });
    }
    return clicked;
  }

  /** Drops cookies, storage and the page, keeping the browser process warm. */
  async reset(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.errors = [];
    this.consentGiven = false;
    await context?.close().catch(() => undefined);
  }

  /**
   * Runs `fn` on a page in a temporary context: a fresh guest (no cookies, no PW_STORAGE_STATE)
   * with the same allowlist guard, closed afterwards. The session's own page is not touched,
   * so a browser_run script can start a guest checkout without losing its page.
   */
  async withIsolatedPage<T>(fn: (page: Page, drainErrors: () => string[]) => Promise<T>): Promise<T> {
    const browser = this.browser?.isConnected() ? this.browser : await this.launchBrowser();
    const context = await this.buildContext(browser, undefined);
    let errors: string[] = [];
    try {
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`.slice(0, MAX_ERROR_LENGTH));
      });
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`.slice(0, MAX_ERROR_LENGTH)));
      const drain = () => {
        const collected = errors;
        errors = [];
        return collected;
      };
      return await fn(page, drain);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Cookie-less HTTP client for guest checks (cache, GraphQL). The caller must dispose() it. */
  newGuestRequest(): Promise<APIRequestContext> {
    return request.newContext({
      timeout: this.cfg.PW_NAV_TIMEOUT_MS,
      ignoreHTTPSErrors: this.cfg.PW_IGNORE_HTTPS_ERRORS,
    });
  }

  async close(): Promise<void> {
    await this.reset();
    const browser = this.browser;
    this.browser = undefined;
    if (this.onDisconnect) browser?.off('disconnected', this.onDisconnect);
    this.onDisconnect = undefined;
    if (!this.shared) await browser?.close().catch(() => undefined);
  }

  private async start(): Promise<Page> {
    const browser = this.browser?.isConnected() ? this.browser : await this.launchBrowser();
    const context = this.context ?? (await this.createContext(browser));
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.pushError(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => this.pushError(`pageerror: ${err.message}`));
    this.page = page;
    return page;
  }

  private async launchBrowser(): Promise<Browser> {
    let browser: Browser;
    if (this.shared) {
      browser = await this.shared.get();
    } else {
      this.log.info('launching browser', { engine: this.cfg.PW_BROWSER, headless: this.cfg.PW_HEADLESS });
      browser = await ENGINES[this.cfg.PW_BROWSER].launch({ headless: this.cfg.PW_HEADLESS });
    }
    if (this.browser === browser) return browser;
    // A shared browser outlives this session: the listener is removed again in close().
    if (this.onDisconnect) this.browser?.off('disconnected', this.onDisconnect);
    const onDisconnect = () => {
      if (this.browser !== browser) return;
      this.log.warn('browser disconnected, it will be relaunched on the next tool call');
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.consentGiven = false;
    };
    browser.on('disconnected', onDisconnect);
    this.onDisconnect = onDisconnect;
    this.browser = browser;
    return browser;
  }

  private async createContext(browser: Browser): Promise<BrowserContext> {
    const context = await this.buildContext(browser, this.cfg.PW_STORAGE_STATE);
    context.on('close', () => {
      if (this.context !== context) return;
      this.context = undefined;
      this.page = undefined;
      this.consentGiven = false;
    });
    this.context = context;
    return context;
  }

  /** A context with timeouts and the navigation allowlist guard, not registered as the session context. */
  private async buildContext(browser: Browser, storageState: string | undefined): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      storageState,
      ignoreHTTPSErrors: this.cfg.PW_IGNORE_HTTPS_ERRORS,
    });
    context.setDefaultTimeout(this.cfg.PW_ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(this.cfg.PW_NAV_TIMEOUT_MS);

    // Second line of defence: tool inputs are checked in tools.ts, but a click or a
    // server redirect can still take the page elsewhere. Block top-level navigations
    // to non-allowlisted origins; iframes and sub-resources (CDNs, payment widgets) pass.
    await context.route('**/*', async (route) => {
      const request = route.request();
      let isTopLevelNavigation = false;
      try {
        isTopLevelNavigation = request.isNavigationRequest() && request.frame().parentFrame() === null;
      } catch {
        // Service-worker requests have no frame; treat them as sub-resources.
      }
      if (!isTopLevelNavigation) return route.continue();
      if (!isUrlAllowed(request.url(), this.cfg.PW_ALLOWED_ORIGINS)) {
        this.log.warn('blocked navigation to non-allowlisted origin', { url: request.url() });
        return route.abort('blockedbyclient');
      }
      // Playwright routes only the first request of a redirect chain, so a 302 from an
      // allowlisted page could silently land elsewhere. Fetch without following redirects,
      // check the Location target, and hand the response back to the browser: it then
      // requests the next hop, which passes through this handler again.
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0 });
      } catch (err) {
        this.log.warn('navigation fetch failed', { url: request.url(), error: String(err) });
        return route.abort('failed');
      }
      const location = response.headers()['location'];
      if (response.status() >= 300 && response.status() < 400 && location) {
        const next = new URL(location, request.url()).toString();
        if (!isUrlAllowed(next, this.cfg.PW_ALLOWED_ORIGINS)) {
          this.log.warn('blocked redirect to non-allowlisted origin', { from: request.url(), to: next });
          return route.abort('blockedbyclient');
        }
      }
      return route.fulfill({ response });
    });
    return context;
  }

  private pushError(message: string): void {
    if (this.errors.length >= MAX_BUFFERED_ERRORS) this.errors.shift();
    this.errors.push(message.slice(0, MAX_ERROR_LENGTH));
  }
}
