import { createHash, randomBytes } from 'node:crypto';

// Bidi overrides and zero-width characters: invisible to a reviewer, meaningful to a tokenizer.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// C0/C1 controls except tab and newline. Matching control characters is the entire point here.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Special tokens and role markers a hostile page could use to forge conversation structure.
const CHAT_MARKUP =
  /<\|[a-z_]*\|>|<\/?(?:system|assistant|user|tool|function)>|\[\/?INST\]|\bBEGIN\s+SYSTEM\s+PROMPT\b/gi;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, ' ');
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t\u00A0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/**
 * Prepares scraped, attacker-controlled text for inclusion in a prompt.
 *
 * Scraped page content is untrusted input: a page can contain text engineered to override
 * the system prompt. This removes the mechanisms that make such text effective (invisible
 * reordering characters, control bytes, forged role/special tokens) and bounds the length
 * so a single hostile page cannot consume the whole context window.
 */
export function sanitizeUntrusted(text: string, maxChars: number): string {
  const cleaned = normalizeWhitespace(stripInvisible(text).replace(CHAT_MARKUP, '[removed]'));
  return truncate(cleaned, maxChars);
}

export interface FencedContent {
  /** Prompt-ready block: an unguessable delimiter the untrusted text cannot forge. */
  readonly block: string;
  readonly delimiter: string;
}

/**
 * Wraps untrusted content in a per-call random delimiter. Because the nonce is unpredictable,
 * embedded text cannot emit a matching closing fence to "escape" the data region.
 */
export function fenceUntrusted(text: string, label = 'UNTRUSTED_CONTENT'): FencedContent {
  const delimiter = `${label}_${randomBytes(9).toString('hex')}`;
  const safe = text.split(delimiter).join('[removed]');
  return {
    delimiter,
    block: `<<<${delimiter}>>>\n${safe}\n<<<END_${delimiter}>>>`,
  };
}

/** Splits text into overlapping chunks. Guarantees forward progress for any positive `maxLen`. */
export function splitIntoChunks(text: string, maxLen: number, overlap = 0): string[] {
  if (maxLen <= 0) throw new RangeError('maxLen must be positive');
  if (text.length <= maxLen) return text.length > 0 ? [text] : [];

  const safeOverlap = Math.min(Math.max(0, overlap), maxLen - 1);
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + maxLen, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - safeOverlap;
  }

  return chunks;
}

/** Stable key for deduplicating posts that differ only in whitespace or casing. */
export function dedupeKey(text: string): string {
  return normalizeWhitespace(stripInvisible(text)).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
}

export function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

/** Removes near-duplicate entries while preserving first-seen order. */
export function dedupePosts(posts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const post of posts) {
    const trimmed = post.trim();
    if (!trimmed) continue;
    const key = dedupeKey(trimmed);
    if (key.length < 8 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
