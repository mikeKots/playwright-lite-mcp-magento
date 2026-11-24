import { createRequire } from 'node:module';

/** Version of the installed Playwright: the browser build to install must match it. */
const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version;

/** An error whose message is safe and useful to show to the agent as-is. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** Turns any thrown value into a short, agent-readable message. */
export function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof Error) {
    // A missing browser build: Playwright's own install advice is in a box that the cut below would lose.
    if (/Executable doesn't exist/.test(err.message)) {
      const engine = /firefox|webkit/.exec(err.message)?.[0] ?? 'chromium';
      return (
        `The ${engine} browser is not installed for Playwright ${PLAYWRIGHT_VERSION}. ` +
        `The user should run: npx playwright@${PLAYWRIGHT_VERSION} install ${engine} (then retry). ` +
        'The Docker image already includes Chromium.'
      );
    }
    // Playwright appends a long call log; the first lines carry the meaning.
    const head = err.message.split('\n').slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
    const hint =
      err.name === 'TimeoutError'
        ? ' Hint: the element may be missing, hidden or ambiguous; call browser_snapshot to re-inspect the page.'
        : '';
    return `${head}${hint}`;
  }
  return String(err);
}
