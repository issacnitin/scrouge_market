import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LlmHttpError } from '../src/errors.js';
import { LlmClient, extractJsonObject } from '../src/llm/client.js';
import { parseRetryAfter, postJson } from '../src/llm/http.js';
import { postAnalysis } from '../src/llm/schemas.js';
import { createLogger, redact } from '../src/logger.js';

const API_KEY = `sk-${'a'.repeat(40)}`;

const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    OPENAI_API_KEY: API_KEY,
    LLM_MAX_RETRIES: '1',
    LLM_TIMEOUT_MS: '2000',
    LLM_MAX_RETRY_DELAY_MS: '100',
    ...overrides,
  });

const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

const analysisBody = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const validAnalysis = {
  summary: 'A short summary.',
  sentiment: 'neutral',
  topics: ['a', 'b'],
  toxicityScore: 0.1,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative delay for a past date', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('caps absurd values at five minutes', () => {
    expect(parseRetryAfter('99999')).toBe(300_000);
  });

  it('returns undefined for missing or unparseable headers', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('redact', () => {
  it('removes API keys, bearer tokens and key-value secrets', () => {
    expect(redact(`key ${API_KEY} end`)).toBe('key [REDACTED] end');
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuv')).toContain('[REDACTED]');
    expect(redact('{"api_key":"abcdefghijklmnop"}')).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('postJson', () => {
  it('redacts credentials echoed back in provider error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: `Incorrect API key: ${API_KEY}` } }), {
          status: 401,
        }),
      ),
    );

    const error = await postJson({
      url: 'https://api.test/v1/chat/completions',
      apiKey: API_KEY,
      body: {},
      timeoutMs: 1_000,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmHttpError);
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).toContain('[REDACTED]');
  });

  it('marks 429 as retryable and surfaces Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
        ),
    );

    const error = (await postJson({
      url: 'https://api.test/v1/chat/completions',
      apiKey: API_KEY,
      body: {},
      timeoutMs: 1_000,
    }).catch((e: unknown) => e)) as LlmHttpError;

    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7_000);
  });

  it('does not mark 401 as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })));

    const error = (await postJson({
      url: 'https://api.test/v1/chat/completions',
      apiKey: API_KEY,
      body: {},
      timeoutMs: 1_000,
    }).catch((e: unknown) => e)) as LlmHttpError;

    expect(error.retryable).toBe(false);
  });
});

describe('extractJsonObject', () => {
  it('parses a plain JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON inside a markdown code fence', () => {
    expect(extractJsonObject('Sure!\n```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
  });

  it('parses JSON surrounded by prose', () => {
    expect(extractJsonObject('Here you go: {"a":{"b":2}} hope that helps!')).toEqual({
      a: { b: 2 },
    });
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJsonObject('{"a":"}{ not real"}')).toEqual({ a: '}{ not real' });
  });

  it('is not confused by escaped quotes', () => {
    expect(extractJsonObject('{"a":"say \\"hi\\""}')).toEqual({ a: 'say "hi"' });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('[1,2,3]')).toBeNull();
  });
});

describe('LlmClient', () => {
  const request = {
    stage: 'test',
    model: 'gpt-4o-mini',
    system: 'system',
    user: 'user',
    maxOutputTokens: 100,
    schema: postAnalysis,
  };

  it('validates and returns a well-formed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(analysisBody(validAnalysis)));

    const client = new LlmClient(testConfig(), silentLogger);
    await expect(client.complete(request)).resolves.toEqual(validAnalysis);
    expect(client.getUsage().requests).toBe(1);
  });

  it('caches identical requests instead of paying twice', async () => {
    const stub = vi.fn().mockResolvedValue(analysisBody(validAnalysis));
    vi.stubGlobal('fetch', stub);

    const client = new LlmClient(testConfig(), silentLogger);
    await client.complete(request);
    await client.complete(request);

    expect(stub).toHaveBeenCalledTimes(1);
    expect(client.getUsage().cacheHits).toBe(1);
  });

  it('rejects output that violates the schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(analysisBody({ ...validAnalysis, sentiment: 'furious' })),
    );

    const client = new LlmClient(testConfig({ LLM_MAX_RETRIES: '0' }), silentLogger);
    await expect(client.complete(request)).rejects.toThrow(/failed post_analysis validation/);
  });

  it('rejects a truncated response rather than returning partial data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summ' }, finish_reason: 'length' }],
          }),
          { status: 200 },
        ),
      ),
    );

    const client = new LlmClient(testConfig({ LLM_MAX_RETRIES: '0' }), silentLogger);
    await expect(client.complete(request)).rejects.toThrow(/truncated/);
  });

  it('surfaces a model refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { refusal: 'cannot help' } }] }),
          { status: 200 },
        ),
      ),
    );

    const client = new LlmClient(testConfig({ LLM_MAX_RETRIES: '0' }), silentLogger);
    await expect(client.complete(request)).rejects.toThrow(/refused/);
  });

  it('requests structured output with a strict JSON schema', async () => {
    const stub = vi.fn().mockResolvedValue(analysisBody(validAnalysis));
    vi.stubGlobal('fetch', stub);

    await new LlmClient(testConfig(), silentLogger).complete(request);

    const body = JSON.parse(String(stub.mock.calls[0]?.[1]?.body)) as {
      response_format: { type: string; json_schema: { strict: boolean } };
      max_completion_tokens: number;
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.max_completion_tokens).toBe(100);
  });
});
