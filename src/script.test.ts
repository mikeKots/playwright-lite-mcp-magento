import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from './errors.js';
import { ScriptTimeoutError, formatResult, runScript } from './script.js';

describe('runScript', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<h1>Cart</h1><ul><li>A</li><li>B</li></ul>');
  });

  it('gives the script the page and returns its value', async () => {
    const result = await runScript(page, `return { title: await page.locator('h1').innerText(), items: await page.locator('li').allInnerTexts() };`, 5_000);
    expect(result).toEqual({ title: 'Cart', items: ['A', 'B'] });
  });

  it('reports syntax errors as a readable ToolError', async () => {
    await expect(runScript(page, 'return (', 5_000)).rejects.toThrow(/syntax error/i);
    await expect(runScript(page, 'return (', 5_000)).rejects.toBeInstanceOf(ToolError);
  });

  it('propagates errors thrown inside the script', async () => {
    await expect(runScript(page, `throw new Error('boom')`, 5_000)).rejects.toThrow('boom');
  });

  it('times out a script that never finishes', async () => {
    const started = Date.now();
    await expect(runScript(page, 'await new Promise(() => {});', 200)).rejects.toBeInstanceOf(ScriptTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('formatResult', () => {
  it.each([
    [undefined, 'Script finished (no return value).'],
    ['plain text', 'plain text'],
    [42, '42'],
    [null, 'null'],
    [{ a: 1 }, '{\n  "a": 1\n}'],
  ])('%j -> %j', (value, expected) => {
    expect(formatResult(value)).toBe(expected);
  });

  it('falls back to String() for circular values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatResult(circular)).toBe('[object Object]');
  });

  it('does not print "{}" for class instances that do not serialize', () => {
    class Handle {
      #secret = 1;
      toString() {
        return `Handle(${this.#secret})`;
      }
    }
    expect(formatResult(new Handle())).toBe('Handle(1)');
  });
});
