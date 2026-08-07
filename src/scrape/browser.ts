import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from '../config.js';
import { ScrougeError, describeError } from '../errors.js';
import type { Logger } from '../logger.js';
import { assertUrlAllowed } from '../net/url-guard.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

function baseHeaders(): Record<string, string> {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    dnt: '1',
    'upgrade-insecure-requests': '1',
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-user': '?1',
    'sec-fetch-dest': 'document',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
  };
}

export interface BrowserSession {
  readonly page: Page;
  close(): Promise<void>;
}

export async function createSession(config: AppConfig, logger: Logger): Promise<BrowserSession> {
  const { headless, navigationTimeoutMs, blockHeavyAssets } = config.browser;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({
      headless,
      slowMo: headless ? 0 : 40,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    });

    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: baseHeaders(),
    });

    context.setDefaultTimeout(navigationTimeoutMs);
    context.setDefaultNavigationTimeout(navigationTimeoutMs);

    if (blockHeavyAssets) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        void (BLOCKED_RESOURCE_TYPES.has(type) ? route.abort() : route.continue());
      });
    }

    const page = await context.newPage();
    const owned = { browser, context };

    return {
      page,
      close: async () => {
        // Close inner-to-outer and never let a teardown failure mask the original error.
        for (const step of [
          () => owned.context.close(),
          () => owned.browser.close(),
        ]) {
          try {
            await step();
          } catch (error) {
            logger.debug('browser teardown step failed', { error: describeError(error) });
          }
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    throw error;
  }
}

export interface NavigationResult {
  finalUrl: string;
}

const BLOCKED_LANDING_PAGE = /\/(login|signin|signup|consent|challenge|captcha|blocked)\b|native_app/i;

/**
 * Navigates to an already-validated URL and re-validates wherever the site actually landed.
 *
 * The pre-flight guard only covers the URL the user typed; a redirect can still send the
 * browser to an internal address, so the post-navigation URL is checked again.
 */
export async function openUrl(
  page: Page,
  url: URL,
  config: AppConfig,
  logger: Logger,
): Promise<NavigationResult> {
  await page.setExtraHTTPHeaders({ ...baseHeaders(), referer: url.origin });

  const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

  if (response && response.status() >= 400) {
    throw new ScrougeError('NAVIGATION_FAILED', `${url.host} returned HTTP ${response.status()}`);
  }

  const finalUrl = page.url();
  if (finalUrl !== url.toString()) {
    await assertUrlAllowed(finalUrl, { allowPrivateHosts: config.network.allowPrivateHosts });
    logger.debug('followed redirect', { from: url.toString(), to: finalUrl });
  }

  if (BLOCKED_LANDING_PAGE.test(finalUrl)) {
    throw new ScrougeError(
      'NAVIGATION_FAILED',
      `Redirected to a login/consent wall (${finalUrl}); this site blocks automated access`,
    );
  }

  await page.waitForLoadState('networkidle').catch(() => undefined);
  return { finalUrl };
}

/** Scrolls to trigger lazy loading. Returns true when the page grew. */
export async function scrollForMore(page: Page): Promise<boolean> {
  const before = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight * 0.9);
  });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1_000);
  const after = await page.evaluate(() => document.body.scrollHeight);
  return after > before;
}
