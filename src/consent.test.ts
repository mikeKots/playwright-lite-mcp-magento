import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acceptCookieBanner } from './consent.js';

const NAMES = ['Accept & Close', 'Accept all'];

// The banner is added after a delay, like real consent scripts that render after DOMContentLoaded.
const bannerPage = (delayMs: number) => `
  <p id="state">pending</p>
  <script>
    setTimeout(() => {
      const b = document.createElement('button');
      b.textContent = 'Accept & Close';
      b.onclick = () => { document.getElementById('state').textContent = 'accepted'; b.remove(); };
      document.body.append(b);
    }, ${delayMs});
  </script>`;

describe('acceptCookieBanner', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
  });

  it('clicks a banner button that appears after the page loaded', async () => {
    await page.setContent(bannerPage(300));
    const clicked = await acceptCookieBanner(page, NAMES, 2_000);
    expect(clicked).toBe('Accept & Close');
    await expect.poll(() => page.locator('#state').textContent()).toBe('accepted');
  });

  it('returns undefined without throwing when no banner shows up in time', async () => {
    await page.setContent('<p>no banner</p>');
    const started = Date.now();
    expect(await acceptCookieBanner(page, NAMES, 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does nothing when no button names are configured', async () => {
    await page.setContent(bannerPage(0));
    expect(await acceptCookieBanner(page, [], 1_000)).toBeUndefined();
    expect(await page.locator('#state').textContent()).toBe('pending');
  });
});
