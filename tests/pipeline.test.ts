import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { renderReport } from '../src/pipeline/report.js';
import { aggregateIdeas } from '../src/pipeline/rank.js';
import { InsightStore } from '../src/pipeline/storage.js';
import type { AnalyzedPost } from '../src/pipeline/analyze.js';

const API_KEY = `sk-${'a'.repeat(40)}`;
const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ OPENAI_API_KEY: API_KEY });
    expect(config.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.openai.models.analysis).toBe('gpt-4o-mini');
    expect(config.network.allowPrivateHosts).toBe(false);
    expect(config.browser.headless).toBe(false);
  });

  it('rejects a missing or truncated API key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ OPENAI_API_KEY: 'sk-short' })).toThrow(
      /truncated/,
    );
  });

  it('treats SHOW_BROWSER=0 as headless', () => {
    const config = loadConfig({
      OPENAI_API_KEY: API_KEY,
      SHOW_BROWSER: '0',
    });
    expect(config.browser.headless).toBe(true);
  });

  it('rejects a non-http base URL', () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: API_KEY, OPENAI_BASE_URL: 'ftp://x' }),
    ).toThrow(/valid http/);
  });

  it('rejects out-of-range numeric settings', () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: API_KEY, LLM_CONCURRENCY: '999' }),
    ).toThrow(ConfigError);
  });

  it('rejects a chunk size larger than the initial batch', () => {
    expect(() =>
      loadConfig({
        OPENAI_API_KEY: API_KEY,
        INITIAL_BATCH_SIZE: '2',
        CHUNK_SIZE: '5',
      }),
    ).toThrow(/CHUNK_SIZE/);
  });

  it('rejects an injection-shaped model name', () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: API_KEY, MODEL_ANALYSIS: 'a b"c' }),
    ).toThrow(/invalid model name/);
  });
});

describe('parseCliArgs', () => {
  it('splits comma-separated and repeated --url flags', () => {
    const options = parseCliArgs(['--url', 'https://a.com,https://b.com', '-u', 'https://c.com']);
    expect(options.urls).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });

  it('defaults to interactive, headed mode', () => {
    const options = parseCliArgs([]);
    expect(options.assumeYes).toBe(false);
    expect(options.headless).toBeUndefined();
  });

  it('maps --headless and --headful', () => {
    expect(parseCliArgs(['--headless']).headless).toBe(true);
    expect(parseCliArgs(['--headful']).headless).toBe(false);
  });

  it('rejects contradictory browser flags', () => {
    expect(() => parseCliArgs(['--headless', '--headful'])).toThrow(/mutually exclusive/);
  });

  it('rejects unknown flags instead of silently ignoring them', () => {
    expect(() => parseCliArgs(['--totally-unknown'])).toThrow();
  });
});

describe('InsightStore', () => {
  const newStore = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrouge-'));
    const path = join(dir, 'insights.json');
    return { path, store: new InsightStore({ path, maxEntries: 3, logger: silentLogger }) };
  };

  const entry = (summary: string) => ({
    timestamp: new Date().toISOString(),
    sourceUrl: 'https://example.com',
    summary,
    sentiment: 'neutral',
    topics: ['x'],
  });

  it('returns an empty list when the file does not exist', async () => {
    const { store } = await newStore();
    await expect(store.read()).resolves.toEqual([]);
  });

  it('appends and reads back entries', async () => {
    const { store } = await newStore();
    await store.append([entry('one')]);
    await store.append([entry('two')]);

    const all = await store.read();
    expect(all.map((e) => e.summary)).toEqual(['one', 'two']);
  });

  it('caps the log at maxEntries, keeping the newest', async () => {
    const { store } = await newStore();
    await store.append([entry('1'), entry('2'), entry('3'), entry('4'), entry('5')]);

    const all = await store.read();
    expect(all.map((e) => e.summary)).toEqual(['3', '4', '5']);
  });

  it('quarantines a corrupt file instead of crashing', async () => {
    const { path, store } = await newStore();
    await writeFile(path, 'not json at all', 'utf8');

    await expect(store.read()).resolves.toEqual([]);
    await expect(readFile(`${path}.bak`, 'utf8')).resolves.toBe('not json at all');
  });

  it('quarantines a file whose contents do not match the schema', async () => {
    const { path, store } = await newStore();
    await writeFile(path, JSON.stringify([{ unexpected: true }]), 'utf8');
    await expect(store.read()).resolves.toEqual([]);
  });

  it('is a no-op for an empty append', async () => {
    const { path, store } = await newStore();
    await store.append([]);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });
});

describe('aggregateIdeas', () => {
  const analyzed = (sentiment: 'positive' | 'negative', title: string): AnalyzedPost => ({
    post: `post about ${title}`,
    analysis: { summary: 's', sentiment, topics: ['t'], toxicityScore: 0 },
    ideas: [{ title, pitch: 'p', differentiator: 'd', pricing: '$10' }],
  });

  it('merges identical ideas and accumulates signal', () => {
    const store = aggregateIdeas([
      analyzed('positive', 'Widget'),
      analyzed('positive', 'widget'), // same idea, different casing
      analyzed('negative', 'Gadget'),
    ]);

    expect(store.size).toBe(2);
    expect(store.get('widget')?.count).toBe(2);
    expect(store.get('widget')?.sentimentSum).toBe(2);
    expect(store.get('gadget')?.sentimentSum).toBe(-1);
  });

  it('returns an empty map when no ideas were produced', () => {
    expect(aggregateIdeas([]).size).toBe(0);
  });
});

describe('renderReport', () => {
  it('explains when there is nothing to show', () => {
    expect(renderReport([], new Map(), { color: false })).toMatch(/No product ideas/);
  });

  it('renders ranked ideas without ANSI codes when color is off', () => {
    const output = renderReport(
      [
        {
          idea: 'Widget — does things',
          priority: 1,
          score: 8.5,
          rationale: 'Strong demand.',
          estimatedRevenueUsd: 120000,
          recommendedPriceRange: '$99/mo',
          goToMarketChannels: ['reddit', 'seo'],
        },
      ],
      new Map(),
      { color: false },
    );

    expect(output).toContain('Widget — does things');
    expect(output).toContain('$120,000');
    expect(output).toContain('reddit, seo');
    expect(output).not.toContain('\u001b[');
  });
});
