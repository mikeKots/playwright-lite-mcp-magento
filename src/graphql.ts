import type { APIRequestContext } from 'playwright';
import { readCacheStatus } from './cache.js';
import { describeError } from './errors.js';

/**
 * Magento 2 / Adobe Commerce / Mage-OS GraphQL checks for headless / PWA storefronts and for
 * the Hyvä and Luma widgets that call GraphQL. Two modes:
 *  - presets: a quick health check of the API a storefront depends on (store config, catalog,
 *    product listing, guest cart, GET caching), each summarized in one line;
 *  - a custom query: status, GraphQL errors (message, category, path), timing and truncated data.
 */

export const GRAPHQL_CHECKS = ['store', 'catalog', 'products', 'cart', 'cache'] as const;
export type GraphqlCheck = (typeof GRAPHQL_CHECKS)[number];

export interface GraphqlCheckOptions {
  endpoint: string;
  checks?: GraphqlCheck[];
  query?: string;
  variables?: Record<string, unknown>;
  method?: 'POST' | 'GET';
  /** SKU for the cart check; default: first in-stock simple product from the listing. */
  sku?: string;
  storeCode?: string;
  maxChars: number;
}

export interface GqlError {
  message: string;
  path?: Array<string | number>;
  extensions?: { category?: string };
}

export interface GqlResult<T = Record<string, unknown>> {
  status: number;
  ms: number;
  data?: T;
  errors: GqlError[];
  headers: Record<string, string>;
  /** Set when the response was not GraphQL JSON at all (HTML error page, 5xx, redirect). */
  transportError?: string;
}

export interface GraphqlLine {
  ok: boolean;
  name: string;
  ms?: number;
  detail: string;
}

export async function runGraphqlCheck(request: APIRequestContext, opts: GraphqlCheckOptions): Promise<string> {
  const gql = <T>(query: string, variables?: Record<string, unknown>, method: 'POST' | 'GET' = 'POST') =>
    graphqlRequest<T>(request, opts.endpoint, query, variables, method, opts.storeCode);

  const header = `GraphQL: ${opts.endpoint}${opts.storeCode ? ` (store: ${opts.storeCode})` : ''}`;

  if (opts.query && !opts.checks) {
    const r = await gql(opts.query, opts.variables, opts.method ?? 'POST');
    return `${header}\n${formatCustom(r, opts.method ?? 'POST', opts.maxChars)}`;
  }

  const lines = await runGraphqlPresets(request, opts);
  const out = [header];
  for (const l of lines) out.push(`${l.ok ? 'OK  ' : 'FAIL'} ${l.name}${l.ms !== undefined ? ` ${l.ms}ms` : ''} | ${l.detail}`);
  out.push(`Summary: ${lines.filter((l) => l.ok).length}/${lines.length} OK`);
  if (opts.query) {
    const r = await gql(opts.query, opts.variables, opts.method ?? 'POST');
    out.push('', 'Custom query:', formatCustom(r, opts.method ?? 'POST', opts.maxChars));
  }
  return out.join('\n');
}

/** Runs preset checks and returns one structured line per check (used by the tool and by browser_run helpers). */
export async function runGraphqlPresets(
  request: APIRequestContext,
  opts: Pick<GraphqlCheckOptions, 'endpoint' | 'checks' | 'sku' | 'storeCode'>,
): Promise<GraphqlLine[]> {
  const gql: Gql = (query, variables, method = 'POST') =>
    graphqlRequest(request, opts.endpoint, query, variables, method, opts.storeCode);
  const lines: GraphqlLine[] = [];
  const state: State = { sku: opts.sku };
  for (const check of opts.checks ?? [...GRAPHQL_CHECKS]) {
    try {
      lines.push(await PRESETS[check](gql, state));
    } catch (err) {
      lines.push({ ok: false, name: check, detail: describeError(err) });
    }
  }
  return lines;
}

// ---------- presets ----------

type Gql = <T>(query: string, variables?: Record<string, unknown>, method?: 'POST' | 'GET') => Promise<GqlResult<T>>;
type State = { rootUid?: string; sku?: string };
type Money = { value: number; currency: string };

const PRESETS: Record<GraphqlCheck, (gql: Gql, state: State) => Promise<GraphqlLine>> = {
  async store(gql, state) {
    const r = await gql<{
      storeConfig: { store_code: string; store_name: string; base_currency_code: string; locale: string; root_category_uid?: string };
    }>('{ storeConfig { store_code store_name base_currency_code locale root_category_uid } }');
    const failure = failureOf('store', r);
    if (failure) return failure;
    const c = r.data!.storeConfig;
    state.rootUid = c.root_category_uid;
    return { ok: true, name: 'store', ms: r.ms, detail: `${c.store_code} "${c.store_name}", ${c.base_currency_code}, ${c.locale}` };
  },

  async catalog(gql, state) {
    await ensureRoot(gql, state);
    const r = await gql<{ categoryList: Array<{ name: string; children: Array<{ name: string; product_count: number }> }> }>(
      'query ($uid: String!) { categoryList(filters: { category_uid: { eq: $uid } }) { name children { name product_count } } }',
      { uid: state.rootUid },
    );
    const failure = failureOf('catalog', r);
    if (failure) return failure;
    const root = r.data!.categoryList[0];
    if (!root) return { ok: false, name: 'catalog', ms: r.ms, detail: `root category ${state.rootUid} not found` };
    const children = root.children ?? [];
    const list = children.map((c) => `${c.name} (${c.product_count})`).join(', ');
    return {
      ok: children.length > 0,
      name: 'catalog',
      ms: r.ms,
      detail: children.length > 0 ? `${children.length} top-level categories: ${list}` : `"${root.name}" has no child categories`,
    };
  },

  async products(gql, state) {
    await ensureRoot(gql, state);
    const r = await gql<{
      products: {
        total_count: number;
        items: Array<{
          __typename: string;
          sku: string;
          name: string;
          stock_status: string;
          price_range: { minimum_price: { final_price: Money } };
        }>;
      };
    }>(
      `query ($uid: String!) { products(filter: { category_uid: { eq: $uid } }, pageSize: 20) {
         total_count items { __typename sku name stock_status price_range { minimum_price { final_price { value currency } } } } } }`,
      { uid: state.rootUid },
    );
    const failure = failureOf('products', r);
    if (failure) return failure;
    const { total_count, items } = r.data!.products;
    if (total_count === 0) return { ok: false, name: 'products', ms: r.ms, detail: 'no products (indexer:reindex? products assigned to the website?)' };
    const types = countBy(items.map((i) => i.__typename.replace(/Product$/, '')));
    const outOfStock = items.filter((i) => i.stock_status !== 'IN_STOCK').length;
    // A zero final price on a sellable product is a classic indexing/price-scope bug.
    const zeroPrice = items.filter((i) => i.price_range.minimum_price.final_price.value <= 0).map((i) => i.sku);
    const firstSimple = items.find((i) => i.__typename === 'SimpleProduct' && i.stock_status === 'IN_STOCK');
    state.sku ??= firstSimple?.sku;
    const notes = [
      `${total_count} products; first ${items.length}: ${Object.entries(types).map(([t, n]) => `${n} ${t}`).join(', ')}`,
      outOfStock > 0 ? `${outOfStock} out of stock` : undefined,
      zeroPrice.length > 0 ? `ZERO PRICE: ${zeroPrice.join(', ')}` : undefined,
    ].filter(Boolean);
    return { ok: zeroPrice.length === 0, name: 'products', ms: r.ms, detail: notes.join(', ') };
  },

  async cart(gql, state) {
    const started = Date.now();
    state.sku ??= await findSimpleSku(gql, state);
    if (!state.sku) {
      return { ok: false, name: 'cart', detail: 'no in-stock simple product found in the first 500 products: pass sku' };
    }
    const created = await gql<{ createEmptyCart: string }>('mutation { createEmptyCart }');
    const failure = failureOf('cart', created, 'createEmptyCart');
    if (failure) return failure;
    const added = await gql<{
      addProductsToCart: {
        cart: { total_quantity: number; prices: { subtotal_excluding_tax: Money; grand_total: Money } };
        user_errors: Array<{ code: string; message: string }>;
      };
    }>(
      `mutation ($cartId: String!, $sku: String!) { addProductsToCart(cartId: $cartId, cartItems: [{ sku: $sku, quantity: 1 }]) {
         cart { total_quantity prices { subtotal_excluding_tax { value currency } grand_total { value currency } } }
         user_errors { code message } } }`,
      { cartId: created.data!.createEmptyCart, sku: state.sku },
    );
    const addFailure = failureOf('cart', added, 'addProductsToCart');
    if (addFailure) return { ...addFailure, ms: Date.now() - started };
    const { cart, user_errors } = added.data!.addProductsToCart;
    if (user_errors.length > 0) {
      return {
        ok: false,
        name: 'cart',
        ms: Date.now() - started,
        detail: `addProductsToCart(${state.sku}): ${user_errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`,
      };
    }
    return {
      ok: cart.total_quantity > 0,
      name: 'cart',
      ms: Date.now() - started,
      detail:
        `guest cart + ${state.sku} ×1 → qty ${cart.total_quantity}, subtotal ${money(cart.prices.subtotal_excluding_tax)}, ` +
        `grand total ${money(cart.prices.grand_total)} (an abandoned guest cart is left behind)`,
    };
  },

  async cache(gql) {
    // Magento caches GraphQL GET queries in Varnish/FPC; POST is never cached.
    const query = '{ storeConfig { store_code } }';
    const first = await gql(query, undefined, 'GET');
    const failure = failureOf('cache', first);
    if (failure) return failure;
    const second = await gql(query, undefined, 'GET');
    const status = readCacheStatus(second.headers);
    const cacheId = second.headers['x-magento-cache-id'] ? ', X-Magento-Cache-Id present' : '';
    const cacheable = second.headers['x-magento-cache-control'] ?? second.headers['cache-control'] ?? '?';
    if (!status.cache) {
      return { ok: true, name: 'cache', ms: second.ms, detail: `no cache status header on GET (cache-control: ${cacheable})${cacheId}` };
    }
    return {
      ok: status.cache === 'HIT',
      name: 'cache',
      ms: second.ms,
      detail:
        `GET storeConfig: ${readCacheStatus(first.headers).cache ?? '?'} ${first.ms}ms → ${status.cache} ${second.ms}ms ` +
        `via ${status.source}${cacheId}` +
        (status.cache === 'HIT' ? '' : ` (cache-control: ${cacheable}; GraphQL GET should be cacheable)`),
    };
  },
};

/** Configurable products often come first in listings: page through SKUs (small payload) to find a simple one. */
async function findSimpleSku(gql: Gql, state: State): Promise<string | undefined> {
  await ensureRoot(gql, state);
  for (let page = 1; page <= 5; page++) {
    const r = await gql<{ products: { total_count: number; items: Array<{ __typename: string; sku: string; stock_status: string }> } }>(
      `query ($uid: String!, $page: Int!) { products(filter: { category_uid: { eq: $uid } }, pageSize: 100, currentPage: $page) {
         total_count items { __typename sku stock_status } } }`,
      { uid: state.rootUid, page },
    );
    const items = r.data?.products.items ?? [];
    const simple = items.find((i) => i.__typename === 'SimpleProduct' && i.stock_status === 'IN_STOCK');
    if (simple) return simple.sku;
    if (items.length < 100 || page * 100 >= (r.data?.products.total_count ?? 0)) return undefined;
  }
  return undefined;
}

async function ensureRoot(gql: Gql, state: State): Promise<void> {
  if (state.rootUid) return;
  const r = await gql<{ storeConfig: { root_category_uid: string } }>('{ storeConfig { root_category_uid } }');
  state.rootUid = r.data?.storeConfig?.root_category_uid;
  if (!state.rootUid) throw new Error(firstError(r) ?? 'storeConfig.root_category_uid unavailable');
}

// ---------- transport ----------

export async function graphqlRequest<T>(
  request: APIRequestContext,
  endpoint: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  method: 'POST' | 'GET',
  storeCode: string | undefined,
): Promise<GqlResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (storeCode) headers['Store'] = storeCode;
  const started = Date.now();
  const res =
    method === 'GET'
      ? await request.get(endpoint, {
          params: variables ? { query, variables: JSON.stringify(variables) } : { query },
          headers,
          maxRedirects: 0,
        })
      : await request.post(endpoint, {
          data: { query, variables: variables ?? {} },
          headers: { ...headers, 'Content-Type': 'application/json' },
          maxRedirects: 0,
        });
  const body = await res.text();
  const ms = Date.now() - started;
  const result: GqlResult<T> = { status: res.status(), ms, errors: [], headers: res.headers() };
  try {
    const json = JSON.parse(body) as { data?: T; errors?: GqlError[] };
    result.data = json.data ?? undefined;
    result.errors = json.errors ?? [];
  } catch {
    const location = res.headers()['location'];
    result.transportError =
      res.status() >= 300 && res.status() < 400
        ? `HTTP ${res.status()} redirect to ${location ?? '?'}`
        : `HTTP ${res.status()}, not JSON: ${body.replace(/\s+/g, ' ').slice(0, 200)}`;
  }
  return result;
}

// ---------- formatting ----------

function failureOf(name: string, r: GqlResult<unknown>, step?: string): GraphqlLine | undefined {
  const where = step ? `${step}: ` : '';
  if (r.transportError) return { ok: false, name, ms: r.ms, detail: `${where}${r.transportError}` };
  if (r.errors.length > 0) return { ok: false, name, ms: r.ms, detail: `${where}${formatErrors(r.errors)}` };
  if (!r.data) return { ok: false, name, ms: r.ms, detail: `${where}HTTP ${r.status}, no data` };
  return undefined;
}

function firstError(r: GqlResult<unknown>): string | undefined {
  return r.transportError ?? r.errors[0]?.message;
}

function formatErrors(errors: GqlError[]): string {
  return errors
    .slice(0, 5)
    .map((e) => {
      const meta = [e.extensions?.category, e.path?.join('.')].filter(Boolean).join(' at ');
      return `${e.message}${meta ? ` [${meta}]` : ''}`;
    })
    .join('; ') + (errors.length > 5 ? `; …${errors.length - 5} more` : '');
}

function formatCustom(r: GqlResult<unknown>, method: 'POST' | 'GET', maxChars: number): string {
  const lines: string[] = [];
  const ok = !r.transportError && r.errors.length === 0;
  const cache = method === 'GET' ? readCacheStatus(r.headers) : {};
  lines.push(
    `${ok ? 'OK  ' : 'FAIL'} ${method} HTTP ${r.status} ${r.ms}ms` + (cache.cache ? ` | cache ${cache.cache} via ${cache.source}` : ''),
  );
  if (r.transportError) lines.push(`Error: ${r.transportError}`);
  if (r.errors.length > 0) lines.push(`Errors (${r.errors.length}): ${formatErrors(r.errors)}`);
  if (r.data !== undefined) {
    const json = JSON.stringify(r.data);
    lines.push(
      json.length <= maxChars
        ? `Data: ${json}`
        : `Data (${json.length} chars, truncated; select fewer fields or raise maxChars): ${json.slice(0, maxChars)}…`,
    );
  }
  return lines.join('\n');
}

function money(m: Money): string {
  return `${m.value.toFixed(2)} ${m.currency}`;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
