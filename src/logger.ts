export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * JSON-lines logger that writes to STDERR.
 * With the stdio transport, STDOUT belongs to the MCP protocol: a single stray
 * console.log there corrupts the JSON-RPC stream and the client disconnects.
 */
export function createLogger(minLevel: LogLevel): Logger {
  const write = (level: LogLevel, msg: string, fields?: Fields) => {
    if (RANK[level] < RANK[minLevel]) return;
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}
