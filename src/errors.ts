/** An error whose message is safe and useful to show to the agent as-is. */
export class ToolError extends Error {
  override name = 'ToolError';
}

/** Turns any thrown value into a short, agent-readable message. */
export function describeError(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof Error) {
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
