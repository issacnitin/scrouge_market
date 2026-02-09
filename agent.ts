import { chromium } from 'playwright';
import { analyzePost } from './nlp.ts';
import * as readline from 'readline';

async function browseAndAnalyze(urls: string[]) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        locale: 'en-US',
        viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    for (const url of urls) {
        console.log(`Browsing: ${url}`);
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForLoadState('networkidle').catch(() => {});

            const finalUrl = page.url();
            if (/login|signup|consent|native_app|app=/.test(finalUrl)) {
                console.warn(`Skipped URL due to redirect/blocked page: ${finalUrl}`);
                continue;
            }

            const selectors = [
                '.post',
                'div.Post',
                'div[data-testid="post-container"]',
                'div[data-test-id="post-content"]',
            ];

            // Iteratively scroll to load more posts, collect them, and analyze in chunks of 10
            const collectedSet = new Set<string>();
            let processedCount = 0;
            const INITIAL_BATCH = 10;          // only load/analyze 10 posts initially
            let initialBatchDone = false;
            const CHUNK_SIZE = 5;
            const MAX_SCROLLS = 2;
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
                                const ideas = generateProductIdeas(insight, post);
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
                    finalizeIdeasAndDisplay(ideaStore);
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
                    finalizeIdeasAndDisplay(ideaStore);

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
                finalizeIdeasAndDisplay(ideaStore);
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
function generateProductIdeas(insight: any, postText?: string): string[] {
    const ideas = new Set<string>();
    const summary = (insight?.summary || '').toString();
    const sentiment = (insight?.sentiment || '').toString().toLowerCase();
    const topics: string[] = Array.isArray(insight?.topics) ? insight.topics.map(String) : [];

    const norm = (t: string) => t.replace(/[^a-zA-Z0-9\s\-]/g, '').trim();

    for (const raw of topics.slice(0, 6)) {
        const t = norm(raw);
        if (!t) continue;
        ideas.add(`Starter kit for ${t} enthusiasts (bundle of essentials)`);
        ideas.add(`Premium accessory/product for ${t} — upsell for power users`);
        ideas.add(`Curated subscription delivering ${t}-related items or deals`);
    }

    if (summary) {
        if (summary.length < 200) {
            ideas.add(`Concise guide or checklist based on: "${summary.slice(0, 120)}"`);
        } else {
            ideas.add('In-depth ebook or short online course addressing the key concern in the summary');
        }
    }

    if (sentiment.includes('neg') || /problem|issue|struggl|complain/i.test(summary)) {
        ideas.add('Problem-solver product: a tool or kit that directly addresses the described pain point');
        ideas.add('Concierge/premium service to remove friction for these customers');
    } else if (sentiment.includes('pos') || /love|enjoy|happy|great/i.test(summary)) {
        ideas.add('Upsell or premium tier targeting satisfied customers (enhanced features/accessories)');
    } else {
        ideas.add('Introductory product/trial offer to convert curious/neutral customers');
    }

    if (postText && /\bbuy|purchase|where can i get|recommend\b/i.test(postText)) {
        ideas.add('Direct product recommendation list with quick-purchase links');
    }

    return Array.from(ideas).slice(0, 8);
}

// Compute a simple score and render detailed documents for each idea (sorted by estimated revenue)
function finalizeIdeasAndDisplay(ideaStore: Map<string, any>) {
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

    const systemPrompt = `You are an expert product/market analyst. Given a list of candidate product ideas with simple signals (count, sentimentSum, topics, examples, reasons), rank them by priority and produce a concise JSON output only (no extra commentary). The output must be EXACT valid JSON in this format:

{
  "ranked": [
    {
      "idea": "string",
      "priority": 1,
      "score": 4.2,
      "rationale": "short text (why this ranks highly)",
      "estimated_revenue_usd": 12345,
      "recommended_price_range": "string (e.g. $29-$99 or $5/mo)",
      "go_to_market_channels": ["channel1","channel2"],
      "examples": ["example post 1", "..."]
    }
  ]
}

Be concise in rationale and ensure the JSON is parseable. Use numeric fields where indicated.`;

    const userPrompt = `Here is the input array (JSON). Produce the output described above and sort items by priority (1 highest). Input:
${JSON.stringify({ ideas: ideasPayload }, null, 2)}`;

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

    // tolerant parser: extract JSON block, remove trailing commas and retry
    function safeParseJSON(content: string): any {
        if (!content || typeof content !== 'string') return null;
        // Find the first balanced JSON object block heuristically
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
            return null;
        }
        let jsonText = content.slice(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(jsonText);
        } catch (e) {
            // Try to remove trailing commas in objects/arrays: ,}
            try {
                const sanitized = jsonText.replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(sanitized);
            } catch (e2) {
                // last-resort: attempt to fix common issues like smart quotes (very conservative)
                try {
                    const fixedQuotes = jsonText.replace(/[\u2018\u2019\u201C\u201D]/g, '"');
                    const sanitized2 = fixedQuotes.replace(/,\s*([}\]])/g, '$1');
                    return JSON.parse(sanitized2);
                } catch (_e3) {
                    // give up
                    return null;
                }
            }
        }
    }

    // call with retry/backoff and then parse tolerant
    retryWithBackoff(() => callLLMRaw(), {
        retries: 3,
        baseDelayMs: 800,
        factor: 2,
        onRetry: (err, attempt) => console.warn('LLM ranking retry', attempt, err?.message || err),
    }).then((rawContent: string) => {
        const parsed = safeParseJSON(rawContent);
        if (!parsed || !Array.isArray(parsed.ranked) || parsed.ranked.length === 0) {
            console.warn('LLM returned unparsable JSON or no ranked items. Raw output below (truncated):');
            console.warn(rawContent.slice(0, 800)); // show start for debugging
            // Fallback: list idea headlines
            console.log('Fallback — listing idea headlines:');
            for (const it of ideasPayload) {
                console.log(' - ' + it.idea);
            }
            return;
        }

        // Display parsed ranking
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
    }).catch((e) => {
        console.warn('LLM ranking failed entirely:', e?.message || e);
        // Final fallback: list idea headlines
        console.log('Fallback — listing idea headlines:');
        for (const it of ideasPayload) {
            console.log(' - ' + it.idea);
        }
    });
}
