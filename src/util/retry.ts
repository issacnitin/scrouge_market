import { ScrougeError, describeError, isAbortError } from '../errors.js';

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  factor?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Defaults to the `retryable` flag on ScrougeError, plus common transient network codes. */
  isRetryable?: (error: unknown) => boolean;
}

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function defaultIsRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ScrougeError) return error.retryable;

  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;

  return /\bfetch failed\b|\bnetwork\b|\btimed? ?out\b/i.test(describeError(error));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScrougeError('ABORTED', 'Operation aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ScrougeError('ABORTED', 'Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential backoff with full jitter. A server-supplied `Retry-After` always wins over
 * the computed delay, and every delay is clamped to `maxDelayMs` so a long retry chain
 * cannot stall the run for minutes.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs, signal, onRetry } = options;
  const factor = options.factor ?? 2;
  const retryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new ScrougeError('ABORTED', 'Operation aborted');

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === retries || !retryable(error)) throw error;

      const serverHint =
        error instanceof ScrougeError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : undefined;

      const exponential = baseDelayMs * Math.pow(factor, attempt);
      const jittered = Math.random() * exponential;
      const delayMs = Math.min(maxDelayMs, Math.max(serverHint ?? jittered, baseDelayMs));

      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}
