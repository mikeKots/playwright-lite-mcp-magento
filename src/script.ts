import type { Page } from 'playwright';
import { ToolError } from './errors.js';

// `new Function` only builds sync functions; this is the async counterpart.
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export class ScriptTimeoutError extends ToolError {
  override name = 'ScriptTimeoutError';
}

/**
 * "Code mode": runs an agent-written Playwright script in one call instead of
 * many navigate/snapshot/click round-trips. `code` is the body of an async
 * function with `page` (and any `scope` entries, e.g. the `magento` helpers) in scope;
 * its return value is sent back as JSON.
 *
 * NOT a sandbox: the code runs in this Node process with the user's rights.
 * That is why the tool is opt-in (PW_ALLOW_SCRIPTS=true) and meant for local use.
 */
export async function runScript(
  page: Page,
  code: string,
  timeoutMs: number,
  scope: Record<string, unknown> = {},
): Promise<unknown> {
  const names = Object.keys(scope);
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction('page', ...names, code);
  } catch (err) {
    throw new ToolError(`Script has a syntax error: ${err instanceof Error ? err.message : String(err)}`);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ScriptTimeoutError(`Script timed out after ${timeoutMs}ms. Split it into smaller steps.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fn(page, ...names.map((n) => scope[n])), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Turns any script result into compact text: JSON when possible, String() otherwise. */
export function formatResult(value: unknown): string {
  if (value === undefined) return 'Script finished (no return value).';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    // Functions, symbols and Playwright handles stringify to undefined or "{}".
    if (json !== undefined && !(json === '{}' && value !== null && value.constructor !== Object)) return json;
  } catch {
    // Circular structures fall through to String().
  }
  return String(value);
}
