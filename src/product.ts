import type { APIRequestContext, Page } from 'playwright';
import { readCacheStatus } from './cache.js';
import { describeError } from './errors.js';
import { graphqlRequest } from './graphql.js';

/**
 * Price and stock check: what the storefront API says (GraphQL, the same data a headless
 * frontend and the indexers produce) against what a guest sees on the product page.
 * Typical bugs it catches: a stale full page cache after a price change, a price indexer that
 * did not run, a special price or catalog rule missing on one side, "In stock" on the page for
 * a product GraphQL reports out of stock (or the other way round), a zero price, and SEO
 * structured data (JSON-LD, product:price meta) that disagrees with the page.
 */

export type ProductVerdict = 'OK' | 'MISMATCH' | 'UNKNOWN' | 'ERROR';

type Money = { value: number; currency: string };

/** Product as GraphQL reports it for a guest (default customer group). */
export interface ApiProduct {
  type: string;
  sku: string;
  name: string;
  stockStatus: string;
  onlyLeft?: number | null;
  minFinal: Money;
  minRegular: Money;
  maxFinal: Money;
  /** Configurable products: variants in stock / total. */
  variants?: { inStock: number; total: number };
}

/** Product as the page shows it. Prices are numbers parsed from the main product price box. */
export interface PageProduct {
  status: number;
  finalPrice?: number;
  /** Struck-through price shown next to a special price. */
  oldPrice?: number;
  priceText?: string;
  stock?: 'IN_STOCK' | 'OUT_OF_STOCK';
  stockText?: string;
  addToCart: boolean;
  /** JSON-LD offers and the product:price:amount meta tag. */
  structured: Array<{ source: string; price?: number; currency?: string; inStock?: boolean }>;
  cache?: string;
}

export interface ProductReport {
  url: string;
  verdict: ProductVerdict;
  api?: ApiProduct;
  page?: PageProduct;
  /** One line per failed check; these decide the verdict. */
  problems: string[];
  /** Informational lines that do not change the verdict. */
  notes: string[];
}

const PRODUCT_QUERY_FIELDS = `__typename
  ... on ProductInterface {
    sku name stock_status only_x_left_in_stock
    price_range {
      minimum_price { regular_price { value currency } final_price { value currency } }
      maximum_price { final_price { value currency } }
    }
  }
  ... on ConfigurableProduct { variants { product { stock_status } } }`;

interface RawProduct {
  __typename: string;
  sku: string;
  name: string;
  stock_status: string;
  only_x_left_in_stock?: number | null;
  price_range: {
    minimum_price: { regular_price: Money; final_price: Money };
    maximum_price: { final_price: Money };
  };
  variants?: Array<{ product: { stock_status: string } | null }>;
}

export interface ProductCheckOptions {
  /** Cookie-less HTTP client for GraphQL. */
  request: APIRequestContext;
  /** Runs the page part on a fresh guest page, so prices are the guest (NOT LOGGED IN) ones. */
  withGuestPage: <T>(fn: (page: Page) => Promise<T>) => Promise<T>;
  storeCode?: string;
  timeoutMs: number;
}

export async function checkProducts(urls: string[], opts: ProductCheckOptions): Promise<ProductReport[]> {
  return opts.withGuestPage(async (page) => {
    const reports: ProductReport[] = [];
    for (const url of urls) reports.push(await checkProduct(page, url, opts));
    return reports;
  });
}

async function checkProduct(page: Page, url: string, opts: ProductCheckOptions): Promise<ProductReport> {
  let api: ApiProduct;
  try {
    api = await loadApiProduct(opts.request, url, opts.storeCode);
  } catch (err) {
    return { url, verdict: 'ERROR', problems: [`GraphQL: ${describeError(err)}`], notes: [] };
  }
  let shown: PageProduct;
  try {
    shown = await readProductPage(page, url, opts.timeoutMs);
  } catch (err) {
    return { url, verdict: 'ERROR', api, problems: [`page: ${describeError(err)}`], notes: [] };
  }
  return compareProduct(url, api, shown);
}

// ---------- GraphQL side ----------

export async function loadApiProduct(request: APIRequestContext, productUrl: string, storeCode?: string): Promise<ApiProduct> {
  const url = new URL(productUrl);
  const endpoint = new URL('/graphql', url.origin).toString();
  const path = url.pathname.replace(/^\//, '');
  const gql = <T>(query: string, variables: Record<string, unknown>) =>
    graphqlRequest<T>(request, endpoint, query, variables, 'POST', storeCode);

  // `route` resolves any URL rewrite (Magento 2.4.5+); older stores fall back to the url_key.
  const routed = await gql<{ route: RawProduct | null }>(
    `query ($url: String!) { route(url: $url) { ${PRODUCT_QUERY_FIELDS} } }`,
    { url: path },
  );
  if (routed.transportError) throw new Error(routed.transportError);
  const route = routed.data?.route;
  if (route?.sku) return toApiProduct(route);
  if (route) throw new Error(`the URL is a ${route.__typename}, not a product`);

  const urlKey = path.split('/').pop()!.replace(/\.[a-z]+$/, '');
  const r = await gql<{ products: { items: RawProduct[] } }>(
    `query ($key: String!) { products(filter: { url_key: { eq: $key } }) { items { ${PRODUCT_QUERY_FIELDS} } } }`,
    { key: urlKey },
  );
  const raw = r.data?.products?.items?.[0];
  if (!raw) {
    throw new Error(r.transportError ?? r.errors[0]?.message ?? routed.errors[0]?.message ?? 'no product for this URL (route and url_key)');
  }
  return toApiProduct(raw);
}

function toApiProduct(raw: RawProduct): ApiProduct {
  const variants = raw.variants?.filter((v) => v.product);
  return {
    type: raw.__typename.replace(/Product$/, '').toLowerCase(),
    sku: raw.sku,
    name: raw.name,
    stockStatus: raw.stock_status,
    onlyLeft: raw.only_x_left_in_stock,
    minFinal: raw.price_range.minimum_price.final_price,
    minRegular: raw.price_range.minimum_price.regular_price,
    maxFinal: raw.price_range.maximum_price.final_price,
    variants: variants
      ? { inStock: variants.filter((v) => v.product!.stock_status === 'IN_STOCK').length, total: variants.length }
      : undefined,
  };
}

// ---------- page side ----------

export async function readProductPage(page: Page, url: string, timeoutMs: number): Promise<PageProduct> {
  const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  const status = response?.status() ?? 0;
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const cacheStatus = response ? readCacheStatus(await response.allHeaders()) : {};

  // Hyvä renders the main price with Alpine after load: wait (briefly) until it shows a digit.
  await page
    .waitForFunction(() => /\d/.test(document.querySelector('.product-info-main .price-box')?.textContent ?? ''), undefined, {
      timeout: Math.min(timeoutMs, 5_000),
    })
    .catch(() => undefined);

  const raw = await page.evaluate(readDom);
  return {
    status,
    finalPrice: raw.finalAmount ?? parsePrice(raw.finalText),
    oldPrice: raw.oldAmount ?? parsePrice(raw.oldText),
    priceText: raw.finalText?.replace(/\s+/g, ' ').trim() || undefined,
    stock: raw.stockClass === 'available' ? 'IN_STOCK' : raw.stockClass === 'unavailable' ? 'OUT_OF_STOCK' : undefined,
    stockText: raw.stockText || undefined,
    addToCart: raw.addToCart,
    structured: parseStructured(raw.jsonLd, raw.metaPrice, raw.metaCurrency),
    cache: cacheStatus.cache ? `${cacheStatus.cache} via ${cacheStatus.source}` : undefined,
  };
}

interface RawDom {
  finalAmount?: number;
  finalText?: string;
  oldAmount?: number;
  oldText?: string;
  stockClass?: 'available' | 'unavailable';
  stockText?: string;
  addToCart: boolean;
  jsonLd: string[];
  metaPrice?: string;
  metaCurrency?: string;
}

/**
 * Runs in the browser. The main product price box is the first .price-box in .product-info-main
 * (Luma and Hyvä) that is not part of a related/upsell product list. Luma puts the amount in
 * data-price-amount; Hyvä only renders the formatted text.
 */
function readDom(): RawDom {
  const main = document.querySelector('.product-info-main') ?? document.querySelector('#product_addtocart_form')?.parentElement ?? document.body;
  const inList = (el: Element) => !!el.closest('.product-item, .products-grid, .products-list, [class*="related"], [class*="upsell"], [class*="crosssell"]');
  const box = [...main.querySelectorAll('.price-box')].find((el) => !inList(el));
  const amount = (el: Element | null | undefined) => {
    const v = el?.getAttribute('data-price-amount');
    return v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined;
  };
  const textOf = (el: Element | null | undefined) => (el as HTMLElement | null | undefined)?.innerText?.trim() || el?.textContent?.trim() || undefined;

  const finalEl =
    box?.querySelector('[data-price-type="finalPrice"]') ??
    box?.querySelector('[data-price-type="minPrice"]') ??
    box?.querySelector('.final-price .price, .special-price .price') ??
    [...(box?.querySelectorAll('.price') ?? [])].find((el) => !el.closest('.old-price'));
  const oldEl = box?.querySelector('[data-price-type="oldPrice"]') ?? box?.querySelector('.old-price .price, .old-price');
  const finalTextEl = finalEl?.matches('.price') ? finalEl : (finalEl?.querySelector('.price') ?? finalEl);
  const oldTextEl = oldEl?.matches('.price') ? oldEl : (oldEl?.querySelector('.price') ?? oldEl);

  const stockEl = [...main.querySelectorAll('.stock')].find((el) => !inList(el));
  const stockClass = stockEl?.classList.contains('unavailable')
    ? 'unavailable'
    : stockEl?.classList.contains('available')
      ? 'available'
      : undefined;

  const button = document.querySelector('#product-addtocart-button, #product_addtocart_form button[type="submit"]');
  return {
    finalAmount: amount(finalEl),
    finalText: textOf(finalTextEl) ?? (box ? textOf(box) : undefined),
    oldAmount: amount(oldEl),
    oldText: textOf(oldTextEl),
    stockClass,
    stockText: textOf(stockEl),
    addToCart: !!button,
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ''),
    metaPrice: document.querySelector('meta[property="product:price:amount"]')?.getAttribute('content') ?? undefined,
    metaCurrency: document.querySelector('meta[property="product:price:currency"]')?.getAttribute('content') ?? undefined,
  };
}

/**
 * Parses a formatted price in any common locale: "$1,234.56", "1.234,56 €", "34,00 €", "CHF 1'234.50", "¥1,234".
 * A lone separator followed by exactly three digits is a thousands separator.
 */
export function parsePrice(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /\d[\d.,'\s  ]*/.exec(text);
  if (!match) return undefined;
  const s = match[0].replace(/[\s  ']/g, '').replace(/[.,]+$/, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    normalized = s.split(thousands).join('').replace(decimal, '.');
  } else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : undefined;
    if (!sep) normalized = s;
    else {
      const parts = s.split(sep);
      const thousands = parts.length > 2 || parts[parts.length - 1]!.length === 3;
      normalized = thousands ? parts.join('') : parts.join('.');
    }
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/** Offers from JSON-LD Product / ProductGroup (incl. hasVariant and AggregateOffer) and the Open Graph price meta. */
export function parseStructured(jsonLd: string[], metaPrice?: string, metaCurrency?: string): PageProduct['structured'] {
  const out: PageProduct['structured'] = [];
  const nodes: Array<Record<string, unknown>> = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      if (Array.isArray(node['@graph'])) collect(node['@graph']);
      nodes.push(node);
    }
  };
  for (const text of jsonLd) {
    try {
      collect(JSON.parse(text));
    } catch {
      // Invalid JSON-LD is ignored here; Google's Rich Results test is the place for that.
    }
  }
  const isType = (node: Record<string, unknown>, type: string) =>
    ([] as unknown[]).concat(node['@type'] ?? []).some((t) => t === type);
  for (const node of nodes) {
    if (!isType(node, 'Product') && !isType(node, 'ProductGroup')) continue;
    // A variant inside a ProductGroup is summarized with its group below.
    if (isType(node, 'Product') && nodes.some((n) => isType(n, 'ProductGroup') && ([] as unknown[]).concat(n['hasVariant'] ?? []).includes(node))) {
      continue;
    }
    const offers = ([] as unknown[])
      .concat(node['offers'] ?? [])
      .concat(...([] as unknown[]).concat(node['hasVariant'] ?? []).map((v) => (v as Record<string, unknown>)['offers'] ?? []));
    const prices: number[] = [];
    let currency: string | undefined;
    let inStock: boolean | undefined;
    for (const o of offers as Array<Record<string, unknown>>) {
      if (!o || typeof o !== 'object') continue;
      const rawPrice = o['lowPrice'] ?? o['price'];
      if (rawPrice !== undefined && rawPrice !== null && rawPrice !== '' && Number.isFinite(Number(rawPrice))) {
        prices.push(Number(rawPrice));
      }
      currency ??= typeof o['priceCurrency'] === 'string' ? o['priceCurrency'] : undefined;
      if (typeof o['availability'] === 'string') {
        const available = /InStock|LimitedAvailability|OnlineOnly|PreOrder|BackOrder/i.test(o['availability']);
        inStock = (inStock ?? false) || available;
      }
    }
    if (prices.length === 0 && inStock === undefined) continue;
    out.push({
      source: `JSON-LD ${isType(node, 'ProductGroup') ? 'ProductGroup' : 'Product'}`,
      price: prices.length > 0 ? Math.min(...prices) : undefined,
      currency,
      inStock,
    });
  }
  if (metaPrice !== undefined && metaPrice !== '' && Number.isFinite(Number(metaPrice))) {
    out.push({ source: 'meta product:price:amount', price: Number(metaPrice), currency: metaCurrency });
  }
  return out;
}

// ---------- comparison ----------

const samePrice = (a: number, b: number) => Math.abs(a - b) < 0.005;
const fmt = (v: number) => v.toFixed(2);

export function compareProduct(url: string, api: ApiProduct, shown: PageProduct): ProductReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const currency = api.minFinal.currency;
  const final = api.minFinal.value;
  const regular = api.minRegular.value;
  const ranged = !samePrice(final, api.maxFinal.value);
  const staleHint = shown.cache?.startsWith('HIT') ? ` (page served from cache, ${shown.cache}: stale full page cache?)` : '';

  // Price.
  if (final <= 0) problems.push(`ZERO PRICE in GraphQL (final ${fmt(final)} ${currency}): price index or price scope?`);
  if (shown.finalPrice === undefined) {
    notes.push(`price not found on the page${shown.priceText ? ` (text "${shown.priceText}")` : ''}: theme markup not recognized`);
  } else if (!samePrice(shown.finalPrice, final)) {
    const ratio = final > 0 ? shown.finalPrice / final : 0;
    const taxHint = ratio > 1.04 && ratio < 1.3 ? '; ratio looks like tax: check the catalog price display setting (incl./excl. tax)' : '';
    problems.push(
      `price: page ${fmt(shown.finalPrice)} ≠ GraphQL ${ranged ? 'minimum ' : ''}final ${fmt(final)} ${currency}` +
        `${staleHint}${taxHint}${staleHint || taxHint ? '' : ' (price indexer, catalog price rule or special price dates?)'}`,
    );
  }
  // Special price: the old (struck-through) price should be the regular price.
  if (regular > final + 0.005) {
    if (shown.oldPrice === undefined) {
      notes.push(`GraphQL has a discount (regular ${fmt(regular)} → final ${fmt(final)}), the page shows no old price`);
    } else if (!samePrice(shown.oldPrice, regular)) {
      problems.push(`old price: page ${fmt(shown.oldPrice)} ≠ GraphQL regular ${fmt(regular)} ${currency}${staleHint}`);
    }
  } else if (shown.oldPrice !== undefined && !samePrice(shown.oldPrice, final) && !ranged) {
    problems.push(`page shows an old price ${fmt(shown.oldPrice)}, GraphQL has no discount (regular = final ${fmt(final)})${staleHint}`);
  }

  // Stock.
  const apiInStock = api.stockStatus === 'IN_STOCK';
  if (shown.stock === undefined) {
    notes.push('stock label not found on the page (the store may hide it: Display Out of Stock / stock status setting)');
  } else if ((shown.stock === 'IN_STOCK') !== apiInStock) {
    problems.push(`stock: page "${shown.stockText ?? shown.stock}" ≠ GraphQL ${api.stockStatus}${staleHint}`);
  }
  if (apiInStock && !shown.addToCart) problems.push('in stock in GraphQL, but the page has no Add to Cart button');
  if (api.variants) {
    if (api.variants.total === 0) problems.push('configurable product without variants visible to GraphQL');
    else if (apiInStock && api.variants.inStock === 0) problems.push(`parent IN_STOCK, but all ${api.variants.total} variants are out of stock`);
  }
  if (api.onlyLeft) notes.push(`only ${api.onlyLeft} left`);

  // Structured data (rich results / Merchant Center): reported, not part of the verdict.
  for (const s of shown.structured) {
    if (s.price !== undefined && !samePrice(s.price, final)) {
      notes.push(`WARNING ${s.source} price ${fmt(s.price)} ≠ GraphQL ${fmt(final)} ${currency}`);
    }
    if (s.currency && s.currency !== currency) notes.push(`WARNING ${s.source} currency ${s.currency} ≠ ${currency}`);
    if (s.inStock !== undefined && s.inStock !== apiInStock) {
      notes.push(`WARNING ${s.source} availability ${s.inStock ? 'InStock' : 'OutOfStock'} ≠ GraphQL ${api.stockStatus}`);
    }
  }

  const verdict: ProductVerdict = problems.length > 0 ? 'MISMATCH' : shown.finalPrice === undefined ? 'UNKNOWN' : 'OK';
  return { url, verdict, api, page: shown, problems, notes };
}

// ---------- formatting ----------

export function formatProductReport(reports: ProductReport[]): string {
  const counts = (v: ProductVerdict) => reports.filter((r) => r.verdict === v).length;
  const lines = [
    `${counts('OK')}/${reports.length} OK` +
      (['MISMATCH', 'UNKNOWN', 'ERROR'] as const).map((v) => (counts(v) ? `, ${counts(v)} ${v}` : '')).join(''),
  ];
  for (const r of reports) {
    const a = r.api;
    const title = a ? `${a.sku} "${a.name}" (${a.type})` : '';
    lines.push(`${r.verdict.padEnd(8)} ${title ? `${title} ` : ''}${r.url}`);
    if (a && r.page) {
      const price =
        `price page ${r.page.finalPrice !== undefined ? fmt(r.page.finalPrice) : '?'}` +
        (r.page.oldPrice !== undefined ? ` (old ${fmt(r.page.oldPrice)})` : '') +
        ` / GraphQL ${fmt(a.minFinal.value)}` +
        (a.minRegular.value > a.minFinal.value + 0.005 ? ` (regular ${fmt(a.minRegular.value)})` : '') +
        (samePrice(a.minFinal.value, a.maxFinal.value) ? '' : `–${fmt(a.maxFinal.value)}`) +
        ` ${a.minFinal.currency}`;
      const stock =
        `stock page ${r.page.stockText ? `"${r.page.stockText}"` : '?'} / GraphQL ${a.stockStatus}` +
        (a.variants ? ` (${a.variants.inStock}/${a.variants.total} variants in stock)` : '');
      lines.push(`         ${price} | ${stock}${r.page.cache ? ` | page cache ${r.page.cache}` : ''}`);
    }
    for (const p of r.problems) lines.push(`         - ${p}`);
    for (const n of r.notes) lines.push(`         · ${n}`);
  }
  return lines.join('\n');
}
