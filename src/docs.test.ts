import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The npx quick start pins the Playwright version for `playwright install`: a mismatch downloads a browser
// build the server cannot use.
describe('README', () => {
  it('pins the same Playwright version as package.json in its install commands', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const pinned = [...readme.matchAll(/npx playwright@([\d.]+) install/g)].map((m) => m[1]);
    expect(pinned.length).toBeGreaterThan(0);
    for (const v of pinned) expect(v).toBe(pkg.dependencies.playwright);
  });
});
