import type { Page } from 'playwright';

/**
 * Clicks the first visible cookie-consent button whose accessible name matches one of `names`.
 * Consent scripts usually render after DOMContentLoaded, so this waits up to `timeoutMs`.
 * Returns the matched button name, or undefined when no banner appeared. Never throws:
 * a missing banner is normal (consent already given, or the page has none).
 */
export async function acceptCookieBanner(
  page: Page,
  names: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  if (names.length === 0) return undefined;
  const buttons = names.map((name) => page.getByRole('button', { name, exact: true }));
  let any = buttons[0]!;
  for (const b of buttons.slice(1)) any = any.or(b);
  try {
    await any.first().waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    return undefined;
  }
  for (const [i, button] of buttons.entries()) {
    if (!(await button.first().isVisible())) continue;
    try {
      await button.first().click({ timeout: timeoutMs });
      return names[i];
    } catch {
      return undefined;
    }
  }
  return undefined;
}
