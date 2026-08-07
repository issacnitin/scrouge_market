import { describe, expect, it, vi } from 'vitest';
import { LlmHttpError, ScrougeError } from '../src/errors.js';
import { defaultIsRetryable, retry, sleep } from '../src/util/retry.js';
import { Semaphore, mapWithConcurrency } from '../src/util/concurrency.js';

const fast = { retries: 3, baseDelayMs: 1, maxDelayMs: 5 };

describe('retry', () => {
  it('returns the first successful result without delay', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    await expect(retry(op, fast)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries retryable failures and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new LlmHttpError(503, 'unavailable', { retryable: true }))
      .mockResolvedValue('ok');

    await expect(retry(op, fast)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    const op = vi.fn().mockRejectedValue(new LlmHttpError(401, 'bad key', { retryable: false }));
    await expect(retry(op, fast)).rejects.toThrow(/bad key/);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of retries', async () => {
    const op = vi.fn().mockRejectedValue(new LlmHttpError(500, 'boom', { retryable: true }));
    await expect(retry(op, fast)).rejects.toThrow(/boom/);
    expect(op).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it('clamps a large Retry-After to maxDelayMs so a run cannot stall', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(
        new LlmHttpError(429, 'rate limited', { retryable: true, retryAfterMs: 300_000 }),
      )
      .mockResolvedValue('ok');

    const started = Date.now();
    await expect(retry(op, { retries: 1, baseDelayMs: 1, maxDelayMs: 20 })).resolves.toBe('ok');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports each retry through onRetry', async () => {
    const onRetry = vi.fn();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new LlmHttpError(500, 'x', { retryable: true }))
      .mockResolvedValue('ok');

    await retry(op, { ...fast, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const op = vi.fn().mockResolvedValue('ok');

    await expect(retry(op, { ...fast, signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(op).not.toHaveBeenCalled();
  });
});

describe('defaultIsRetryable', () => {
  it('honours the retryable flag on ScrougeError', () => {
    expect(defaultIsRetryable(new ScrougeError('LLM_HTTP_ERROR', 'x', { retryable: true }))).toBe(
      true,
    );
    expect(defaultIsRetryable(new ScrougeError('LLM_HTTP_ERROR', 'x'))).toBe(false);
  });

  it('treats transient socket errors as retryable', () => {
    expect(defaultIsRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(defaultIsRetryable(new Error('fetch failed'))).toBe(true);
  });

  it('never retries an abort', () => {
    expect(defaultIsRetryable(new ScrougeError('ABORTED', 'stopped'))).toBe(false);
  });
});

describe('sleep', () => {
  it('rejects when aborted mid-sleep', async () => {
    const controller = new AbortController();
    const pending = sleep(5_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
  });
});

describe('Semaphore', () => {
  it('never exceeds the permit count', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        semaphore.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(2);
          active--;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases the permit even when the task throws', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(semaphore.run(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
  });

  it('rejects an invalid permit count', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await sleep(ms / 10);
      return ms;
    });
    expect(results.map((r) => r.value)).toEqual([30, 10, 20]);
  });

  it('captures individual failures instead of rejecting the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, (n) =>
      n === 2 ? Promise.reject(new Error('bad')) : Promise.resolve(n),
    );

    expect(results[0]?.value).toBe(1);
    expect(results[1]?.error).toBeInstanceOf(Error);
    expect(results[2]?.value).toBe(3);
  });

  it('handles an empty input list', async () => {
    await expect(mapWithConcurrency([], 4, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
