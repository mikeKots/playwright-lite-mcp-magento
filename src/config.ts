import * as z from 'zod/v4';
import { isValidPattern } from './security.js';

const EnvSchema = z.object({
  PW_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  PW_HEADLESS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  PW_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  PW_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PW_ACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PW_SNAPSHOT_MAX_CHARS: z.coerce.number().int().positive().default(15_000),
  PW_STORAGE_STATE: z.string().min(1).optional(),
  PW_COOKIE_ACCEPT: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  PW_COOKIE_WAIT_MS: z.coerce.number().int().nonnegative().default(2_000),
  // Code mode (browser_run) executes agent-written JS in this process: off unless explicitly enabled.
  PW_ALLOW_SCRIPTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Local dev only: trust self-signed certificates (Warden/DDEV/Valet CAs are not in a Docker image).
  PW_IGNORE_HTTPS_ERRORS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  PW_SCRIPT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof EnvSchema>;

/** Fails fast at startup: a misconfigured server should never reach the agent. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg = parsed.data;

  if (cfg.PW_ALLOWED_ORIGINS.length === 0) {
    throw new Error(
      'PW_ALLOWED_ORIGINS is required, e.g. "http://localhost:3000,https://*.example.com" (or "*" to allow any site).',
    );
  }
  const invalid = cfg.PW_ALLOWED_ORIGINS.filter((p) => !isValidPattern(p));
  if (invalid.length > 0) {
    throw new Error(`Invalid PW_ALLOWED_ORIGINS entries: ${invalid.join(', ')}`);
  }
  return cfg;
}
