import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrowserSession } from './browser.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { unsupportedHint } from './magento.js';
import { Mutex } from './mutex.js';
import { registerTools } from './tools.js';

// magento_guest_checkout against a fake store that reproduces the Magento markup the tool relies on:
// #product_addtocart_form, customer-data cart section, Magento_Checkout shipping/payment steps,
// the totals table and the success page. The real thing is covered by sample-store/check.sh.

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type Handler = (args: unknown) => Promise<Result>;

// Carts are per session cookie, like Magento's quote, so "fresh guest" behaviour is observable.
const store = {
  carts: new Map<string, number>(),
  skus: new Map<string, string[]>(),
  ordered: false,
  orderRequests: 0,
  nextSession: 1,
};
const sessionOf = (cookie = '') => /sid=(\w+)/.exec(cookie)?.[1];

const PRODUCT = (form: string) => `<title>Product</title><h1>Fake Duffle Bag</h1>
  <form id="product_addtocart_form" method="post" action="/checkout/cart/add">
    ${form}
    <input name="qty" value="1">
    <button type="submit" id="product-addtocart-button">Add to Cart</button>
  </form>`;

// A configurable product: Color (attribute 93: Purple 57, White 59) x Size (143: XS 166, M 168).
// White/M is out of stock. Variant SKUs: T-<size>-<color>.
const COLOR = { 57: 'Purple', 59: 'White' } as Record<number, string>;
const SIZE = { 166: 'XS', 168: 'M' } as Record<number, string>;
const CONFIGURABLE = {
  __typename: 'ConfigurableProduct',
  sku: 'T',
  configurable_options: [
    { attribute_id: '93', attribute_code: 'color', label: 'Color', values: [{ value_index: 57, label: 'Purple' }, { value_index: 59, label: 'White' }] },
    { attribute_id: '143', attribute_code: 'size', label: 'Size', values: [{ value_index: 166, label: 'XS' }, { value_index: 168, label: 'M' }] },
  ],
  variants: [57, 59].flatMap((color) =>
    [166, 168].map((size) => ({
      attributes: [{ code: 'color', value_index: color }, { code: 'size', value_index: size }],
      product: { sku: `T-${SIZE[size]}-${COLOR[color]}`, stock_status: color === 59 && size === 168 ? 'OUT_OF_STOCK' : 'IN_STOCK' },
    })),
  ),
};
// Hyvä renders the options as radio inputs inside the form.
const radios = (attr: number, values: Record<number, string>) =>
  Object.entries(values)
    .map(([v, l]) => `<label><input type="radio" name="super_attribute[${attr}]" value="${v}" required>${l}</label>`)
    .join('');
// Luma renders swatches with JS after load; clicking one fills an input in the form.
const LUMA_SWATCHES = `<div class="swatch-opt"></div><script>setTimeout(() => {
  const html = [[93, ${JSON.stringify(COLOR)}], [143, ${JSON.stringify(SIZE)}]].map(([id, values]) =>
    '<div class="swatch-attribute" data-attribute-id="' + id + '">' +
      Object.entries(values).map(([v, l]) => '<div class="swatch-option" data-option-id="' + v + '">' + l + '</div>').join('') +
      '<input class="super-attribute-select" name="super_attribute[' + id + ']" type="text" style="width:0;opacity:0">' +
    '</div>').join('');
  document.querySelector('.swatch-opt').innerHTML = html;
  document.querySelectorAll('.swatch-option').forEach((el) => el.addEventListener('click', () => {
    el.closest('.swatch-attribute').querySelector('input').value = el.dataset.optionId;
  }));
}, 200)</script>`;

const CHECKOUT = `<title>Checkout</title>
<div class="loading-mask" style="display:none">Loading...</div>
<div id="shipping">
  <input id="customer-email" type="email">
  <form id="shipping-new-address-form">
    <input name="firstname"><input name="lastname"><input name="street[0]">
    <select name="country_id"><option value="US">United States</option><option value="DE">Germany</option></select>
    <select name="region_id"><option value="">Please select</option><option value="57">Texas</option></select>
    <input name="region" style="display:none">
    <input name="city"><input name="postcode"><input name="telephone">
  </form>
  <div id="checkout-shipping-method-load"><table><tbody></tbody></table></div>
  <div id="shipping-method-buttons-container"><button data-role="opc-continue">Next</button></div>
</div>
<div id="payment" style="display:none">
  <div id="checkout-payment-method-load">
    <div class="payment-method"><input type="radio" name="payment[method]" value="checkmo" id="checkmo">
      <label for="checkmo">Check / Money order</label><button class="action checkout">Place Order</button></div>
    <div class="payment-method"><input type="radio" name="payment[method]" value="banktransfer" id="banktransfer">
      <label for="banktransfer">Bank Transfer</label><button class="action checkout">Place Order</button></div>
  </div>
</div>
<div class="opc-block-summary"><table class="table-totals"><tbody>
  <tr><th>Cart Subtotal</th><td><span class="price">$34.00</span></td></tr>
  <tr><th>Shipping</th><td><span class="price" id="ship">$0.00</span></td></tr>
  <tr><th>Order Total</th><td><span class="price" id="total">$34.00</span></td></tr>
</tbody></table></div>
<script>
  console.error('checkout widget warning');
  fetch('/rest/default/V1/broken');
  const loader = document.querySelector('.loading-mask');
  const rates = { flatrate_flatrate: ['Flat Rate', 'Fixed', 5], freeshipping_freeshipping: ['Free Shipping', 'Free', 0] };
  const money = (n) => '$' + n.toFixed(2);
  document.querySelector('[name=telephone]').addEventListener('blur', () => {
    loader.style.display = 'block';
    setTimeout(() => {
      document.querySelector('#checkout-shipping-method-load tbody').innerHTML = Object.entries(rates).map(([code, [carrier, method, price]]) =>
        '<tr class="row"><td class="col col-method"><input type="radio" name="ko_unique" value="' + code + '"></td>' +
        '<td class="col col-price"><span class="price">' + money(price) + '</span></td>' +
        '<td class="col col-method">' + method + '</td><td class="col col-carrier">' + carrier + '</td></tr>').join('');
      document.querySelectorAll('#checkout-shipping-method-load input').forEach((r) => r.addEventListener('change', () => {
        const price = rates[r.value][2];
        document.querySelector('#ship').textContent = money(price);
        document.querySelector('#total').textContent = money(34 + price);
      }));
      loader.style.display = 'none';
    }, 300);
  });
  document.querySelector('[data-role=opc-continue]').addEventListener('click', () => {
    document.querySelector('#shipping').style.display = 'none';
    document.querySelector('#payment').style.display = 'block';
  });
  document.querySelectorAll('.payment-method input').forEach((r) => r.addEventListener('change', () => {
    document.querySelectorAll('.payment-method').forEach((m) => m.classList.toggle('_active', m.contains(r)));
  }));
  document.querySelectorAll('button.action.checkout').forEach((b) => b.addEventListener('click', async () => {
    await fetch('/order', { method: 'POST' });
    // Real Magento refreshes totals once more; the quote is closed by then and answers 404.
    await fetch('/rest/default/V1/guest-carts/abc123/totals');
    location.href = '/checkout/onepage/success/';
  }));
</script>`;

function startStore(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (body: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(body);
    const sid = sessionOf(req.headers.cookie);
    const qty = (sid && store.carts.get(sid)) || 0;
    switch (url.pathname) {
      case '/simple.html':
        return html(PRODUCT(''));
      case '/swatches.html':
        // Luma: swatch inputs do not exist when the page loads (so the pre-check misses them); jQuery
        // validation then blocks the submit and marks the field with .mage-error.
        return html(
          PRODUCT('<div class="swatch-opt"></div>') +
            `<script>document.querySelector('#product_addtocart_form').addEventListener('submit', (e) => {
              e.preventDefault();
              document.querySelector('.swatch-opt').innerHTML =
                '<input type="hidden" name="super_attribute[93]" class="mage-error"><div class="mage-error">This is a required field.</div>';
            });</script>`,
        );
      case '/radios.html':
      case '/wrong-variant.html':
        return html(PRODUCT(radios(93, COLOR) + radios(143, SIZE)));
      case '/luma-swatches.html':
        return html(PRODUCT(LUMA_SWATCHES));
      case '/graphql': {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const { variables } = JSON.parse(body) as { variables: { url?: string } };
          const product = /radios|luma-swatches|wrong-variant/.test(variables.url ?? '')
            ? CONFIGURABLE
            : { __typename: 'SimpleProduct', sku: 'SIMPLE' };
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { route: product } }));
        });
        return;
      }
      case '/configurable.html':
        return html(PRODUCT('<select name="super_attribute[93]" required><option value="">Color</option></select>'));
      case '/checkout/cart/add': {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const session = sid ?? `s${store.nextSession++}`;
          const form = new URLSearchParams(body);
          store.carts.set(session, (store.carts.get(session) ?? 0) + Number(form.get('qty') ?? 1));
          const color = Number(form.get('super_attribute[93]'));
          const size = Number(form.get('super_attribute[143]'));
          // "Theme bug" fixture: this page always adds XS/Purple, whatever was chosen.
          const sku = (req.headers.referer ?? '').includes('wrong-variant')
            ? 'T-XS-Purple'
            : color && size
              ? `T-${SIZE[size]}-${COLOR[color]}`
              : 'SIMPLE';
          store.skus.set(session, [...(store.skus.get(session) ?? []), sku]);
          res.writeHead(302, { location: '/checkout/cart/', 'set-cookie': `sid=${session}; Path=/` }).end();
        });
        return;
      }
      case '/checkout/cart/':
        return html('<title>Cart</title><h1>Shopping Cart</h1>');
      case '/customer/section/load/':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            cart: {
              summary_count: qty,
              subtotal: `<span class="price">$${34 * qty}.00</span>`,
              items: ((sid && store.skus.get(sid)) || []).map((sku) => ({ product_sku: sku })),
            },
          }),
        );
      case '/checkout/':
        if (qty === 0) return res.writeHead(302, { location: '/checkout/cart/' }).end();
        return html(CHECKOUT);
      case '/order':
        store.orderRequests++;
        store.ordered = true;
        return res.writeHead(200).end('{}');
      case '/rest/default/V1/guest-carts/abc123/totals':
        return res.writeHead(store.ordered ? 404 : 200).end('{}');
      case '/rest/default/V1/broken':
        return res.writeHead(500).end('{}');
      case '/checkout/onepage/success/':
        return html('<title>Success</title><div class="checkout-success"><p>Your order # is: <span>000000042</span>.</p></div>');
      default:
        return html('not found', 404);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let site: Server;
let origin: string;
let call: (args: unknown) => Promise<Result & { text: string }>;
let tool: (name: string, args: unknown) => Promise<Result & { text: string }>;
let browser: BrowserSession;

beforeAll(async () => {
  site = await startStore();
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const cfg = loadConfig({
    PW_ALLOWED_ORIGINS: origin,
    LOG_LEVEL: 'error',
    PW_COOKIE_WAIT_MS: '0',
    PW_ACTION_TIMEOUT_MS: '3000',
    PW_NAV_TIMEOUT_MS: '5000',
    PW_ALLOW_SCRIPTS: 'true',
  });
  browser = new BrowserSession(cfg, createLogger(cfg.LOG_LEVEL));
  const tools = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  registerTools(fakeServer, { cfg, log: createLogger(cfg.LOG_LEVEL), browser, mutex: new Mutex() });
  tool = async (name, args) => {
    const result = await tools.get(name)!(args);
    return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
  };
  call = async (args) => {
    const result = await tools.get('magento_guest_checkout')!(args);
    return { ...result, text: result.content.map((c) => c.text ?? '').join('\n') };
  };
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => site.close(r));
});
beforeEach(() => {
  Object.assign(store, { carts: new Map(), skus: new Map(), ordered: false, orderRequests: 0 });
});

describe('magento_guest_checkout', () => {
  it('goes through checkout up to payment and reports totals, methods and store errors without ordering', async () => {
    const r = await call({ productUrl: `${origin}/simple.html` });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Guest checkout: OK (stopped before Place Order');
    expect(r.text).toContain('Product: Fake Duffle Bag | cart: 1 item(s), subtotal $34.00');
    expect(r.text).toContain('flatrate_flatrate (Flat Rate - Fixed, $5.00); freeshipping_freeshipping (Free Shipping - Free, $0.00)');
    expect(r.text).toContain('Payment: checkmo | offered: checkmo, banktransfer');
    expect(r.text).toContain('Totals: Cart Subtotal $34.00 | Shipping $5.00 | Order Total $39.00');
    expect(r.text).toContain('[checkout_load] console: checkout widget warning');
    expect(r.text).toContain('500 GET /rest/default/V1/broken');
    expect(store.orderRequests).toBe(0);
  });

  it('places the order with the requested shipping and payment methods', async () => {
    const r = await call({
      productUrl: `${origin}/simple.html`,
      qty: 2,
      shippingMethod: 'freeshipping_freeshipping',
      paymentMethod: 'banktransfer',
      placeOrder: true,
    });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('cart: 2 item(s)');
    expect(r.text).toContain('Shipping: freeshipping_freeshipping');
    expect(r.text).toContain('Payment: banktransfer');
    expect(r.text).toContain('Order: #000000042');
    // The closed-quote 404 after Place Order is normal Magento behaviour and is not reported.
    expect(r.text).not.toContain('guest-carts');
    expect(store.orderRequests).toBe(1);
  });

  it('starts every call as a fresh guest: the cart of the previous call is gone', async () => {
    await call({ productUrl: `${origin}/simple.html` });
    const fresh = await call({ productUrl: `${origin}/simple.html` });
    expect(fresh.text).toContain('cart: 1 item(s)');
    const kept = await call({ productUrl: `${origin}/simple.html`, keepSession: true });
    expect(kept.text).toContain('cart: 2 item(s)');
  });

  it('fails fast with an explanation for a product with required options', async () => {
    const started = Date.now();
    const r = await call({ productUrl: `${origin}/configurable.html` });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('FAILED at add_to_cart: Product has options to choose');
    expect(r.text).toContain('Use browser_run to script it.');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('explains options also when they are rendered after load (Luma swatches)', async () => {
    const r = await call({ productUrl: `${origin}/swatches.html` });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Required fields not filled: super_attribute[93]');
    expect(r.text).toContain('Product has options to choose');
  });

  it('chooses configurable options on Hyvä-style radios and checks the variant in the cart', async () => {
    const first = await call({ productUrl: `${origin}/radios.html`, options: 'first' });
    expect(first.isError).toBeUndefined();
    expect(first.text).toContain('[Color: Purple, Size: XS (T-XS-Purple)] | cart: 1 item(s)');
    const chosen = await call({ productUrl: `${origin}/radios.html`, options: { size: 'm', Color: 'Purple' } });
    expect(chosen.text).toContain('[Color: Purple, Size: M (T-M-Purple)]');
  });

  it('clicks Luma swatches that are rendered after load', async () => {
    const r = await call({ productUrl: `${origin}/luma-swatches.html`, options: { Color: 'White', Size: 'XS' } });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('[Color: White, Size: XS (T-XS-White)] | cart: 1 item(s)');
  });

  it('explains unknown values and out-of-stock combinations before touching the page', async () => {
    const unknown = await call({ productUrl: `${origin}/radios.html`, options: { Size: 'XXL' } });
    expect(unknown.text).toContain('"XXL" is not a value of Size. Options: Color (Purple, White); Size (XS, M)');
    const soldOut = await call({ productUrl: `${origin}/radios.html`, options: { Color: 'White', Size: 'M' } });
    expect(soldOut.text).toContain('Color White, Size M is out of stock (T-M-White)');
    // Only one attribute given: the other one comes from the first in-stock match.
    const partial = await call({ productUrl: `${origin}/radios.html`, options: { Color: 'White' } });
    expect(partial.text).toContain('(T-XS-White)');
  });

  it('catches a store that adds a different variant than the one chosen', async () => {
    const r = await call({ productUrl: `${origin}/wrong-variant.html`, options: { Size: 'M' } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Cart holds T-XS-Purple instead of the chosen variant T-M-Purple');
  });

  it('lists the offered shipping methods when the requested one is missing', async () => {
    const r = await call({ productUrl: `${origin}/simple.html`, shippingMethod: 'ups_GND' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('FAILED at shipping_method');
    expect(r.text).toContain('Available: flatrate_flatrate, freeshipping_freeshipping');
  });

  it('refuses a product URL outside the allowlist', async () => {
    const r = await call({ productUrl: 'https://evil.example/product.html' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not in PW_ALLOWED_ORIGINS');
  });
});

describe('browser_run magento helpers (code mode)', () => {
  const script = (code: string) => tool('browser_run', { code, timeoutMs: 30_000 });
  const resultOf = (text: string) => JSON.parse(text.split('\n\nURL:')[0]!);

  it('runs a guest checkout in an isolated context and returns plain data, leaving the script page alone', async () => {
    const r = await script(`
      await page.goto('${origin}/simple.html');
      const report = await magento.checkout({ productUrl: '/simple.html', shippingMethod: 'freeshipping_freeshipping' });
      return {
        ok: report.ok,
        total: report.totals.find(([k]) => k === 'Order Total')[1],
        consoleSteps: report.consoleErrors.map((e) => e.split(']')[0] + ']'),
        stillOn: new URL(page.url()).pathname,
        ownCart: await magento.cart(),
      };
    `);
    expect(r.isError).toBeUndefined();
    expect(resultOf(r.text)).toEqual({
      ok: true,
      total: '$34.00',
      consoleSteps: expect.arrayContaining(['[checkout_load]']),
      stillOn: '/simple.html',
      ownCart: null, // the checkout's cart lived in the temporary guest context
    });
  });

  it('loops over several checks in one call: health, cart of the script session', async () => {
    const r = await script(`
      await page.goto('${origin}/simple.html');
      const health = await magento.health(['/simple.html', '/missing']);
      await page.goto('${origin}/simple.html'); // health() navigates the script's page
      await page.locator('#product-addtocart-button').click();
      await page.waitForURL('**/checkout/cart/');
      return { health: health.map((h) => h.status + ' ' + h.ok), cart: await magento.cart() };
    `);
    expect(resultOf(r.text)).toEqual({ health: ['200 true', '404 false'], cart: { items: 1, subtotal: '$34.00' } });
  });

  it('keeps the allowlist and explains relative URLs without an open store', async () => {
    const outside = await script(`return await magento.checkout({ productUrl: 'https://evil.example/p.html' });`);
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('not in PW_ALLOWED_ORIGINS');
    await tool('browser_reset', {});
    const relative = await script(`return magento.url('/checkout/');`);
    expect(relative.isError).toBe(true);
    expect(relative.text).toContain('pass absolute URLs or call page.goto');
  });
});

describe('unsupportedHint', () => {
  it('points to browser_run only when code mode is on', () => {
    expect(unsupportedHint(true)).toBe('Use browser_run to script it.');
    expect(unsupportedHint(false)).toContain('needs PW_ALLOW_SCRIPTS=true, stdio only');
    expect(unsupportedHint(undefined)).toContain('test it manually');
  });
});
