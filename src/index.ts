import { existsSync } from 'node:fs';
import process from 'node:process';
import { createAutoPrompter, createPrompter, parseCliArgs, USAGE, type Prompter } from './cli.js';
import { loadConfig, type AppConfig } from './config.js';
import { ConfigError, describeError, isAbortError } from './errors.js';
import { LlmClient } from './llm/client.js';
import { createLogger } from './logger.js';
import { renderBanner } from './pipeline/report.js';
import { run } from './pipeline/run.js';
import { InsightStore } from './pipeline/storage.js';

const VERSION = '1.0.0';

function loadDotEnv(): void {
  // Node's built-in loader: keeps secrets out of the process table and avoids a dotenv dependency.
  if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile('.env');
    } catch {
      // A malformed .env should not prevent the CLI from starting with real env vars.
    }
  }
}

async function main(): Promise<number> {
  const options = parseCliArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (options.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }

  loadDotEnv();

  if (options.headless !== undefined) {
    process.env.SHOW_BROWSER = options.headless ? '0' : '1';
  }

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nSee .env.example for the expected values.\n`);
      return 78; // EX_CONFIG
    }
    throw error;
  }

  const logger = createLogger({ level: config.logging.level, format: config.logging.format });
  const controller = new AbortController();

  // First signal requests a graceful stop so the browser and readline are torn down properly;
  // a second signal is treated as "I mean it" and exits immediately.
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) {
      process.stderr.write('\nForced exit.\n');
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write('\nStopping… (press Ctrl+C again to force quit)\n');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const interactive = !options.assumeYes && process.stdin.isTTY === true;
  let prompter: Prompter = options.assumeYes
    ? createAutoPrompter(options.urls)
    : createPrompter(controller.signal);

  try {
    if (process.stderr.isTTY === true) {
      process.stderr.write(renderBanner(true) + '\n');
    }

    let urls = options.urls;
    if (urls.length === 0) {
      if (!interactive) {
        process.stderr.write('No URLs provided. Pass --url <url> or run interactively.\n');
        return 64; // EX_USAGE
      }
      urls = await prompter.askUrls();
    }
    if (urls.length === 0) {
      process.stderr.write('No URLs provided.\n');
      return 64;
    }
    if (!interactive && !options.assumeYes) {
      prompter = createAutoPrompter(urls);
    }

    const client = new LlmClient(config, logger);
    const store = config.storage.enabled
      ? new InsightStore({
          path: config.storage.path,
          maxEntries: config.storage.maxEntries,
          logger,
        })
      : undefined;

    const summary = await run({
      urls,
      config,
      logger,
      client,
      signal: controller.signal,
      confirmContinue: () => prompter.confirmContinue(),
      write: (text) => process.stdout.write(text + '\n'),
      ...(store ? { store } : {}),
    });

    if (summary.urlsProcessed === 0) return 1;
    return 0;
  } catch (error) {
    if (isAbortError(error)) return 130;
    logger.error('fatal error', { error: describeError(error) });
    return 1;
  } finally {
    prompter.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Unexpected failure: ${describeError(error)}\n`);
    process.exitCode = 1;
  });
