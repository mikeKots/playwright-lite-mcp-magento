import * as z from 'zod/v4';
import { isValidPattern } from './security.js';

const MIN_TOKEN_LENGTH = 24;

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

  // Transport. stdio (default): one client, the one that started the process. http: Streamable HTTP
  // on MCP_HTTP_HOST:MCP_HTTP_PORT/mcp, several clients, each MCP session with its own browser context.
  MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
  MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65_535).default(8940),
  // Required for http: clients send "Authorization: Bearer <token>".
  MCP_HTTP_TOKEN: z.string().optional(),
  // Host header names accepted besides localhost (DNS rebinding protection), e.g. "mcp.internal,qa-box".
  MCP_HTTP_ALLOWED_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Each session holds a browser context (~50-150 MB): keep the cap small.
  MCP_MAX_SESSIONS: z.coerce.number().int().positive().max(100).default(5),
  MCP_SESSION_IDLE_MS: z.coerce.number().int().positive().default(30 * 60_000),
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
  if (cfg.MCP_TRANSPORT === 'http') {
    if (!cfg.MCP_HTTP_TOKEN || cfg.MCP_HTTP_TOKEN.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `MCP_HTTP_TOKEN is required with MCP_TRANSPORT=http (at least ${MIN_TOKEN_LENGTH} characters), ` +
          'e.g. the output of: openssl rand -hex 32',
      );
    }
    // browser_run executes agent-written code inside this process: never expose it over the network.
    if (cfg.PW_ALLOW_SCRIPTS) {
      throw new Error('PW_ALLOW_SCRIPTS=true is not allowed with MCP_TRANSPORT=http: browser_run is available over stdio only.');
    }
  }
  return cfg;
}
