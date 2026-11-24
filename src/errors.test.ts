import { describe, expect, it } from 'vitest';
import { ToolError, describeError } from './errors.js';

describe('describeError', () => {
  it('passes ToolError messages through', () => {
    expect(describeError(new ToolError('Not allowed: https://x.test'))).toBe('Not allowed: https://x.test');
  });

  it('keeps the first lines of a Playwright error and hints on timeouts', () => {
    const err = new Error('locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for x\n  - more');
    err.name = 'TimeoutError';
    const msg = describeError(err);
    expect(msg).toContain('locator.click: Timeout 10000ms exceeded.');
    expect(msg).not.toContain('more');
    expect(msg).toContain('call browser_snapshot');
  });

  it('tells how to install a missing browser, with the matching Playwright version', () => {
    const err = new Error(
      "browserType.launch: Executable doesn't exist at /cache/chromium_headless_shell-1243/chrome-headless-shell\n" +
        '╔══════╗\n║ Looks like Playwright was just installed or updated. ║\n║ npx playwright install ║',
    );
    expect(describeError(err)).toMatch(
      /^The chromium browser is not installed for Playwright \d+\.\d+\.\d+\. The user should run: npx playwright@\d+\.\d+\.\d+ install chromium/,
    );
    const ff = new Error("browserType.launch: Executable doesn't exist at /cache/firefox-1490/firefox/firefox");
    expect(describeError(ff)).toContain('install firefox');
  });
});
