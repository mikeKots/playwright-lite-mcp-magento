import type { APIRequestContext, APIResponse } from 'playwright';
import { describeError } from './errors.js';

/**
 * Full page cache check for Magento 2 / Adobe Commerce / Mage-OS (and any site behind Varnish or a CDN).
 *
 * Each URL is requested several times over plain HTTP. The cache status is read from whichever
 * header the stack provides: X-Magento-Cache-Debug (built-in FPC or stock Varnish VCL in developer
 * mode), X-Cache (Warden VCL, Fastly / Adobe Commerce Cloud, many CDNs), CF-Cache-Status (Cloudflare),
 * X-Varnish (two transaction ids = hit) or Age. Cacheability comes from what Magento itself sent:
 * X-Magento-Cache-Control when a proxy rewrote Cache-Control, plus the X-Magento-Tags header.
 */

export type CacheStatus = 'HIT' | 'MISS';
export type Verdict = 'CACHED' | 'NOT_CACHEABLE' | 'MISS' | 'UNKNOWN' | 'ERROR';

export interface Hop {
  status: number;
  ms: number;
  cache?: CacheStatus;
  /** Header the cache status was read from. */
  source?: string;
  age?: number;
}

export interface UrlReport {
  url: string;
  verdict: Verdict;
  hops: Hop[];
  layer?: string;
  cacheControl?: string;
  tags?: number;
  setCookies: string[];
  location?: string;
  notes: string[];
}

// Pages Magento deliberately never caches: an uncached result there is not a problem.
const PRIVATE_PATHS = /\/(checkout|customer|wishlist|sales|multishipping|paypal|vault|downloadable)(\/|$)/;

export async function checkUrlCache(request: APIRequestContext, url: string, requests: number): Promise<UrlReport> {
  const report: UrlReport = { url, verdict: 'UNKNOWN', hops: [], setCookies: [], notes: [] };
  let last: APIResponse | undefined;
  try {
    for (let i = 0; i < requests; i++) {
      const started = Date.now();
      // Redirects are not followed: the target may be outside the allowlist, and a redirect
      // itself is the finding (e.g. a missing trailing slash or store code redirect).
      last = await request.get(url, { maxRedirects: 0 });
      await last.body();
      const headers = last.headers();
      const { cache, source } = readCacheStatus(headers);
      const age = headers['age'] !== undefined ? Number(headers['age']) : undefined;
      report.hops.push({ status: last.status(), ms: Date.now() - started, cache, source, age });
      for (const name of cookieNames(last)) if (!report.setCookies.includes(name)) report.setCookies.push(name);
    }
  } catch (err) {
    report.verdict = 'ERROR';
    report.notes.push(describeError(err));
    return report;
  }

  const headers = last!.headers();
  report.layer = detectLayer(headers);
  // Behind a proxy the client-facing Cache-Control is the proxy's rewrite, not Magento's: do not show it.
  report.cacheControl = headers['x-magento-cache-control'] ?? (isProxied(headers) ? undefined : headers['cache-control']);
  const tags = headers['x-magento-tags'];
  report.tags = tags ? tags.split(',').filter(Boolean).length : undefined;
  const finalHop = report.hops[report.hops.length - 1]!;

  if (finalHop.status >= 300 && finalHop.status < 400) {
    report.location = headers['location'];
    report.verdict = 'NOT_CACHEABLE';
    report.notes.push(`redirects (${finalHop.status}) to ${report.location ?? '?'}: check the final URL instead`);
    return report;
  }
  if (finalHop.status >= 400) {
    report.verdict = 'ERROR';
    report.notes.push(`HTTP ${finalHop.status}`);
    return report;
  }

  const uncacheableReason = magentoSaysUncacheable(headers);
  const privatePath = PRIVATE_PATHS.test(new URL(url).pathname);
  // Magento sends its own verdict (X-Magento-Cache-Control) only in developer mode; behind a proxy
  // the client-facing Cache-Control is rewritten, so in production the reason is not visible.
  const magentoVerdictHidden = !headers['x-magento-cache-control'] && isProxied(headers);
  if (finalHop.cache === 'HIT') {
    report.verdict = 'CACHED';
  } else if (uncacheableReason) {
    report.verdict = 'NOT_CACHEABLE';
    report.notes.push(uncacheableReason);
    if (privatePath) {
      report.notes.push('expected: Magento never caches cart/checkout/customer pages');
    } else {
      report.notes.push(
        'a layout block with cacheable="false" makes the whole page uncacheable; ' +
          'search the layout XML of this page type for cacheable="false"',
      );
    }
  } else if (finalHop.cache === 'MISS' && privatePath && magentoVerdictHidden) {
    report.verdict = 'NOT_CACHEABLE';
    report.notes.push(
      'expected: Magento never caches cart/checkout/customer pages ' +
        '(inferred from the URL: production mode hides X-Magento-Cache-Control)',
    );
  } else if (finalHop.cache === 'MISS') {
    report.verdict = 'MISS';
    report.notes.push(`still MISS after ${requests} requests`);
    if (magentoVerdictHidden) {
      report.notes.push(
        'Magento\'s own cacheability is hidden (X-Magento-Cache-Control is sent in developer mode only); ' +
          'usual causes: a layout block with cacheable="false", or a session started on the page',
      );
    }
    if (report.setCookies.length > 0) {
      report.notes.push(`response sets cookies (${report.setCookies.join(', ')}): Varnish does not store such responses`);
    }
    if (new URL(url).search) report.notes.push('query string: every parameter combination is a separate cache entry');
    report.notes.push('check: bin/magento cache:status full_page; Stores > Configuration > Advanced > System > Full Page Cache');
  } else {
    report.verdict = 'UNKNOWN';
    report.notes.push(
      'no cache status header: production mode hides X-Magento-Cache-Debug; ' +
        'with Varnish, enable the debug header or look at Age / X-Varnish',
    );
  }
  if (report.tags === undefined && report.verdict !== 'NOT_CACHEABLE') {
    report.notes.push('no X-Magento-Tags header: the page is not tagged for invalidation (or the proxy strips the header)');
  }
  return report;
}

export function formatCacheReport(reports: UrlReport[], requests: number, withSession: boolean): string {
  const layers = [...new Set(reports.map((r) => r.layer).filter(Boolean))];
  const lines = [
    `Cache check: ${requests} requests per URL, ${withSession ? 'with the browser session cookies' : 'as a guest without cookies'}. ` +
      `Layer: ${layers.join(', ') || 'unknown'}`,
  ];
  for (const r of reports) {
    const hops = r.hops
      .map((h) => `${h.cache ?? h.status} ${h.ms}ms${h.age ? ` age=${h.age}` : ''}`)
      .join(' → ');
    const details = [
      hops,
      r.hops.find((h) => h.source)?.source ? `via ${r.hops.find((h) => h.source)!.source}` : undefined,
      r.tags !== undefined ? `tags: ${r.tags}` : undefined,
      r.cacheControl && r.verdict !== 'CACHED' ? `cache-control: ${r.cacheControl}` : undefined,
    ].filter(Boolean);
    lines.push(`${r.verdict.padEnd(13)} ${r.url}${details.length > 0 ? ` | ${details.join(' | ')}` : ''}`);
    for (const note of r.notes) lines.push(`  - ${note}`);
  }
  const count = (v: Verdict) => reports.filter((r) => r.verdict === v).length;
  lines.push(
    `Summary: ${count('CACHED')}/${reports.length} cached` +
      (count('NOT_CACHEABLE') ? `, ${count('NOT_CACHEABLE')} not cacheable` : '') +
      (count('MISS') ? `, ${count('MISS')} MISS` : '') +
      (count('UNKNOWN') ? `, ${count('UNKNOWN')} unknown` : '') +
      (count('ERROR') ? `, ${count('ERROR')} error` : ''),
  );
  return lines.join('\n');
}

// ---------- header interpretation ----------

export function readCacheStatus(h: Record<string, string>): { cache?: CacheStatus; source?: string } {
  const debug = h['x-magento-cache-debug'];
  if (debug) return { cache: /hit/i.test(debug) ? 'HIT' : 'MISS', source: 'X-Magento-Cache-Debug' };
  const xcache = h['x-cache'];
  // Fastly lists one value per cache node ("MISS, HIT"): any hit means the response came from cache.
  if (xcache) return { cache: /\bhit\b/i.test(xcache) ? 'HIT' : 'MISS', source: 'X-Cache' };
  const cf = h['cf-cache-status'];
  if (cf) return { cache: /^hit$/i.test(cf.trim()) ? 'HIT' : 'MISS', source: 'CF-Cache-Status' };
  const varnish = h['x-varnish'];
  if (varnish) return { cache: varnish.trim().split(/\s+/).length >= 2 ? 'HIT' : 'MISS', source: 'X-Varnish' };
  const age = h['age'];
  if (age !== undefined && /^\d+$/.test(age.trim())) {
    return { cache: Number(age) > 0 ? 'HIT' : 'MISS', source: 'Age' };
  }
  return {};
}

export function detectLayer(h: Record<string, string>): string | undefined {
  if (h['cf-cache-status'] || h['cf-ray']) return 'Cloudflare';
  if (h['x-served-by']?.includes('cache-') || h['fastly-debug-digest'] || h['x-fastly-request-id']) return 'Fastly';
  if (h['x-varnish'] || /varnish/i.test(h['via'] ?? '')) return 'Varnish';
  if (h['x-magento-cache-debug']) return 'Magento built-in FPC';
  return undefined;
}

function isProxied(h: Record<string, string>): boolean {
  const layer = detectLayer(h);
  return layer !== undefined && layer !== 'Magento built-in FPC';
}

function magentoSaysUncacheable(h: Record<string, string>): string | undefined {
  const fromMagento = h['x-magento-cache-control'];
  // Behind Varnish the client always sees "no-store" (the VCL rewrites it), so Cache-Control is
  // only trustworthy when no proxy is in front or Magento's original copy is exposed.
  const proxied = isProxied(h);
  const value = fromMagento ?? (proxied ? undefined : h['cache-control']);
  if (!value) return undefined;
  if (/\b(private|no-store|no-cache)\b/i.test(value) || /\bmax-age=0\b/.test(value)) {
    return `Magento marked the page uncacheable (${fromMagento ? 'X-Magento-Cache-Control' : 'Cache-Control'}: ${value})`;
  }
  return undefined;
}

function cookieNames(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value.split('=')[0]!.trim())
    .filter(Boolean);
}
