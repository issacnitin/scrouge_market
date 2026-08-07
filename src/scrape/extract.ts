import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { describeError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import { candidatePrompt, extractionPrompt } from '../llm/prompts.js';
import { postsExtraction } from '../llm/schemas.js';
import type { Logger } from '../logger.js';
import { dedupePosts, sanitizeUntrusted, splitIntoChunks } from '../util/text.js';

const POST_SELECTORS = [
  'article',
  '[role="article"]',
  '[data-testid*="post"]',
  '[data-test-id*="post"]',
  '[class*="post"]',
  '[class*="comment"]',
  '[class*="reply"]',
] as const;

const MIN_BLOCK_CHARS = 40;
const MAX_BLOCK_CHARS = 8_000;
const CHUNK_CHARS = 12_000;
const CHUNK_OVERLAP = 300;
const CANDIDATE_BATCH_CHARS = 10_000;

/**
 * Collects candidate text blocks from the DOM.
 *
 * The traversal is bounded (node budget, per-block length cap, total block cap) because the
 * previous full `body *` scan on a large feed could materialize tens of megabytes of duplicated
 * strings, once in the page and again in Node.
 */
export async function getCandidateBlocks(
  page: Page,
  maxBlocks: number,
  logger: Logger,
): Promise<string[]> {
  try {
    return await page.evaluate(
      ({ selectors, limit, minChars, maxChars }) => {
        const seen = new Set<string>();
        const NODE_BUDGET = 5_000;
        let visited = 0;

        const add = (value: string | null | undefined): void => {
          if (!value) return;
          const text = value.trim();
          if (text.length < minChars || text.length > maxChars) return;
          if (text.split(/\s+/).length < 6) return;
          seen.add(text);
        };

        for (const selector of selectors) {
          if (seen.size >= limit) break;
          let elements: NodeListOf<Element>;
          try {
            elements = document.querySelectorAll(selector);
          } catch {
            continue;
          }
          for (const element of Array.from(elements)) {
            if (seen.size >= limit || ++visited > NODE_BUDGET) break;
            add((element as HTMLElement).innerText ?? element.textContent);
          }
        }

        // Leaf-oriented fallback: elements with few children are usually message bodies
        // rather than layout containers, which avoids capturing the same text at every depth.
        if (seen.size < limit) {
          for (const element of Array.from(document.querySelectorAll('p, li, div, section'))) {
            if (seen.size >= limit || ++visited > NODE_BUDGET) break;
            if (element.childElementCount > 5) continue;
            add((element as HTMLElement).innerText ?? element.textContent);
          }
        }

        return Array.from(seen).slice(0, limit);
      },
      {
        selectors: [...POST_SELECTORS],
        limit: maxBlocks,
        minChars: MIN_BLOCK_CHARS,
        maxChars: MAX_BLOCK_CHARS,
      },
    );
  } catch (error) {
    logger.warn('candidate block collection failed', { error: describeError(error) });
    return [];
  }
}

function batchByChars(items: readonly string[], limit: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;

  for (const item of items) {
    if (size + item.length > limit && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface ExtractionDeps {
  page: Page;
  client: LlmClient;
  config: AppConfig;
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * Multi-strategy post extraction: DOM candidates filtered by the LLM, then a chunked
 * full-text pass, then a pure-DOM fallback. Each strategy is independently fault-tolerant so
 * one failure degrades quality instead of aborting the URL.
 */
export async function extractPosts(deps: ExtractionDeps): Promise<string[]> {
  const { page, client, config, logger, signal } = deps;
  const { maxPostChars, maxCandidateBlocks, maxPostsPerUrl } = config.pipeline;

  const finish = (posts: string[]): string[] =>
    dedupePosts(posts.map((post) => sanitizeUntrusted(post, maxPostChars))).slice(
      0,
      maxPostsPerUrl,
    );

  const candidates = await getCandidateBlocks(page, maxCandidateBlocks, logger);
  if (candidates.length > 0) {
    const collected: string[] = [];
    const batches = batchByChars(candidates, CANDIDATE_BATCH_CHARS);

    for (const [index, batch] of batches.entries()) {
      if (signal?.aborted) break;
      try {
        const prompt = candidatePrompt(batch.slice(0, 50));
        const result = await client.complete({
          stage: 'extract-candidates',
          model: config.openai.models.extraction,
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens: 4_000,
          temperature: 0,
          schema: postsExtraction,
          ...(signal ? { signal } : {}),
        });
        collected.push(...result.posts);
        logger.debug('candidate batch extracted', {
          batch: index + 1,
          of: batches.length,
          posts: result.posts.length,
        });
      } catch (error) {
        logger.warn('candidate batch failed', {
          batch: index + 1,
          error: describeError(error),
        });
      }
    }

    const posts = finish(collected);
    if (posts.length > 0) return posts;
  }

  logger.debug('falling back to full-text extraction');
  const bodyText = await page.innerText('body').catch(() => '');
  if (bodyText.trim()) {
    const collected: string[] = [];
    for (const chunk of splitIntoChunks(bodyText, CHUNK_CHARS, CHUNK_OVERLAP)) {
      if (signal?.aborted) break;
      try {
        const prompt = extractionPrompt(chunk);
        const result = await client.complete({
          stage: 'extract-fulltext',
          model: config.openai.models.extraction,
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens: 4_000,
          temperature: 0,
          schema: postsExtraction,
          ...(signal ? { signal } : {}),
        });
        collected.push(...result.posts);
      } catch (error) {
        logger.warn('full-text chunk failed', { error: describeError(error) });
      }
    }
    const posts = finish(collected);
    if (posts.length > 0) return posts;
  }

  logger.debug('falling back to DOM-only extraction');
  const domPosts: string[] = [];
  for (const selector of POST_SELECTORS) {
    try {
      const texts = await page.$$eval(selector, (elements) =>
        elements.slice(0, 100).map((el) => (el as HTMLElement).innerText?.trim() ?? ''),
      );
      domPosts.push(...texts.filter((text) => text.length >= MIN_BLOCK_CHARS));
    } catch {
      // Selector unsupported on this page; try the next one.
    }
  }

  return finish(domPosts);
}
