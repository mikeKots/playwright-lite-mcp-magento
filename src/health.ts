import type { Page } from 'playwright';
import type { BrowserSession } from './browser.js';
import { describeError } from './errors.js';
import { assertUrlAllowed } from './security.js';

export interface PageHealth {
  url: string;
  ok: boolean;
  status: number;
  ms: number;
  /** JS console errors and uncaught exceptions while loading the page. */
  errors: string[];
  /** Set when the page could not be opened at all (not allowlisted, DNS, timeout). */
  failure?: string;
}

/**
 * page.goto that leaves the page in a stable state when the navigation is blocked or fails:
 * Chromium then loads its error page asynchronously, and that late navigation would
 * interrupt the agent's NEXT goto. Waiting for it here keeps the following call clean.
 */
export async function gotoSettled(page: Page, url: string, waitUntil: 'domcontentloaded' | 'load') {
  try {
    return await page.goto(url, { waitUntil });
  } catch (err) {
    // A blocked or failed navigation is followed by the browser's own error-page navigation.
    // Wait for it (briefly) unless it already happened, so it cannot hit the next goto.
    if (!page.url().startsWith('chrome-error:')) {
      await page
        .waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 1_000 })
        .catch(() => undefined);
    }
    throw err;
  }
}

/** Opens each URL in turn: HTTP status, load time and JS errors. A page is ok when status < 400 and no JS errors. */
export async function checkPages(
  page: Page,
  urls: string[],
  browser: BrowserSession,
  allowedOrigins: string[],
): Promise<PageHealth[]> {
  const results: PageHealth[] = [];
  for (const raw of urls) {
    const started = Date.now();
    try {
      const url = assertUrlAllowed(raw, allowedOrigins);
      browser.drainErrors();
      const response = await gotoSettled(page, url.toString(), 'load');
      const ms = Date.now() - started;
      await browser.acceptCookies(page);
      const errors = browser.drainErrors();
      const status = response?.status() ?? 0;
      results.push({ url: raw, ok: status > 0 && status < 400 && errors.length === 0, status, ms, errors });
    } catch (err) {
      results.push({ url: raw, ok: false, status: 0, ms: Date.now() - started, errors: [], failure: describeError(err) });
    }
  }
  return results;
}
