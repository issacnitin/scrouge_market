/** Error taxonomy. Every thrown error carries a stable `code` so callers branch on data, not strings. */

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'URL_REJECTED'
  | 'NAVIGATION_FAILED'
  | 'LLM_HTTP_ERROR'
  | 'LLM_INVALID_RESPONSE'
  | 'LLM_TIMEOUT'
  | 'STORAGE_ERROR'
  | 'ABORTED';

export class ScrougeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** Milliseconds the server explicitly asked us to wait, from a `Retry-After` header. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ScrougeError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class ConfigError extends ScrougeError {
  constructor(message: string, cause?: unknown) {
    super('CONFIG_INVALID', message, cause === undefined ? {} : { cause });
    this.name = 'ConfigError';
  }
}

export class UrlRejectedError extends ScrougeError {
  readonly reason: string;

  constructor(url: string, reason: string) {
    super('URL_REJECTED', `Refused to browse ${url}: ${reason}`);
    this.name = 'UrlRejectedError';
    this.reason = reason;
  }
}

export class LlmHttpError extends ScrougeError {
  readonly status: number;

  constructor(
    status: number,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super('LLM_HTTP_ERROR', message, options);
    this.name = 'LlmHttpError';
    this.status = status;
  }
}

export class LlmInvalidResponseError extends ScrougeError {
  constructor(message: string, cause?: unknown) {
    super('LLM_INVALID_RESPONSE', message, {
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = 'LlmInvalidResponseError';
  }
}

/** Never throws, never returns `[object Object]`. Safe for log lines. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof ScrougeError && err.code === 'ABORTED')
  );
}
