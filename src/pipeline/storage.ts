import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ScrougeError, describeError } from '../errors.js';
import type { Logger } from '../logger.js';

const StoredEntrySchema = z.object({
  timestamp: z.string(),
  sourceUrl: z.string(),
  summary: z.string(),
  sentiment: z.string(),
  topics: z.array(z.string()),
});
export type StoredEntry = z.infer<typeof StoredEntrySchema>;

const StoreSchema = z.array(StoredEntrySchema);

export interface InsightStoreOptions {
  path: string;
  maxEntries: number;
  logger: Logger;
}

/**
 * Append-only insight log.
 *
 * Writes are atomic (temp file + rename) so an interrupt cannot leave a half-written JSON
 * document behind, entries are schema-validated on read so a corrupted or hand-edited file
 * cannot inject arbitrary shapes downstream, and the log is capped so a long run cannot grow
 * the file without bound.
 */
export class InsightStore {
  constructor(private readonly options: InsightStoreOptions) {}

  async read(): Promise<StoredEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.options.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ScrougeError('STORAGE_ERROR', `Cannot read ${this.options.path}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine('not valid JSON');
      return [];
    }

    const validated = StoreSchema.safeParse(parsed);
    if (!validated.success) {
      await this.quarantine('did not match the expected schema');
      return [];
    }

    return validated.data;
  }

  async append(entries: readonly StoredEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const existing = await this.read();
    const merged = [...existing, ...entries].slice(-this.options.maxEntries);

    const tempPath = join(
      dirname(this.options.path),
      `.${randomBytes(6).toString('hex')}.insights.tmp`,
    );

    try {
      await writeFile(tempPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tempPath, this.options.path);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw new ScrougeError('STORAGE_ERROR', `Cannot write ${this.options.path}`, {
        cause: error,
      });
    }
  }

  private async quarantine(reason: string): Promise<void> {
    const backup = `${this.options.path}.bak`;
    this.options.logger.warn(`insights file ${reason}; moving it aside`, { backup });
    try {
      await rename(this.options.path, backup);
    } catch (error) {
      this.options.logger.debug('quarantine failed', { error: describeError(error) });
    }
  }
}
