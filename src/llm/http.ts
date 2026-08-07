import { LlmHttpError, ScrougeError } from '../errors.js';
import { redact } from '../logger.js';

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Parses `Retry-After`, which may be delta-seconds or an HTTP-date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.min(seconds, 300) * 1000 : undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, Math.min(timestamp - now, 300_000));
}

export interface JsonPostOptions {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * POSTs JSON and returns the parsed response.
 *
 * Enforces a hard timeout (an un-aborted request can otherwise hang the CLI indefinitely) and
 * redacts the response body before it reaches an error message, because provider error payloads
 * frequently echo the submitted Authorization header.
 */
export async function postJson(options: JsonPostOptions): Promise<unknown> {
  const { url, apiKey, body, timeoutMs, signal } = options;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new ScrougeError('LLM_TIMEOUT', `Request timed out after ${timeoutMs}ms`, {
        retryable: true,
        cause: error,
      });
    }
    if (signal?.aborted) throw new ScrougeError('ABORTED', 'Operation aborted', { cause: error });
    throw error;
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    const detail = redact(raw).slice(0, 500);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    throw new LlmHttpError(
      response.status,
      `LLM request failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      {
        retryable: RETRYABLE_STATUS.has(response.status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ScrougeError('LLM_INVALID_RESPONSE', 'LLM returned a non-JSON body', {
      retryable: true,
      cause: error,
    });
  }
}
