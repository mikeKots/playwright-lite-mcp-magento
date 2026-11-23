import type { Page } from 'playwright';

/**
 * Configurable product options for the guest checkout.
 *
 * Which option values exist, and which combinations are in stock, comes from GraphQL (theme-independent).
 * The choice itself is made on the product page the way a customer makes it, so theme bugs surface:
 * Luma swatches are clicked, Hyvä radios checked, plain dropdowns selected.
 */

/** "first" = the first in-stock variant; or attribute label/code → value label, e.g. { Size: "M", color: "Blue" }. */
export type OptionChoice = 'first' | Record<string, string>;

export interface ConfigurableInfo {
  sku: string;
  options: Array<{ attributeId: string; code: string; label: string; values: Array<{ index: number; label: string }> }>;
  variants: Array<{ sku: string; inStock: boolean; values: Record<string, number> }>;
}

export interface ChosenVariant {
  sku: string;
  /** attribute id → value index, as posted in super_attribute[id]. */
  values: Record<string, number>;
  /** "Color: Purple, Size: XS" */
  summary: string;
}

const PRODUCT_FIELDS = `__typename sku
  ... on ConfigurableProduct {
    configurable_options { attribute_id attribute_code label values { value_index label } }
    variants { attributes { code value_index } product { sku stock_status } }
  }`;

/** Looks the product up by its URL: GraphQL `route` (Magento 2.4.5+), falling back to url_key. */
export async function loadProductOptions(
  page: Page,
  productUrl: string,
): Promise<{ type: string; configurable?: ConfigurableInfo }> {
  const url = new URL(productUrl);
  const endpoint = new URL('/graphql', url.origin).toString();
  const path = url.pathname.replace(/^\//, '');
  const post = async (query: string, variables: Record<string, unknown>) => {
    const res = await page.request.post(endpoint, { data: { query, variables }, maxRedirects: 0 });
    const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
    return json;
  };

  let product = (await post(`query ($url: String!) { route(url: $url) { ${PRODUCT_FIELDS} } }`, { url: path })).data?.[
    'route'
  ] as RawProduct | null | undefined;
  if (!product) {
    const urlKey = path.split('/').pop()!.replace(/\.[a-z]+$/, '');
    const r = await post(`query ($key: String!) { products(filter: { url_key: { eq: $key } }) { items { ${PRODUCT_FIELDS} } } }`, {
      key: urlKey,
    });
    product = (r.data?.['products'] as { items?: RawProduct[] } | undefined)?.items?.[0];
    if (!product) {
      throw new Error(`GraphQL does not know this product URL (${r.errors?.[0]?.message ?? 'no match for route or url_key'})`);
    }
  }
  if (product.__typename !== 'ConfigurableProduct') return { type: product.__typename };
  return {
    type: product.__typename,
    configurable: {
      sku: product.sku,
      options: (product.configurable_options ?? []).map((o) => ({
        attributeId: String(o.attribute_id),
        code: o.attribute_code,
        label: o.label,
        values: o.values.map((v) => ({ index: v.value_index, label: v.label })),
      })),
      variants: (product.variants ?? []).map((v) => ({
        sku: v.product.sku,
        inStock: v.product.stock_status === 'IN_STOCK',
        values: Object.fromEntries(v.attributes.map((a) => [a.code, a.value_index])),
      })),
    },
  };
}

interface RawProduct {
  __typename: string;
  sku: string;
  configurable_options?: Array<{
    attribute_id: string | number;
    attribute_code: string;
    label: string;
    values: Array<{ value_index: number; label: string }>;
  }>;
  variants?: Array<{ attributes: Array<{ code: string; value_index: number }>; product: { sku: string; stock_status: string } }>;
}

/** Picks the variant to buy: the first in-stock one matching the requested values. Throws a readable error otherwise. */
export function chooseVariant(info: ConfigurableInfo, choice: OptionChoice): ChosenVariant {
  const wanted = new Map<string, number>(); // attribute code → value index
  if (choice !== 'first') {
    for (const [key, valueLabel] of Object.entries(choice)) {
      const option = info.options.find((o) => same(o.label, key) || same(o.code, key));
      if (!option) {
        throw new Error(`Unknown option "${key}". Options: ${describeOptions(info)}`);
      }
      const value = option.values.find((v) => same(v.label, valueLabel));
      if (!value) {
        throw new Error(`"${valueLabel}" is not a value of ${option.label}. Options: ${describeOptions(info)}`);
      }
      wanted.set(option.code, value.index);
    }
  }
  const matching = info.variants.filter((v) => [...wanted].every(([code, index]) => v.values[code] === index));
  const variant = matching.find((v) => v.inStock);
  if (!variant) {
    const what = choice === 'first' ? 'any combination' : Object.entries(choice).map(([k, v]) => `${k} ${v}`).join(', ');
    throw new Error(
      matching.length > 0 ? `${what} is out of stock (${matching.map((v) => v.sku).join(', ')})` : `no variant for ${what}`,
    );
  }
  const values: Record<string, number> = {};
  const parts: string[] = [];
  for (const option of info.options) {
    const index = variant.values[option.code];
    if (index === undefined) continue;
    values[option.attributeId] = index;
    parts.push(`${option.label}: ${option.values.find((v) => v.index === index)?.label ?? index}`);
  }
  return { sku: variant.sku, values, summary: parts.join(', ') };
}

/** Selects each option on the product page like a customer: swatch click, radio, dropdown, or (last resort) the field value. */
export async function selectOptionsOnPage(page: Page, chosen: ChosenVariant, timeoutMs: number): Promise<void> {
  const form = page.locator('#product_addtocart_form').first();
  for (const [attributeId, index] of Object.entries(chosen.values)) {
    const swatch = page.locator(
      `.swatch-attribute[data-attribute-id="${attributeId}"] .swatch-option[data-option-id="${index}"], ` +
        `.swatch-attribute[attribute-id="${attributeId}"] .swatch-option[option-id="${index}"]`,
    );
    const field = form.locator(`[name="super_attribute[${attributeId}]"]`);
    // Luma renders swatches and Hyvä its option inputs with JS after load: wait for either.
    await swatch.or(field).first().waitFor({ state: 'attached', timeout: timeoutMs });

    if (await swatch.first().isVisible()) {
      await swatch.first().click();
      continue;
    }
    const tag = await field.first().evaluate((el) => `${el.tagName.toLowerCase()}:${(el as HTMLInputElement).type ?? ''}`);
    if (tag.startsWith('select')) {
      await field.first().selectOption(String(index));
    } else if (tag === 'input:radio') {
      const radio = form.locator(`input[name="super_attribute[${attributeId}]"][value="${index}"]`).first();
      // Styled radios are often visually hidden behind their label.
      await radio.check().catch(() => radio.check({ force: true }));
    } else {
      await field.first().evaluate((el, value) => {
        (el as HTMLInputElement).value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, String(index));
    }
  }
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function describeOptions(info: ConfigurableInfo): string {
  return info.options.map((o) => `${o.label} (${o.values.map((v) => v.label).join(', ')})`).join('; ');
}
