import { z } from 'zod';
import { ConfigError } from './errors.js';
import {
  PROVIDERS,
  PROVIDER_SPECS,
  discoverCredential,
  isProviderId,
  type CommandRunner,
  type ProviderId,
  type ProviderSpec,
} from './llm/provider.js';
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

// GitHub Models identifiers are publisher-qualified, so '/' is permitted.
const modelName = (fallback: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : v))
    .pipe(z.string().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/, 'invalid model name'));

const buildEnvSchema = (spec: ProviderSpec) =>
  z.object({
    OPENAI_BASE_URL: httpUrl(spec.defaultBaseUrl),

    MODEL_EXTRACTION: modelName(spec.defaultModels.extraction),
    MODEL_ANALYSIS: modelName(spec.defaultModels.analysis),
    MODEL_IDEAS: modelName(spec.defaultModels.ideas),
    MODEL_RANKING: modelName(spec.defaultModels.ranking),

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
  readonly llm: {
    readonly provider: ProviderId;
    readonly providerLabel: string;
    readonly apiKey: string;
    /** How the credential was found, for logging. Never contains the credential itself. */
    readonly credentialSource: string;
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

export interface LoadConfigOptions {
  /** Injectable for tests so the GitHub CLI is never invoked from a unit test. */
  commandRunner?: CommandRunner;
}

function resolveProvider(raw: string | undefined): ProviderId {
  const value = (raw ?? 'openai').trim().toLowerCase();
  if (!isProviderId(value)) {
    throw new ConfigError(
      `Unknown LLM_PROVIDER "${value}". Supported providers: ${PROVIDERS.join(', ')}.`,
    );
  }
  return value;
}

function describeCredentialSource(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  spec: ProviderSpec,
): string {
  for (const name of spec.credentialEnvVars) {
    if (env[name]?.trim()) return `${name} environment variable`;
  }
  return provider === 'github-models' ? 'GitHub CLI login (gh auth token)' : 'environment';
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const provider = resolveProvider(env.LLM_PROVIDER);
  const spec = PROVIDER_SPECS[provider];

  const parsed = buildEnvSchema(spec).safeParse(env);
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

  const credential = discoverCredential(provider, env, options.commandRunner);
  if (!credential) {
    throw new ConfigError(
      `No credential found for provider "${provider}" (${spec.label}).\n${spec.setupHint}`,
    );
  }
  if (/\s/.test(credential)) {
    throw new ConfigError(`The ${spec.label} credential must not contain whitespace.`);
  }
  if (credential.length < 20) {
    throw new ConfigError(`The ${spec.label} credential looks truncated.`);
  }

  return {
    llm: {
      provider,
      providerLabel: spec.label,
      apiKey: credential,
      credentialSource: describeCredentialSource(provider, env, spec),
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
