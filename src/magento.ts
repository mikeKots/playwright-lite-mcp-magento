import type { Locator, Page, Request, Response } from 'playwright';
import { ToolError, describeError } from './errors.js';

/**
 * Magento 2 / Adobe Commerce / Mage-OS guest checkout, driven through the real storefront UI.
 *
 * Works with any theme on the product page (Luma, Hyvä, most custom themes keep
 * #product-addtocart-button) and with the standard Magento_Checkout (Knockout) checkout,
 * which is also what Hyvä uses through hyva-themes/magento2-luma-checkout.
 * Hyvä Checkout and other one-step checkouts are detected and reported as unsupported.
 *
 * The cart state is read from Magento's customer-data endpoint, not from theme markup,
 * so "was the product added?" does not depend on how the mini-cart looks.
 */

export interface Address {
  firstname: string;
  lastname: string;
  street: string;
  city: string;
  postcode: string;
  countryId: string;
  region: string;
  telephone: string;
}

export interface GuestCheckoutOptions {
  productUrl: string;
  qty?: number;
  email?: string;
  address?: Partial<Address>;
  /** carrier_method code, e.g. "flatrate_flatrate". Default: first available method. */
  shippingMethod?: string;
  /** Payment method code, e.g. "checkmo". Default: "checkmo", else the first available method. */
  paymentMethod?: string;
  placeOrder?: boolean;
  /** Limit for slow steps: checkout page load, shipping rates, order placement. */
  stepTimeoutMs: number;
  /** Called after each page load, e.g. to accept a cookie banner that would cover the buttons. */
  afterNavigate?: (page: Page) => Promise<unknown>;
  /** Returns console errors collected since the previous call; used to attribute errors to steps. */
  drainConsole?: () => string[];
}

export interface CheckoutReport {
  ok: boolean;
  failedStep?: string;
  error?: string;
  product?: string;
  cart?: { items: number; subtotal: string };
  shippingMethods: Array<{ code: string; label: string; price: string }>;
  shippingMethod?: string;
  paymentMethods: string[];
  paymentMethod?: string;
  totals: Array<[string, string]>;
  orderNumber?: string;
  steps: Array<{ name: string; ms: number }>;
  failedRequests: string[];
  /** Console errors prefixed with the step they happened in, e.g. "[payment] ...". */
  consoleErrors: string[];
}

export const DEFAULT_ADDRESS: Address = {
  firstname: 'Test',
  lastname: 'Guest',
  street: '123 Main Street',
  city: 'Austin',
  postcode: '78701',
  countryId: 'US',
  region: 'Texas',
  telephone: '5125550100',
};

const CART_SECTION = '/customer/section/load/?sections=cart&force_new_section_timestamp=true';
const LOADER = '.loading-mask, .loader, [data-role="loader"]';
const MAX_FAILED_REQUESTS = 20;
// Once an order exists Magento deactivates the quote, and the checkout page's last totals /
// payment-information refresh answers 404. That is normal, not a store bug.
const CLOSED_QUOTE_REQUEST = /\/V1\/guest-carts\/[^/]+\//;
const RESOURCE_404 = /^console: Failed to load resource: .*\b404\b/;

class StepError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

export async function magentoGuestCheckout(page: Page, opts: GuestCheckoutOptions): Promise<CheckoutReport> {
  const origin = new URL(opts.productUrl).origin;
  const address = { ...DEFAULT_ADDRESS, ...opts.address };
  const report: CheckoutReport = {
    ok: false,
    shippingMethods: [],
    paymentMethods: [],
    totals: [],
    steps: [],
    failedRequests: [],
    consoleErrors: [],
  };
  let orderSubmitted = false;
  let closedQuote404s = 0;
  opts.drainConsole?.();

  // HTTP errors of the store itself (XHR, scripts, styles) are often the actual checkout bug.
  const onResponse = (res: Response) => {
    if (orderSubmitted && res.status() === 404 && CLOSED_QUOTE_REQUEST.test(res.url())) {
      closedQuote404s++;
      return;
    }
    if (res.status() >= 400 && sameOrigin(res.url(), origin)) {
      pushLimited(report.failedRequests, `${res.status()} ${res.request().method()} ${shortUrl(res.url())}`);
    }
  };
  const onRequestFailed = (req: Request) => {
    if (sameOrigin(req.url(), origin) && req.failure()?.errorText !== 'net::ERR_ABORTED') {
      pushLimited(report.failedRequests, `${req.failure()?.errorText ?? 'failed'} ${req.method()} ${shortUrl(req.url())}`);
    }
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } catch (err) {
      throw err instanceof StepError ? err : new StepError(name, describeError(err));
    } finally {
      report.steps.push({ name, ms: Date.now() - started });
      collectConsole(name);
    }
  }

  function collectConsole(stepName: string): void {
    for (const message of opts.drainConsole?.() ?? []) {
      // Drop the browser's own echo of each expected closed-quote 404.
      if (closedQuote404s > 0 && RESOURCE_404.test(message)) {
        closedQuote404s--;
        continue;
      }
      report.consoleErrors.push(`[${stepName}] ${message}`);
    }
  }

  try {
    await step('add_to_cart', async () => {
      await page.goto(opts.productUrl, { waitUntil: 'domcontentloaded' });
      await opts.afterNavigate?.(page);
      report.product = (await textOf(page.locator('h1').first())) ?? undefined;
      const button = page.locator('#product-addtocart-button').first();
      if ((await button.count()) === 0) {
        throw new StepError('add_to_cart', 'No #product-addtocart-button on the page: is this a product page?');
      }
      const optionFields = await page
        .locator('#product_addtocart_form [name^="super_attribute"], #product_addtocart_form [name^="bundle_option"]')
        .count();
      if (optionFields > 0) {
        throw new StepError(
          'add_to_cart',
          'Product has options to choose (configurable/bundle): pass a simple product URL, ' +
            'or use browser_run to pick the options first.',
        );
      }
      if (opts.qty !== undefined) {
        const qty = page.locator('#product_addtocart_form input[name="qty"], input[name="qty"]').first();
        if ((await qty.count()) > 0) await qty.fill(String(opts.qty));
      }
      await button.click();
      const cart = await waitForCart(page, origin, opts.stepTimeoutMs, () => invalidFields(page));
      if (!cart) {
        const invalid = await invalidFields(page);
        const messages = await visibleMessages(page);
        throw new StepError(
          'add_to_cart',
          'Cart is still empty after clicking Add to Cart.' +
            (invalid ? ` Required fields not filled: ${invalid}.` : '') +
            (messages ? ` Store says: ${messages}` : ''),
        );
      }
      report.cart = cart;
    });

    await step('checkout_load', async () => {
      await page.goto(new URL('/checkout/', origin).toString(), { waitUntil: 'domcontentloaded' });
      await opts.afterNavigate?.(page);
      const form = page.locator('#shipping-new-address-form');
      try {
        await form.waitFor({ state: 'visible', timeout: opts.stepTimeoutMs });
      } catch {
        const url = new URL(page.url());
        if (url.pathname.includes('/checkout/cart')) {
          throw new StepError('checkout_load', 'Store redirected to the cart: the cart is empty or checkout is disabled.');
        }
        if ((await page.locator('#hyva-checkout-main, [wire\\:id]').count()) > 0) {
          throw new StepError(
            'checkout_load',
            'Hyvä Checkout (Magewire) detected: only the standard Magento_Checkout is supported. Use browser_run.',
          );
        }
        throw new StepError('checkout_load', 'Shipping address form (#shipping-new-address-form) did not appear.');
      }
    });

    await step('shipping_address', async () => {
      const email = page.locator('#customer-email').first();
      await email.fill(opts.email ?? 'guest@example.com');
      const form = page.locator('#shipping-new-address-form');
      await form.locator('[name="firstname"]').fill(address.firstname);
      await form.locator('[name="lastname"]').fill(address.lastname);
      await form.locator('[name="street[0]"]').fill(address.street);
      await form.locator('select[name="country_id"]').selectOption(address.countryId);
      await waitForLoaders(page, opts.stepTimeoutMs);
      const regionSelect = form.locator('select[name="region_id"]');
      if (await regionSelect.isVisible()) {
        await regionSelect.selectOption({ label: address.region });
      } else {
        const regionInput = form.locator('input[name="region"]');
        if (await regionInput.isVisible()) await regionInput.fill(address.region);
      }
      await form.locator('[name="city"]').fill(address.city);
      await form.locator('[name="postcode"]').fill(address.postcode);
      await form.locator('[name="telephone"]').fill(address.telephone);
      // Rates are re-estimated on blur of the last field.
      await form.locator('[name="telephone"]').blur();
    });

    await step('shipping_method', async () => {
      const radios = page.locator('#checkout-shipping-method-load input[type="radio"]');
      try {
        await radios.first().waitFor({ state: 'attached', timeout: opts.stepTimeoutMs });
      } catch {
        const note = await textOf(page.locator('#checkout-shipping-method-load, .no-quotes-block').first());
        throw new StepError('shipping_method', `No shipping methods available${note ? `: ${note}` : ''}.`);
      }
      await waitForLoaders(page, opts.stepTimeoutMs);
      report.shippingMethods = await page.locator('#checkout-shipping-method-load tbody tr.row, #checkout-shipping-method-load tr').evaluateAll(
        (rows) =>
          rows
            .map((row) => {
              const radio = row.querySelector<HTMLInputElement>('input[type="radio"]');
              if (!radio) return undefined;
              const cell = (sel: string) => row.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
              return {
                code: radio.value,
                label: [cell('.col-carrier'), cell('td.col-method:not(:has(input))')].filter(Boolean).join(' - '),
                price: cell('.col-price'),
              };
            })
            .filter((m): m is { code: string; label: string; price: string } => m !== undefined),
      );
      const wanted = opts.shippingMethod ?? report.shippingMethods[0]?.code;
      if (!wanted || !report.shippingMethods.some((m) => m.code === wanted)) {
        const available = report.shippingMethods.map((m) => m.code).join(', ') || 'none';
        throw new StepError('shipping_method', `Shipping method "${wanted}" not offered. Available: ${available}.`);
      }
      await page.locator(`#checkout-shipping-method-load input[type="radio"][value="${cssString(wanted)}"]`).check();
      report.shippingMethod = wanted;
      await waitForLoaders(page, opts.stepTimeoutMs);
    });

    await step('payment', async () => {
      await page.locator('#shipping-method-buttons-container button[data-role="opc-continue"], button[data-role="opc-continue"]').first().click();
      const methods = page.locator('#checkout-payment-method-load input[type="radio"][name="payment[method]"]');
      try {
        await methods.first().waitFor({ state: 'attached', timeout: opts.stepTimeoutMs });
      } catch {
        const errors = await visibleMessages(page);
        throw new StepError('payment', `Payment step did not open${errors ? `: ${errors}` : ''}.`);
      }
      await waitForLoaders(page, opts.stepTimeoutMs);
      report.paymentMethods = await methods.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      const wanted =
        opts.paymentMethod ?? (report.paymentMethods.includes('checkmo') ? 'checkmo' : report.paymentMethods[0]);
      if (!wanted || !report.paymentMethods.includes(wanted)) {
        throw new StepError(
          'payment',
          `Payment method "${wanted}" not offered. Available: ${report.paymentMethods.join(', ') || 'none'}.`,
        );
      }
      const radio = methods.and(page.locator(`[value="${cssString(wanted)}"]`));
      // With a single method Magento hides the radio and pre-selects it.
      if (await radio.isVisible()) await radio.check();
      report.paymentMethod = wanted;
      await waitForLoaders(page, opts.stepTimeoutMs);
      report.totals = await readTotals(page);
    });

    if (opts.placeOrder) {
      await step('place_order', async () => {
        const placeButton = page.locator('.payment-method._active button.action.checkout').first();
        await placeButton.waitFor({ state: 'visible' });
        orderSubmitted = true;
        await placeButton.click();
        try {
          await page.waitForURL(/\/checkout\/onepage\/success/, { timeout: opts.stepTimeoutMs });
        } catch {
          const errors = await visibleMessages(page);
          throw new StepError('place_order', `No success page after Place Order${errors ? `: ${errors}` : ''}.`);
        }
        const fromLink = await textOf(page.locator('.checkout-success .order-number strong, .checkout-success a.order-number').first());
        const body = (await textOf(page.locator('.checkout-success, main, body').first())) ?? '';
        report.orderNumber = fromLink ?? body.match(/order\s*(?:number|#)[^0-9]*([0-9A-Z-]{3,})/i)?.[1];
      });
    }
    report.ok = true;
  } catch (err) {
    report.failedStep = err instanceof StepError ? err.step : 'unknown';
    report.error = err instanceof Error ? err.message : String(err);
  } finally {
    // Late errors (e.g. from the success page scripts) still belong to this run.
    await page.waitForLoadState('load', { timeout: 2_000 }).catch(() => undefined);
    collectConsole('after');
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
  return report;
}

export function formatCheckoutReport(r: CheckoutReport, placeOrder: boolean): string {
  const consoleErrors = r.consoleErrors;
  const lines: string[] = [];
  lines.push(
    r.ok
      ? `Guest checkout: OK${placeOrder ? '' : ' (stopped before Place Order; pass placeOrder: true to place it)'}`
      : `Guest checkout: FAILED at ${r.failedStep}: ${r.error}`,
  );
  if (r.product || r.cart) {
    lines.push(`Product: ${r.product ?? '?'}${r.cart ? ` | cart: ${r.cart.items} item(s), subtotal ${r.cart.subtotal}` : ''}`);
  }
  if (r.shippingMethods.length > 0) {
    const offered = r.shippingMethods.map((m) => `${m.code} (${m.label || '?'}, ${m.price || '?'})`).join('; ');
    lines.push(`Shipping: ${r.shippingMethod ?? 'not selected'} | offered: ${offered}`);
  }
  if (r.paymentMethods.length > 0) {
    lines.push(`Payment: ${r.paymentMethod ?? 'not selected'} | offered: ${r.paymentMethods.join(', ')}`);
  }
  if (r.totals.length > 0) lines.push(`Totals: ${r.totals.map(([k, v]) => `${k} ${v}`).join(' | ')}`);
  if (placeOrder && r.ok) lines.push(`Order: ${r.orderNumber ? `#${r.orderNumber}` : 'placed (number not found on success page)'}`);
  lines.push(`Steps: ${r.steps.map((s) => `${s.name} ${(s.ms / 1000).toFixed(1)}s`).join(', ')}`);
  lines.push(
    consoleErrors.length > 0
      ? `Console errors (${consoleErrors.length}):\n${consoleErrors.map((e) => `  - ${e}`).join('\n')}`
      : 'Console errors: none',
  );
  lines.push(
    r.failedRequests.length > 0
      ? `Failed requests (${r.failedRequests.length}):\n${r.failedRequests.map((e) => `  - ${e}`).join('\n')}`
      : 'Failed requests: none',
  );
  if (!r.ok) lines.push('The page is left at the failing step: call browser_snapshot or browser_screenshot to inspect it.');
  return lines.join('\n');
}

// ---------- helpers ----------

async function waitForCart(page: Page, origin: string, timeoutMs: number, abort: () => Promise<string | undefined>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A form that failed validation will never submit: stop instead of waiting for the timeout.
    if (await abort().catch(() => undefined)) return undefined;
    try {
      // page.request shares the context cookies, so this is the same session the browser has.
      const res = await page.request.get(new URL(CART_SECTION, origin).toString(), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        maxRedirects: 0,
      });
      if (res.ok()) {
        const cart = ((await res.json()) as { cart?: { summary_count?: number; subtotal?: string } }).cart;
        if (cart?.summary_count && cart.summary_count > 0) {
          return { items: cart.summary_count, subtotal: stripTags(cart.subtotal ?? '') };
        }
      }
    } catch {
      // Not JSON yet (page still navigating after a form POST): retry.
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function waitForLoaders(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForFunction(
      (sel) => [...document.querySelectorAll<HTMLElement>(sel)].every((el) => el.offsetParent === null),
      LOADER,
      { timeout: timeoutMs, polling: 200 },
    )
    .catch(() => {
      throw new ToolError('Checkout spinner did not disappear in time.');
    });
}

async function readTotals(page: Page): Promise<Array<[string, string]>> {
  const table = page.locator('.opc-block-summary table.table-totals').first();
  await table.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  return table.locator('tr').evaluateAll((rows) =>
    rows
      .map((row): [string, string] => {
        const clean = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        return [clean(row.querySelector('th')), clean(row.querySelector('td .price, td'))];
      })
      .filter(([label, value]) => label !== '' && value !== ''),
  );
}

/** Names of add-to-cart form fields that failed HTML5 or Magento (jQuery) validation. */
async function invalidFields(page: Page): Promise<string | undefined> {
  // page.evaluate does not wait for the form: after a redirect to the cart page it is simply gone.
  const names = await page
    .evaluate(() => {
      const form = document.querySelector('#product_addtocart_form');
      if (!form) return [];
      return [...form.querySelectorAll<HTMLInputElement>('input, select, textarea')]
        .filter((el) => el.matches(':invalid') || el.classList.contains('mage-error'))
        .map((el) => el.getAttribute('name') ?? el.id)
        .filter(Boolean);
    })
    .catch(() => [] as string[]);
  return names.length > 0 ? [...new Set(names)].join(', ') : undefined;
}

async function visibleMessages(page: Page): Promise<string | undefined> {
  const texts = await page
    .locator('.message-error, .message.error, .mage-error:not(input), [data-ui-id^="message-error"], .messages .message')
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .filter(Boolean),
    )
    .catch(() => [] as string[]);
  const unique = [...new Set(texts)].slice(0, 3).join(' | ');
  return unique || undefined;
}

async function textOf(locator: Locator): Promise<string | undefined> {
  if ((await locator.count()) === 0) return undefined;
  const value = (await locator.innerText({ timeout: 2_000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
  return value || undefined;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function shortUrl(url: string): string {
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  return path.length > 120 ? `${path.slice(0, 117)}...` : path;
}

function pushLimited(list: string[], item: string): void {
  if (list.length < MAX_FAILED_REQUESTS && !list.includes(item)) list.push(item);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
