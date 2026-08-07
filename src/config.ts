import { z } from 'zod';
import { ConfigError } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : !/^(0|false|no|off)$/i.test(v)));

const intFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const httpUrl = (fallback: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v))
    .refine((v) => {
      try {
        return ['http:', 'https:'].includes(new URL(v).protocol);
      } catch {
        return false;
      }
    }, 'must be a valid http(s) URL')
    .transform((v) => v.replace(/\/+$/, ''));

const modelName = (fallback: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v))
    .pipe(z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'invalid model name'));

const EnvSchema = z.object({
  OPENAI_API_KEY: z
    .string({ required_error: 'OPENAI_API_KEY is required' })
    .trim()
    .min(20, 'OPENAI_API_KEY looks truncated')
    .refine((v) => !/\s/.test(v), 'OPENAI_API_KEY must not contain whitespace'),
  OPENAI_BASE_URL: httpUrl('https://api.openai.com/v1'),

  MODEL_EXTRACTION: modelName('gpt-4o-mini'),
  MODEL_ANALYSIS: modelName('gpt-4o-mini'),
  MODEL_IDEAS: modelName('gpt-4o-mini'),
  MODEL_RANKING: modelName('gpt-4o'),

  LLM_TIMEOUT_MS: intFromEnv(60_000, 1_000, 600_000),
  LLM_MAX_RETRIES: intFromEnv(4, 0, 10),
  LLM_CONCURRENCY: intFromEnv(4, 1, 32),
  LLM_MAX_RETRY_DELAY_MS: intFromEnv(30_000, 100, 300_000),

  SHOW_BROWSER: boolFromEnv(true),
  NAV_TIMEOUT_MS: intFromEnv(20_000, 1_000, 120_000),
  MAX_SCROLLS: intFromEnv(3, 0, 50),
  BLOCK_HEAVY_ASSETS: boolFromEnv(true),

  INITIAL_BATCH_SIZE: intFromEnv(10, 1, 100),
  CHUNK_SIZE: intFromEnv(3, 1, 50),
  MAX_POSTS_PER_URL: intFromEnv(200, 1, 5_000),
  MAX_POST_CHARS: intFromEnv(4_000, 200, 40_000),
  MAX_CANDIDATE_BLOCKS: intFromEnv(80, 5, 500),

  ALLOW_PRIVATE_HOSTS: boolFromEnv(false),

  PERSIST_INSIGHTS: boolFromEnv(false),
  INSIGHTS_PATH: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? './insights.json' : v)),
  MAX_STORED_INSIGHTS: intFromEnv(1_000, 10, 100_000),

  LOG_LEVEL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'info' : v.toLowerCase()))
    .pipe(z.enum(LOG_LEVELS)),
  LOG_FORMAT: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? 'pretty' : v.toLowerCase()))
    .pipe(z.enum(['pretty', 'json'])),
});

export interface AppConfig {
  readonly openai: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly maxRetryDelayMs: number;
    readonly concurrency: number;
    readonly models: {
      readonly extraction: string;
      readonly analysis: string;
      readonly ideas: string;
      readonly ranking: string;
    };
  };
  readonly browser: {
    readonly headless: boolean;
    readonly navigationTimeoutMs: number;
    readonly maxScrolls: number;
    readonly blockHeavyAssets: boolean;
  };
  readonly pipeline: {
    readonly initialBatchSize: number;
    readonly chunkSize: number;
    readonly maxPostsPerUrl: number;
    readonly maxPostChars: number;
    readonly maxCandidateBlocks: number;
  };
  readonly network: {
    readonly allowPrivateHosts: boolean;
  };
  readonly storage: {
    readonly enabled: boolean;
    readonly path: string;
    readonly maxEntries: number;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly format: 'pretty' | 'json';
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }

  const e = parsed.data;

  if (e.CHUNK_SIZE > e.INITIAL_BATCH_SIZE) {
    throw new ConfigError('CHUNK_SIZE must not exceed INITIAL_BATCH_SIZE');
  }

  return {
    openai: {
      apiKey: e.OPENAI_API_KEY,
      baseUrl: e.OPENAI_BASE_URL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
      maxRetryDelayMs: e.LLM_MAX_RETRY_DELAY_MS,
      concurrency: e.LLM_CONCURRENCY,
      models: {
        extraction: e.MODEL_EXTRACTION,
        analysis: e.MODEL_ANALYSIS,
        ideas: e.MODEL_IDEAS,
        ranking: e.MODEL_RANKING,
      },
    },
    browser: {
      headless: !e.SHOW_BROWSER,
      navigationTimeoutMs: e.NAV_TIMEOUT_MS,
      maxScrolls: e.MAX_SCROLLS,
      blockHeavyAssets: e.BLOCK_HEAVY_ASSETS,
    },
    pipeline: {
      initialBatchSize: e.INITIAL_BATCH_SIZE,
      chunkSize: e.CHUNK_SIZE,
      maxPostsPerUrl: e.MAX_POSTS_PER_URL,
      maxPostChars: e.MAX_POST_CHARS,
      maxCandidateBlocks: e.MAX_CANDIDATE_BLOCKS,
    },
    network: { allowPrivateHosts: e.ALLOW_PRIVATE_HOSTS },
    storage: {
      enabled: e.PERSIST_INSIGHTS,
      path: e.INSIGHTS_PATH,
      maxEntries: e.MAX_STORED_INSIGHTS,
    },
    logging: { level: e.LOG_LEVEL, format: e.LOG_FORMAT },
  };
}
