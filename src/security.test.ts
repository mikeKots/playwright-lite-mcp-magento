import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, isUrlAllowed, isValidPattern } from './security.js';

const allowed = ['http://localhost:3000', 'https://*.example.com', 'https://shop.test'];

describe('isUrlAllowed', () => {
  it.each([
    ['http://localhost:3000/checkout', true],
    ['http://localhost:4000/', false],
    ['https://admin.example.com/login', true],
    ['https://example.com/', false], // wildcard requires a subdomain
    ['https://evil-example.com/', false],
    ['https://example.com.evil.io/', false],
    ['http://shop.test/', false], // protocol must match
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isUrlAllowed(url, allowed)).toBe(expected);
  });

  it('"*" allows any http(s) URL but no other protocols', () => {
    expect(isUrlAllowed('https://anything.io', ['*'])).toBe(true);
    expect(isUrlAllowed('file:///etc/passwd', ['*'])).toBe(false);
  });

  it('treats explicit default ports as equal to no port', () => {
    expect(isUrlAllowed('https://shop.test/', ['https://shop.test:443'])).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('returns the parsed URL when allowed', () => {
    expect(assertUrlAllowed('https://shop.test/cart', allowed).pathname).toBe('/cart');
  });

  it('throws an agent-readable error otherwise', () => {
    expect(() => assertUrlAllowed('https://other.io', allowed)).toThrow(/not in PW_ALLOWED_ORIGINS/);
    expect(() => assertUrlAllowed('nope', allowed)).toThrow(/Invalid URL/);
  });
});

describe('isValidPattern', () => {
  it.each([
    ['*', true],
    ['https://*.example.com', true],
    ['http://localhost:3000', true],
    ['example.com', false],
    ['https://example.com/path', false],
  ])('%s -> %s', (pattern, expected) => {
    expect(isValidPattern(pattern)).toBe(expected);
  });
});
