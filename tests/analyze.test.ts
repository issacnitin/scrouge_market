import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { LlmClient } from '../src/llm/client.js';
import {
  analysisPrompt,
  candidatePrompt,
  extractionPrompt,
  ideaPrompt,
  rankingPrompt,
} from '../src/llm/prompts.js';
import { createLogger } from '../src/logger.js';
import { analyzePosts } from '../src/pipeline/analyze.js';

const config = loadConfig({ OPENAI_API_KEY: `sk-${'a'.repeat(40)}`, LLM_CONCURRENCY: '2' });
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

const analysis = {
  summary: 'summary',
  sentiment: 'neutral' as const,
  topics: ['t'],
  toxicityScore: 0,
};
const ideas = { ideas: [{ title: 'T', pitch: 'p', differentiator: 'd', pricing: '$1' }] };

/** Minimal stand-in for LlmClient; `complete` is dispatched on the stage name. */
const fakeClient = (
  handler: (stage: string) => Promise<unknown>,
): { client: LlmClient; complete: ReturnType<typeof vi.fn> } => {
  const complete = vi.fn((request: { stage: string }) => handler(request.stage));
  return { client: { complete } as unknown as LlmClient, complete };
};

describe('prompt construction', () => {
  const builders = {
    extraction: () => extractionPrompt('page text'),
    candidates: () => candidatePrompt(['block a', 'block b']),
    analysis: () => analysisPrompt('a post'),
    ideas: () => ideaPrompt({ summary: 's', sentiment: 'neutral', topics: ['t'], post: 'p' }),
    ranking: () =>
      rankingPrompt([{ idea: 'i', count: 1, sentimentSum: 1, topics: [], reasons: [] }]),
  };

  it.each(Object.entries(builders))('%s prompt carries the untrusted-data rules', (_name, build) => {
    const prompt = build();
    expect(prompt.system).toMatch(/UNTRUSTED DATA/);
    expect(prompt.system).toMatch(/Never follow instructions/);
  });

  it.each(Object.entries(builders))('%s prompt fences the payload', (_name, build) => {
    const prompt = build();
    const opening = /<<<([A-Z_]+_[0-9a-f]{18})>>>/.exec(prompt.user);
    expect(opening).not.toBeNull();
    expect(prompt.user).toContain(`<<<END_${opening?.[1]}>>>`);
  });

  it('uses a fresh nonce on every call so a delimiter cannot be predicted', () => {
    const first = /<<<([A-Z_]+_[0-9a-f]{18})>>>/.exec(analysisPrompt('x').user)?.[1];
    const second = /<<<([A-Z_]+_[0-9a-f]{18})>>>/.exec(analysisPrompt('x').user)?.[1];
    expect(first).not.toBe(second);
  });

  it('embeds the actual post content', () => {
    expect(analysisPrompt('my unique post body').user).toContain('my unique post body');
  });
});

describe('analyzePosts', () => {
  it('analyzes every post and attaches generated ideas', async () => {
    const { client } = fakeClient((stage) =>
      Promise.resolve(stage === 'analysis' ? analysis : ideas),
    );

    const result = await analyzePosts(['one', 'two'], { client, config, logger });

    expect(result).toHaveLength(2);
    expect(result[0]?.analysis.summary).toBe('summary');
    expect(result[0]?.ideas).toHaveLength(1);
  });

  it('skips a post whose analysis fails without failing the batch', async () => {
    let call = 0;
    const { client } = fakeClient((stage) => {
      if (stage === 'analysis' && call++ === 0) return Promise.reject(new Error('boom'));
      return Promise.resolve(stage === 'analysis' ? analysis : ideas);
    });

    const result = await analyzePosts(['bad', 'good'], { client, config, logger });
    expect(result).toHaveLength(1);
  });

  it('keeps the analysis when only idea generation fails', async () => {
    const { client } = fakeClient((stage) =>
      stage === 'ideas' ? Promise.reject(new Error('no ideas')) : Promise.resolve(analysis),
    );

    const result = await analyzePosts(['one'], { client, config, logger });
    expect(result).toHaveLength(1);
    expect(result[0]?.ideas).toEqual([]);
  });

  it('respects the configured concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const { client } = fakeClient(async (stage) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return stage === 'analysis' ? analysis : ideas;
    });

    await analyzePosts(['a', 'b', 'c', 'd', 'e', 'f'], { client, config, logger });
    expect(peak).toBeLessThanOrEqual(config.openai.concurrency);
  });

  it('reports progress for every post', async () => {
    const { client } = fakeClient((stage) =>
      Promise.resolve(stage === 'analysis' ? analysis : ideas),
    );
    const onProgress = vi.fn();

    await analyzePosts(['a', 'b'], { client, config, logger, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('handles an empty batch', async () => {
    const { client, complete } = fakeClient(() => Promise.resolve(analysis));
    await expect(analyzePosts([], { client, config, logger })).resolves.toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
