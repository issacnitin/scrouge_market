import { describeError } from './errors.js';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Patterns for values that must never reach stdout, a log file, or an LLM prompt.
 * Provider error bodies routinely echo the submitted Authorization header.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:api[-_]?key|authorization|access[-_]?token|secret)"?\s*[:=]\s*"?[A-Za-z0-9._~+/-]{12,}"?/gi,
];

/** Strips credentials from arbitrary text. Applied to every log line and every LLM error message. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const COLORS: Record<LogLevel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

function serializeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? describeError(value) : value;
  }
  return out;
}

export function createLogger(options: {
  level: LogLevel;
  format: 'pretty' | 'json';
  bindings?: Record<string, unknown>;
  sink?: (line: string) => void;
}): Logger {
  const { level, format } = options;
  const bindings = options.bindings ?? {};
  // Logs go to stderr so piping stdout to a file yields only the report.
  const sink = options.sink ?? ((line: string) => process.stderr.write(line + '\n'));

  const emit = (entry: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[entry] > LEVEL_RANK[level]) return;

    const merged = serializeFields({ ...bindings, ...(fields ?? {}) });

    if (format === 'json') {
      sink(
        redact(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: entry,
            msg: message,
            ...merged,
          }),
        ),
      );
      return;
    }

    const suffix = Object.keys(merged).length
      ? ' ' +
        Object.entries(merged)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(' ')
      : '';
    sink(redact(`${COLORS[entry]}${entry.padEnd(5)}${RESET} ${message}${suffix}`));
  };

  const make = (currentBindings: Record<string, unknown>): Logger => ({
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (extra) =>
      createLogger({
        level,
        format,
        bindings: { ...currentBindings, ...extra },
        ...(options.sink ? { sink: options.sink } : {}),
      }),
  });

  return make(bindings);
}
