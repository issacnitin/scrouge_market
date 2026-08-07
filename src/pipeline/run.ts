import type { AppConfig } from '../config.js';
import { ScrougeError, UrlRejectedError, describeError, isAbortError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import type { Logger } from '../logger.js';
import { assertUrlAllowed } from '../net/url-guard.js';
import { createSession, openUrl, scrollForMore } from '../scrape/browser.js';
import { extractPosts } from '../scrape/extract.js';
import { dedupePosts } from '../util/text.js';
import { analyzePosts, type AnalyzedPost } from './analyze.js';
import { renderReport } from './report.js';
import { aggregateIdeas, rankIdeas } from './rank.js';
import type { InsightStore, StoredEntry } from './storage.js';

export interface RunOptions {
  urls: readonly string[];
  config: AppConfig;
  logger: Logger;
  client: LlmClient;
  signal: AbortSignal;
  /** Returns false to stop early. Non-interactive runs pass a function that always resolves true. */
  confirmContinue: () => Promise<boolean>;
  write: (text: string) => void;
  store?: InsightStore;
}

export interface RunSummary {
  urlsProcessed: number;
  urlsFailed: number;
  postsAnalyzed: number;
  ideasRanked: number;
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const { urls, config, logger, client, signal, write } = options;

  const summary: RunSummary = {
    urlsProcessed: 0,
    urlsFailed: 0,
    postsAnalyzed: 0,
    ideasRanked: 0,
  };

  // Validate every URL before launching a browser, so a typo does not cost a Chromium start.
  const validated: URL[] = [];
  for (const raw of urls) {
    try {
      validated.push(
        await assertUrlAllowed(raw, { allowPrivateHosts: config.network.allowPrivateHosts }),
      );
    } catch (error) {
      summary.urlsFailed++;
      if (error instanceof UrlRejectedError) logger.error(error.message);
      else logger.error('URL validation failed', { url: raw, error: describeError(error) });
    }
  }

  if (validated.length === 0) {
    logger.error('No usable URLs; nothing to do.');
    return summary;
  }

  const session = await createSession(config, logger);

  try {
    for (const url of validated) {
      if (signal.aborted) break;

      const urlLogger = logger.child({ url: url.host });
      try {
        await processUrl(url, { ...options, logger: urlLogger }, session.page, summary);
        summary.urlsProcessed++;
      } catch (error) {
        if (isAbortError(error)) break;
        summary.urlsFailed++;
        urlLogger.error('failed to process URL', { error: describeError(error) });
      }
    }
  } finally {
    // Runs on success, failure and Ctrl-C alike, so Chromium never outlives the CLI.
    await session.close();
  }

  const usage = client.getUsage();
  logger.info('run complete', {
    ...summary,
    llmRequests: usage.requests,
    llmCacheHits: usage.cacheHits,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });

  write('');
  return summary;
}

async function processUrl(
  url: URL,
  options: RunOptions,
  page: Awaited<ReturnType<typeof createSession>>['page'],
  summary: RunSummary,
): Promise<void> {
  const { config, logger, client, signal, write, confirmContinue, store } = options;

  logger.info('browsing');
  await openUrl(page, url, config, logger);

  const collected: string[] = [];
  let scrolls = 0;

  const loadMore = async (): Promise<number> => {
    const before = collected.length;
    const posts = await extractPosts({
      page,
      client,
      config,
      logger,
      ...(signal ? { signal } : {}),
    });
    collected.push(...posts);
    const deduped = dedupePosts(collected).slice(0, config.pipeline.maxPostsPerUrl);
    collected.length = 0;
    collected.push(...deduped);
    return collected.length - before;
  };

  await loadMore();
  while (collected.length < config.pipeline.initialBatchSize && scrolls < config.browser.maxScrolls) {
    if (signal.aborted) return;
    scrolls++;
    if (!(await scrollForMore(page))) break;
    if ((await loadMore()) === 0) break;
  }

  if (collected.length === 0) {
    logger.warn('no posts found on this page');
    return;
  }

  logger.info('posts collected', { count: collected.length });

  let cursor = 0;
  let batchSize = config.pipeline.initialBatchSize;

  while (cursor < collected.length) {
    if (signal.aborted) return;

    const batch = collected.slice(cursor, cursor + batchSize);
    cursor += batch.length;

    logger.info('analyzing batch', { posts: batch.length, from: cursor - batch.length });

    const analyzed = await analyzePosts(batch, {
      client,
      config,
      logger,
      ...(signal ? { signal } : {}),
      onProgress: (done, total) => logger.debug('analysis progress', { done, total }),
    });
    summary.postsAnalyzed += analyzed.length;

    const aggregates = aggregateIdeas(analyzed);
    try {
      const result = await rankIdeas(aggregates, { client, config, signal });
      summary.ideasRanked += result.ranked.length;
      write(renderReport(result.ranked, aggregates, { color: process.stdout.isTTY === true }));
    } catch (error) {
      if (isAbortError(error)) return;
      logger.warn('ranking failed; showing unranked ideas', { error: describeError(error) });
      write(
        [...aggregates.values()]
          .sort((a, b) => b.count - a.count)
          .map((entry) => ` - ${entry.idea}`)
          .join('\n'),
      );
    }

    await persist(store, url, analyzed, logger);

    batchSize = config.pipeline.chunkSize;

    if (cursor >= collected.length && scrolls < config.browser.maxScrolls) {
      if (await scrollForMore(page)) {
        scrolls++;
        await loadMore();
      }
    }

    if (cursor >= collected.length) return;
    if (!(await confirmContinue())) {
      logger.info('stopping at user request');
      throw new ScrougeError('ABORTED', 'Stopped by user');
    }
  }
}

async function persist(
  store: InsightStore | undefined,
  url: URL,
  analyzed: readonly AnalyzedPost[],
  logger: Logger,
): Promise<void> {
  if (!store || analyzed.length === 0) return;

  const entries: StoredEntry[] = analyzed.map((item) => ({
    timestamp: new Date().toISOString(),
    sourceUrl: url.toString(),
    summary: item.analysis.summary,
    sentiment: item.analysis.sentiment,
    topics: [...item.analysis.topics],
  }));

  try {
    await store.append(entries);
  } catch (error) {
    logger.warn('failed to persist insights', { error: describeError(error) });
  }
}
