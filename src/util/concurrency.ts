import { ScrougeError } from '../errors.js';

/** Counting semaphore used to cap in-flight LLM requests process-wide. */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`Semaphore permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.makeRelease();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // guard against double-release corrupting the permit count
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available++;
    };
  }
}

export interface MapResult<R> {
  index: number;
  value: R | undefined;
  error: unknown;
}

/**
 * Runs `fn` over `items` with at most `limit` concurrent executions, preserving input order
 * in the result. Individual failures are captured rather than thrown so one bad post cannot
 * abort an entire batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<MapResult<R>[]> {
  const results: MapResult<R>[] = new Array<MapResult<R>>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      if (signal?.aborted) {
        results[index] = {
          index,
          value: undefined,
          error: new ScrougeError('ABORTED', 'Operation aborted'),
        };
        continue;
      }
      try {
        results[index] = { index, value: await fn(items[index] as T, index), error: undefined };
      } catch (error) {
        results[index] = { index, value: undefined, error };
      }
    }
  };

  await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
  return results;
}
