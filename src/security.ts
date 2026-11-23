import { ToolError } from './errors.js';

// "http://localhost:3000", "https://shop.example.com", "https://*.example.com"
const ORIGIN_PATTERN = /^(https?):\/\/(\*\.)?([a-z0-9.-]+)(?::(\d+))?\/?$/i;

export function isValidPattern(pattern: string): boolean {
  return pattern === '*' || ORIGIN_PATTERN.test(pattern.trim());
}

export function isUrlAllowed(rawUrl: string, allowed: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (allowed.includes('*')) return true;
  return allowed.some((pattern) => matchesPattern(url, pattern));
}

/** Validates a URL coming from the agent and returns it parsed, or throws a readable ToolError. */
export function assertUrlAllowed(rawUrl: string, allowed: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`Invalid URL "${rawUrl}". Use an absolute URL such as https://example.com/page`);
  }
  if (!isUrlAllowed(url.toString(), allowed)) {
    throw new ToolError(
      `Origin ${url.origin} is not in PW_ALLOWED_ORIGINS (allowed: ${allowed.join(', ')}). Ask the user to add it.`,
    );
  }
  return url;
}

function matchesPattern(url: URL, pattern: string): boolean {
  const m = ORIGIN_PATTERN.exec(pattern.trim());
  if (!m) return false;
  const protocol = (m[1] ?? '').toLowerCase();
  const wildcard = Boolean(m[2]);
  const host = (m[3] ?? '').toLowerCase();
  const rawPort = m[4] ?? '';
  const isDefaultPort = (protocol === 'https' && rawPort === '443') || (protocol === 'http' && rawPort === '80');
  const port = isDefaultPort ? '' : rawPort;

  if (url.protocol !== `${protocol}:`) return false;
  if (url.port !== port) return false;
  const hostname = url.hostname.toLowerCase();
  // "*.example.com" matches subdomains only, never "evil-example.com" or "example.com.evil.io".
  return wildcard ? hostname.endsWith(`.${host}`) : hostname === host;
}
