import { chromium } from 'playwright';
import { analyzePost } from './nlp.ts';
import * as readline from 'readline';

async function browseAndAnalyze(urls: string[]) {
    // Show the browser window while Playwright is working.
    // You can set SHOW_BROWSER=0 in env to avoid showing (if needed).
    const showBrowser = process.env.SHOW_BROWSER === '0' ? false : true;
    const browser = await chromium.launch({
        headless: !showBrowser,                // headful when showBrowser=true
        devtools: showBrowser,                 // open devtools when visible
        slowMo: showBrowser ? 40 : 0,          // slight slowdown to observe actions
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
        ],
    });

    // Build a realistic set of HTTP headers commonly sent by browsers.
    const buildBaseHeaders = () => ({
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        dnt: '1',
        'upgrade-insecure-requests': '1',
        'sec-fetch-site': 'none',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document',
        'cache-control': 'max-age=0',
        pragma: 'no-cache',
        // Client hint style headers (use conservative values that mimic Chrome)
        'sec-ch-ua': '"Chromium";v="115", "Not A(Brand";v="8", "Google Chrome";v="115"',
        'sec-ch-ua-platform': '"Windows"',
        'sec-ch-ua-mobile': '?0',
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
        extraHTTPHeaders: buildBaseHeaders(), // set base headers at context level
    });

    const page = await context.newPage();
    // Helper to set per-page headers (adds referer derived from target URL if available)
    async function applyHeadersForUrl(p: any, targetUrl?: string) {
        try {
            const headers = { ...buildBaseHeaders() } as Record<string, string>;
            if (targetUrl) {
                try {
                    const u = new URL(targetUrl);
                    headers.referer = u.origin;
                } catch { /* ignore invalid URL */ }
            }
            await p.setExtraHTTPHeaders(headers);
        } catch (e) {
            // Non-fatal if setting headers fails
            console.warn('Failed to apply extra headers:', e?.message || e);
        }
    }

    for (const url of urls) {
        console.log(`Browsing: ${url}`);
        try {
            // apply realistic headers including referer for this navigation
            await applyHeadersForUrl(page, url);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('networkidle').catch(() => {});

            const finalUrl = page.url();
            if (/login|signup|consent|native_app|app=/.test(finalUrl)) {
                console.warn(`Skipped URL due to redirect/blocked page: ${finalUrl}`);
                continue;
            }

            // Iteratively scroll to load more posts, collect them, and analyze in chunks of 10
            const collectedSet = new Set<string>();
            let processedCount = 0;
            const INITIAL_BATCH = 10;          // only load/analyze 10 posts initially
            let initialBatchDone = false;
            const CHUNK_SIZE = 3;
            const MAX_SCROLLS = 3;
            const NO_NEW_LIMIT = 5;
            let scrolls = 0;
            let noNewCount = 0;
            let stopProcessing = false; // stop when user opts out

            // Idea store entry type
            type IdeaEntry = {
                count: number;
                examples: string[]; // sample post texts
                sentimentSum: number; // +1 pos, -1 neg, 0 neutral aggregated
                topics: Set<string>;
                reasons: Set<string>;
            };

            // helper to analyze a chunk array of posts; collects ideas in ideaStore
            const analyzeChunk = async (chunk: string[], ideaStore: Map<string, IdeaEntry>) => {
                for (const post of chunk) {
                    try {
                        const preview = (post || '').replace(/\s+/g, ' ').trim().slice(0, 140);
                        console.log(`Analyzing post (${processedCount + 1}): "${preview}${(post || '').length > 140 ? '...' : ''}"`);
                        const insight = await retryWithBackoff(() => analyzePost(post), {
                            retries: 5,
                            baseDelayMs: 20000,
                            factor: 2,
                            onRetry: (err, attempt) => {
                                console.warn(`analyzePost retry #${attempt} due to:`, err?.message || err);
                            },
                        });
                        if (insight) {

                            // Generate product/service ideas and accumulate into the ideaStore
                            try {
                                const ideas = await generateProductIdeas(insight, post);
                                const sentiment = (insight?.sentiment || '').toString().toLowerCase();
                                const sScore = sentiment.includes('pos') ? 1 : sentiment.includes('neg') ? -1 : 0;
                                const topics: string[] = Array.isArray(insight?.topics) ? insight.topics.map(String) : [];

                                for (const idea of ideas) {
                                    const key = idea;
                                    let entry = ideaStore.get(key);
                                    if (!entry) {
                                        entry = {
                                            count: 0,
                                            examples: [],
                                            sentimentSum: 0,
                                            topics: new Set<string>(),
                                            reasons: new Set<string>(),
                                        };
                                    }
                                    entry.count += 1;
                                    if (entry.examples.length < 3) entry.examples.push(post.trim().slice(0, 300));
                                    entry.sentimentSum += sScore;
                                    topics.slice(0, 5).forEach(t => entry!.topics.add(t));
                                    if (insight?.summary) entry.reasons.add(String(insight.summary).slice(0, 200));
                                    ideaStore.set(key, entry);
                                }
                            } catch (e) {
                                console.warn('Failed to generate product ideas:', e?.message || e);
                            }
                        }
                    } catch (e) {
                        console.error('Error analyzing post:', e);
                    } finally {
                        processedCount++;
                    }
                }
            };

            // initial small wait to ensure content loaded
            await page.waitForTimeout(500);

            while (scrolls < MAX_SCROLLS) {
                // fetch posts visible so far
                const postsNow = await fetchPostsFromPage(page);
                const beforeSize = collectedSet.size;
                for (const p of postsNow) collectedSet.add(p);
                const afterSize = collectedSet.size;

                const newFound = afterSize - beforeSize;
                if (newFound === 0) noNewCount++; else noNewCount = 0;
                console.log(`Collected total posts: ${afterSize} (new: ${newFound})`);

                const allPosts = Array.from(collectedSet);

                // FIRST: handle the initial small batch (exactly INITIAL_BATCH)
                if (!initialBatchDone && allPosts.length - processedCount >= INITIAL_BATCH) {
                    const initialChunk = allPosts.slice(processedCount, processedCount + INITIAL_BATCH);
                    const ideaStore = new Map<string, IdeaEntry>();
                    await analyzeChunk(initialChunk, ideaStore);
                    await finalizeIdeasAndDisplay(ideaStore);
                    initialBatchDone = true;

                    // Ask user whether to continue loading more posts and analysis
                    try {
                        const cont = await askContinue();
                        if (!cont) {
                            console.log('User chose to stop after initial batch for this URL.');
                            stopProcessing = true;
                            break;
                        } else {
                            // If user wants more, proactively scroll to load more before continuing analysis
                            await page.evaluate(() => { window.scrollBy(0, window.innerHeight * 1.5); });
                            await page.waitForLoadState('networkidle').catch(() => {});
                            await page.waitForTimeout(1200);
                            scrolls++;
                            // continue to next iteration to fetch newly loaded posts
                            continue;
                        }
                    } catch (e) {
                        console.warn('Continue prompt failed after initial batch, proceeding by default.');
                        initialBatchDone = true;
                    }
                }

                if (stopProcessing) break;

                // After initial batch, process remaining posts in CHUNK_SIZE batches as before,
                // prompting the user after each processed chunk.
                while (allPosts.length - processedCount >= CHUNK_SIZE) {
                    const chunk = allPosts.slice(processedCount, processedCount + CHUNK_SIZE);
                    // fresh in-memory store per batch/chunk
                    const ideaStore = new Map<string, IdeaEntry>();
                    await analyzeChunk(chunk, ideaStore);
                    // finalize and display ideas for this batch
                    await finalizeIdeasAndDisplay(ideaStore);

                    // ask user whether to continue after this batch
                    try {
                        const cont = await askContinue();
                        if (!cont) {
                            console.log('User chose to stop further processing for this URL.');
                            stopProcessing = true;
                            break;
                        } else {
                            // if they want more, break so the outer loop can scroll/load more posts
                            break;
                        }
                    } catch (e) {
                        console.warn('Continue prompt failed, proceeding by default.');
                    }
                }

                if (stopProcessing) break;

                // stop if we've exhausted posts and no new ones after several scrolls
                if (noNewCount >= NO_NEW_LIMIT) {
                    console.log('No new posts after several scrolls — stopping scroll loop.');
                    break;
                }

                // attempt to scroll to load more posts
                await page.evaluate(() => { window.scrollBy(0, window.innerHeight * 0.9); });
                await page.waitForLoadState('networkidle').catch(() => {});
                await page.waitForTimeout(1200);
                scrolls++;
            }

            // process remaining posts (final partial chunk)
            const remaining = Array.from(collectedSet).slice(processedCount);
            if (remaining.length > 0) {
                console.log(`Processing final ${remaining.length} remaining posts`);
                const ideaStore = new Map<string, IdeaEntry>();
                await analyzeChunk(remaining, ideaStore);
                await finalizeIdeasAndDisplay(ideaStore);
                // final batch prompt after remaining partial chunk
                try {
                    const cont = await askContinue();
                    if (!cont) {
                        console.log('User chose to stop further processing for this URL.');
                    }
                } catch { /* ignore prompt errors */ }
            }

            await page.waitForTimeout(1000);
        } catch (err) {
            console.error(`Error processing ${url}:`, err);
            continue;
        }
    }

    await browser.close();
}

// Add retry helper
async function retryWithBackoff<T>(
    operation: () => Promise<T>,
    opts?: { retries?: number; baseDelayMs?: number; factor?: number; onRetry?: (err: any, attempt: number) => void }
): Promise<T> {
    const retries = opts?.retries ?? 5;
    const baseDelayMs = opts?.baseDelayMs ?? 1000;
    const factor = opts?.factor ?? 2;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await operation();
        } catch (err: any) {
            const msg = String(err?.message || '').toLowerCase();
            const isRetryable = /rate limit|429|too many requests|timeout|timed out|etimedout|econnreset|ecancelled|fetch failed/i.test(msg)
                || (err && (err.status === 429 || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET'));

            if (!isRetryable || attempt === retries) {
                throw err;
            }

            opts?.onRetry?.(err, attempt + 1);

            const jitter = Math.floor(Math.random() * 300);
            const delay = Math.floor(baseDelayMs * Math.pow(factor, attempt)) + jitter;
            await new Promise(res => setTimeout(res, delay));
        }
    }
    throw new Error('Unreachable retry logic error');
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// Print a compact graphical intro/banner when the agent is invoked
function printIntro() {
    const bold = '\x1b[1m';
    const cyan = '\x1b[36m';
    const yellow = '\x1b[33m';
    const reset = '\x1b[0m';

    const art = [
        '_________                                                                       \n' +
        '/   _____/ ___________  ____  __ __  ____   ____                                \n' +
        '\\_____  \\_/ ___\\_  __ \\/  _ \\|  |  \\/ ___\\_/ __ \\                               \n' +
        '/        \\  \\___|  | \\(  <_> )  |  / /_/  >  ___/                               \n' +
       '/_______  /\\___  >__|   \\____/|____/\\___  / \\___  >                              \n' +
        '       \\/     \\/                  /_____/      \\/                               \n'
    ];

    console.log(cyan + bold + 'Scrouge — Market Idea Agent' + reset);
    art.forEach(line => console.log(cyan + line + reset));
    console.log('');
    console.log(yellow + 'Tips:' + reset + ' set SHOW_BROWSER=0 to run headless; set OPENAI_API_KEY to enable LLM suggestions.');
    console.log('');
}

// show intro immediately when the script runs
printIntro();

rl.question('Enter URLs separated by commas: ', (input) => {
    const urls = input.split(',').map(url => url.trim());
    browseAndAnalyze(urls).catch(console.error).finally(() => rl.close());
});

// Prompt helper that reuses the readline interface to ask whether to continue.
async function askContinue(): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            rl.question('Continue to next batch? (y/n): ', (ans) => {
                const a = (ans || '').trim().toLowerCase();
                if (a === 'n' || a === 'no') {
                    console.log('Quitting by user request.');
                    try { rl.close(); } catch {}
                    // exit immediately
                    process.exit(0);
                }
                resolve(a === 'y' || a === 'yes');
            });
        } catch {
            // on any failure, default to continue
            resolve(true);
        }
    });
}

// New LLM extractor using OpenAI-compatible API via fetch.
// Accepts {html, text}, splits large text into chunks, queries the LLM per chunk and aggregates results.
async function extractPostsWithLLM(input: { html?: string; text?: string }): Promise<string[]> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is required in environment');

    const raw = (input.text && input.text.trim().length > 0) ? input.text : (input.html || '');
    if (!raw) return [];

    const MAX_CHUNK = 12000; // characters per chunk (tune as needed)
    const OVERLAP = 300; // overlap characters between chunks

    const chunks = splitIntoChunks(raw, MAX_CHUNK, OVERLAP);
    const collected: string[] = [];

    const systemPrompt = `You are a helpful extractor. Given visible text, extract distinct user-visible "posts" or meaningful message blocks (e.g., social media posts, forum messages). Return only valid JSON in the exact format:

{"posts": ["post 1 text", "post 2 text", ...]}

Do not include any additional commentary. Prefer the visible plaintext content, strip UI chrome, timestamps, or usernames unless they are part of the message. Keep posts trimmed.`;

    // Helper to call LLM for one chunk
    async function callLLMForChunk(chunk: string): Promise<string[]> {
        const body = {
            model: 'gpt-4o-mini', // change model as needed
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Extract posts from the following text (do NOT add commentary):\n\n${chunk}` },
            ],
            temperature: 0.0,
            max_tokens: 1500,
        };

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`LLM request failed: ${resp.status} ${resp.statusText} - ${txt}`);
        }

        const json = await resp.json().catch(() => null);
        const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
        if (!content) throw new Error('Empty LLM response');

        // Extract JSON blob if present
        try {
            const match = content.match(/\{[\s\S]*\}/m);
            const jsonText = match ? match[0] : content;
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed.posts)) return parsed.posts.map((p: any) => String(p).trim()).filter(Boolean);
            throw new Error('LLM returned JSON but no "posts" array found');
        } catch {
            // fallback: split by lines
            const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
            return lines;
        }
    }

    for (const chunk of chunks) {
        try {
            const posts = await retryWithBackoff(() => callLLMForChunk(chunk), {
                retries: 2,
                baseDelayMs: 800,
                factor: 2,
                onRetry: (err, attempt) => console.warn('LLM chunk retry', attempt, err?.message || err),
            });
            collected.push(...posts.map(p => p.trim()).filter(Boolean));
        } catch (e) {
            console.warn('Failed to extract from chunk, continuing with others:', e?.message || e);
            // continue to try other chunks
        }
    }

    // Deduplicate and return
    const deduped = Array.from(new Set(collected)).filter(Boolean);
    return deduped;
}

// small helper to split text into overlapping chunks
function splitIntoChunks(text: string, maxLen: number, overlap = 0): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + maxLen, text.length);
        let chunk = text.slice(start, end);
        chunks.push(chunk);
        if (end === text.length) break;
        start = Math.max(0, end - overlap);
    }
    return chunks;
}

// New helper: collect candidate blocks from page using many selectors + heuristics
async function getCandidateBlocks(page: any): Promise<string[]> {
    try {
        const candidates = await page.evaluate(() => {
            const sels = [
                'article',
                '[role="article"]',
                '[data-testid*="post"]',
                '[data-test-id*="post"]',
                'div[class*="post"]',
                'div[class*="comment"]',
                'div[class*="reply"]',
                'section',
                'main'
            ];
            const set = new Set<string>();

            for (const sel of sels) {
                document.querySelectorAll(sel).forEach((el) => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    if (txt.length > 40 && txt.split(/\s+/).length > 5) {
                        set.add(txt);
                    }
                });
            }

            // Fallback scan: capture moderately long text nodes with few children (likely message blocks)
            document.querySelectorAll('body *').forEach((el) => {
                try {
                    const txt = (el.textContent || '').trim();
                    if (txt.length > 120 && el.childElementCount < 6) {
                        set.add(txt);
                    }
                } catch (e) {
                    // ignore
                }
            });

            // Return limited number to avoid huge requests
            return Array.from(set).slice(0, 80);
        });

        return (candidates || []).map((c: string) => c.trim()).filter(Boolean);
    } catch (e) {
        console.warn('getCandidateBlocks failed:', e?.message || e);
        return [];
    }
}

// New helper: batch candidate blocks and ask the LLM to pick & normalize posts
async function extractPostsFromCandidates(candidates: string[]): Promise<string[]> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY is required in environment');

    // Build batches by character size to respect token limits
    const BATCH_CHAR_LIMIT = 10000;
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentSize = 0;

    for (const cand of candidates) {
        const len = cand.length;
        if (currentSize + len > BATCH_CHAR_LIMIT && currentBatch.length > 0) {
            batches.push(currentBatch);
            currentBatch = [];
            currentSize = 0;
        }
        currentBatch.push(cand);
        currentSize += len;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const systemPrompt = `You are an extractor. Given a list of candidate text blocks (each may be a UI fragment or a user-visible message), return a JSON object exactly like:
{"posts": ["post text 1", "post text 2", ...]}
Only include true user-visible posts/messages, normalized and trimmed. Do not include UI chrome, timestamps or usernames unless they are integral to the message.`;

    const collected: string[] = [];

    // render progress for batches in-place on a single console line
    function renderBatchProgress(current: number, total: number, items: number) {
        try {
            const width = 30;
            const ratio = Math.max(0, Math.min(1, current / total));
            const filled = Math.round(ratio * width);
            const empty = width - filled;
            const bar = '█'.repeat(filled) + '-'.repeat(empty);
            const pct = Math.round(ratio * 100);
            const text = `Extracting candidate batches ${current}/${total} [${bar}] ${pct}% (${items} items)`;
            process.stdout.write('\r' + text);
        } catch {
            // fallback silent if stdout unavailable
        }
    }

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        renderBatchProgress(i + 1, batches.length, batch.length);
        const userPrompt = `Here are candidate blocks (JSON array). For each, include it as source but only return items that are actual posts/messages.\n\n${JSON.stringify(batch.slice(0, 50))}\n\nReturn exactly: {"posts":[...]} without extra commentary.`;
        const body = {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.0,
            max_tokens: 1500,
        };

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            console.warn(`LLM batch failed: ${resp.status} ${resp.statusText} - ${txt}`);
            continue;
        }

        const json = await resp.json().catch(() => null);
        const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
        if (!content) {
            console.warn('Empty LLM batch response');
            continue;
        }

        // Attempt to parse JSON blob
        try {
            const match = content.match(/\{[\s\S]*\}/m);
            const jsonText = match ? match[0] : content;
            const parsed = JSON.parse(jsonText);
            if (Array.isArray(parsed.posts)) {
                collected.push(...parsed.posts.map((p: any) => String(p).trim()).filter(Boolean));
            }
        } catch (e) {
            // fallback: split lines
            const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
            collected.push(...lines);
        }
    }
    // ensure we move to the next line after finishing progress updates
    try { process.stdout.write('\n'); } catch {}

    // dedupe and return
    return Array.from(new Set(collected)).filter(Boolean);
}

// New helper: fetch visible posts from page using existing extractors
async function fetchPostsFromPage(page: any): Promise<string[]> {
    try {
        const html = await page.content();
        const text = await page.innerText('body').catch(() => '');
        // Try candidate-based extraction first
        const candidates = await getCandidateBlocks(page);
        if (candidates && candidates.length > 0) {
            try {
                const res = await extractPostsFromCandidates(candidates);
                if (Array.isArray(res) && res.length > 0) return res.map(r => r.trim()).filter(Boolean);
            } catch (e) {
                console.warn('extractPostsFromCandidates failed:', e?.message || e);
            }
        }
        // Fallback: full-text extractor (chunked)
        try {
            const res = await extractPostsWithLLM({ html, text });
            if (Array.isArray(res) && res.length > 0) return res.map(r => r.trim()).filter(Boolean);
        } catch (e) {
            console.warn('extractPostsWithLLM failed:', e?.message || e);
        }
        // Final DOM fallback: simple selector scan
        try {
            const selectors = [
                '.post',
                'div.Post',
                'div[data-testid="post-container"]',
                'div[data-test-id="post-content"]',
                'article',
                '[role="article"]'
            ];
            let posts: string[] = [];
            for (const sel of selectors) {
                try {
                    const items = await page.$$eval(sel, elements => elements.map(el => el.textContent?.trim() || ''));
                    if (items && items.length > 0) posts = posts.concat(items);
                } catch {
                }
            }
            if (posts.length === 0) {
                const bodyText = await page.$$eval('body *', els =>
                    els.map(el => (el.textContent || '').trim()).filter(Boolean)
                );
                posts = bodyText.slice(0, 40);
            }
            return Array.from(new Set(posts)).filter(Boolean);
        } catch (e) {
            console.warn('DOM fallback failed:', e?.message || e);
            return [];
        }
    } catch (e) {
        console.warn('fetchPostsFromPage failed:', e?.message || e);
        return [];
    }
}

// Generate a short list of product/service ideas from analysis insight.
async function generateProductIdeas(insight: any, postText?: string): Promise<string[]> {
    const key = process.env.OPENAI_API_KEY;
    // simple fallback kept minimal
    function fallbackGenerator(): string[] {
        const summary = (insight?.summary || '').toString().replace(/\s+/g, ' ').trim();
        if (!summary) return [];
        return [
            `Concise solution guide: "${summary.slice(0, 120)}" — targeted info product to validate demand.`,
        ].slice(0, 3);
    }
    if (!key) return fallbackGenerator();

    const input = {
        summary: (insight?.summary || '').toString().replace(/\s+/g, ' ').trim().slice(0, 800),
        sentiment: (insight?.sentiment || '').toString().toLowerCase(),
        topics: Array.isArray(insight?.topics) ? insight.topics.map(String).slice(0, 5) : [],
        examples: Array.isArray(insight?.examples) ? insight.examples.map(String).slice(0, 2) : [],
        post: (postText || '').toString().slice(0, 800),
    };

    // Strong instruction to produce non-obvious, high-value opportunities only.
    const systemPrompt = `You are a senior product strategy advisor focused on high-leverage, differentiated, revenue-ready opportunities. Ignore generic "guides", "subscriptions" or trivial productizations unless you can justify why they are unique and high-value.`;

    const userPrompt = `Input JSON:
${JSON.stringify(input, null, 2)}

TASK: Return AT MOST 3 non-obvious, high-value product or service ideas that are clearly differentiated and monetizable. Each idea must be a single string in this exact compact format (no extra text, return EXACTLY a JSON array of strings):

"Title — 1-line pitch (what it does) | Why this is high-value & differentiated (one short reason) | Suggested price/packaging"

Examples (do NOT copy these): 
["On-demand field calibration service — Rapid on-site calibration for [topic] | High-value because it eliminates costly downtime for pros | Suggested: $299/site or $49/mo monitoring"]

Constraints:
- Be specific (mention the target user or context).
- Emphasize why it's non-obvious (unique channel, technical moat, business model lever).
- Prioritize ideas that can command $100+ initial or $20+/mo recurring where sensible.
- Limit to max 3 items. Return EXACTLY one JSON array and nothing else.`;

    // helper calling LLM
    async function callLLMIdeas(): Promise<string> {
        const body = {
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.0,
            max_tokens: 600,
        };

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`LLM request failed: ${resp.status} ${resp.statusText} - ${txt}`);
        }

        const json = await resp.json().catch(() => null);
        const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
        if (!content) throw new Error('Empty LLM response');
        return content;
    }

    // tolerant parsing for a JSON array of strings
    function parseArrayFromContent(content: string): string[] | null {
        if (!content || typeof content !== 'string') return null;
        const first = content.indexOf('[');
        const last = content.lastIndexOf(']');
        if (first === -1 || last === -1 || last <= first) return null;
        let arrText = content.slice(first, last + 1);
        try {
            const parsed = JSON.parse(arrText);
            if (Array.isArray(parsed)) return parsed.map(String).map(s => s.trim()).filter(Boolean).slice(0, 3);
            return null;
        } catch {
            try {
                const sanitized = arrText.replace(/,\s*([}\]])/g, '$1').replace(/[\u2018\u2019\u201C\u201D]/g, '"');
                const parsed2 = JSON.parse(sanitized);
                if (Array.isArray(parsed2)) return parsed2.map(String).map(s => s.trim()).filter(Boolean).slice(0, 3);
                return null;
            } catch {
                return null;
            }
        }
    }

    // Basic generic-filter to drop obviously vague items
    function filterGeneric(items: string[]): string[] {
        const genericPatterns = [/guide/i, /checklist/i, /subscription delivering/i, /curated/i, /introductory/i];
        const filtered: string[] = [];
        for (const it of items) {
            const low = it.toLowerCase();
            const isGeneric = genericPatterns.some(p => p.test(low));
            if (!isGeneric && !filtered.includes(it)) filtered.push(it);
        }
        // If everything is filtered out, return original up to 3
        return filtered.length > 0 ? filtered.slice(0, 3) : items.slice(0, 3);
    }

    try {
        const raw = await retryWithBackoff(() => callLLMIdeas(), {
            retries: 2,
            baseDelayMs: 800,
            factor: 2,
            onRetry: (err, attempt) => console.warn('LLM idea retry', attempt, err?.message || err),
        });

        const parsed = parseArrayFromContent(raw);
        if (parsed && parsed.length > 0) {
            return filterGeneric(parsed);
        }

        // loose fallback: extract plausible lines
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 30);
        if (lines.length > 0) return filterGeneric(lines).slice(0, 3);

        console.warn('Failed to parse LLM ideas JSON, falling back. Raw (truncated):', raw.slice(0, 800));
        return fallbackGenerator();
    } catch (e) {
        console.warn('Error generating product ideas with LLM:', e?.message || e);
        return fallbackGenerator();
    }
}

// Compute a simple score and render detailed documents for each idea (sorted by estimated revenue)
async function finalizeIdeasAndDisplay(ideaStore: Map<string, any>): Promise<void> {
    if (!ideaStore || ideaStore.size === 0) {
        console.log('No product ideas generated for this batch.');
        return;
    }

    // Build structured payload for the LLM (limit to avoid huge requests)
    const MAX_ITEMS_TO_SEND = 30;
    const ideasPayload: any[] = [];
    for (const [idea, entry] of ideaStore.entries()) {
        ideasPayload.push({
            idea: String(idea),
            count: entry.count || 0,
            sentimentSum: entry.sentimentSum || 0,
            topics: Array.isArray(entry.topics) ? entry.topics : Array.from(entry.topics || []),
            examples: Array.isArray(entry.examples) ? entry.examples : (entry.examples ? Array.from(entry.examples) : []),
            reasons: entry.reasons ? Array.from(entry.reasons) : [],
        });
        if (ideasPayload.length >= MAX_ITEMS_TO_SEND) break;
    }

    const systemPrompt = `You are an expert product/market analyst. Given a list of candidate product ideas with simple signals (count, sentimentSum, topics, examples, reasons), rank them by priority and return a concise JSON object only with the shape: {"ranked":[{"idea":"string","priority":1,"score":4.2,"rationale":"text","estimated_revenue_usd":12345,"recommended_price_range":"$","go_to_market_channels":["c"],"examples":["..."]}]}.`;
    const userPrompt = `Input:\n${JSON.stringify({ ideas: ideasPayload }, null, 2)}\n\nOutput must be EXACT valid JSON as described. Keep rationale concise.`;

    async function callLLMRaw(): Promise<string> {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error('OPENAI_API_KEY is required in environment');
        const body = {
            model: 'gpt-5.1',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.0,
            max_completion_tokens: 15000,
        };
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`LLM request failed: ${resp.status} ${resp.statusText} - ${txt}`);
        }
        const json = await resp.json().catch(() => null);
        const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
        if (!content) throw new Error('Empty LLM response');
        return content;
    }

    // tolerant parser extracting first {...}
    function safeParseJSON(content: string): any | null {
        if (!content || typeof content !== 'string') return null;
        const first = content.indexOf('{');
        const last = content.lastIndexOf('}');
        if (first === -1 || last === -1 || last <= first) return null;
        let jsonText = content.slice(first, last + 1);
        try { return JSON.parse(jsonText); } catch {
            try {
                const sanitized = jsonText.replace(/,\s*([}\]])/g, '$1').replace(/[\u2018\u2019\u201C\u201D]/g, '"');
                return JSON.parse(sanitized);
            } catch {
                return null;
            }
        }
    }

    try {
        const raw = await retryWithBackoff(() => callLLMRaw(), {
            retries: 2,
            baseDelayMs: 800,
            factor: 2,
            onRetry: (err, attempt) => console.warn('LLM ranking retry', attempt, err?.message || err),
        });

        const parsed = safeParseJSON(raw);
        if (!parsed || !Array.isArray(parsed.ranked) || parsed.ranked.length === 0) {
            console.warn('LLM returned unparsable JSON or no ranked items. Raw (truncated):', raw.slice(0, 800));
            console.log('Fallback — listing idea headlines:');
            for (const it of ideasPayload) console.log(' - ' + it.idea);
            return;
        }

        console.log('--- Product Ideas (LLM-ranked) ---');
        for (let i = 0; i < parsed.ranked.length; i++) {
            const r = parsed.ranked[i];
            console.log(`\n${i + 1}. ${r.idea}`);
            if (typeof r.priority !== 'undefined') console.log(`Priority: ${r.priority}`);
            if (typeof r.score !== 'undefined') console.log(`Score: ${Number(r.score).toFixed(2)}`);
            if (typeof r.estimated_revenue_usd !== 'undefined') console.log(`Estimated revenue (USD): $${Number(r.estimated_revenue_usd)}`);
            if (r.recommended_price_range) console.log(`Recommended price range: ${r.recommended_price_range}`);
            if (Array.isArray(r.go_to_market_channels) && r.go_to_market_channels.length) {
                console.log('Go-to-market channels: ' + r.go_to_market_channels.join(', '));
            }
            if (r.rationale) console.log('Rationale: ' + r.rationale);
            if (Array.isArray(r.examples) && r.examples.length) {
                console.log('Examples:');
                r.examples.slice(0, 3).forEach((ex: string, idx: number) => {
                    console.log(`  ${idx + 1}. ${ex.replace(/\s+/g, ' ').slice(0, 240)}${ex.length > 240 ? '...' : ''}`);
                });
            }
            console.log('---');
        }
    } catch (e) {
        console.warn('LLM ranking failed entirely:', e?.message || e);
        console.log('Fallback — listing idea headlines:');
        for (const it of ideasPayload) console.log(' - ' + it.idea);
    }
}
