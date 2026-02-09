# Scrouge — Market Idea Agent

Scrouge is an AI-powered CLI agent that browses URLs (forums, subreddits, social feeds), extracts user posts, analyzes sentiment and topics, and generates **non-obvious, high-value product/service ideas** ranked by estimated revenue potential.

## Demo

![](./recording.gif)

> GitHub may not render `.mov` in all browsers. If playback fails, download the file or convert to MP4.

## How It Works

1. **Browse** — Playwright opens the target URL(s) with realistic headers and scrolls to collect posts.
2. **Extract** — DOM heuristics + LLM-based candidate extraction identify actual user posts from raw page content.
3. **Analyze** — Each post is sent to an LLM (`analyzePost` via `nlp.ts`) for sentiment, topics, and summary.
4. **Ideate** — A senior-product-strategist LLM prompt generates up to 3 non-obvious, high-value product ideas per post.
5. **Rank** — All ideas from a batch are ranked by an LLM analyst with estimated revenue, pricing, go-to-market channels, and rationale.
6. **Prompt** — After each batch the user is asked whether to continue (`y`) or quit (`n` exits immediately).

## Prerequisites

- **Node.js** ≥ 18 (for native `fetch`)
- **Playwright** — install browsers: `npx playwright install chromium`
- **OpenAI API key** — required for LLM features

## Setup

```bash
git clone <repo-url> && cd scrouge
npm install            # or: bun install
npx playwright install chromium
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for all LLM calls |
| `SHOW_BROWSER` | No | `1` (visible) | Set to `0` for headless mode |

## Usage

```bash
# Run with visible browser (default)
OPENAI_API_KEY=sk-... npx ts-node agent.ts

# Run headless
SHOW_BROWSER=0 OPENAI_API_KEY=sk-... npx ts-node agent.ts
```

When prompted, enter one or more URLs separated by commas:

```
Enter URLs separated by commas: https://reddit.com/r/somesub, https://example.com/forum
```

After each batch of posts is analyzed and ideas are displayed, you'll see:

```
Continue to next batch? (y/n):
```

- **y** — analyze the next batch
- **n** — quit immediately

## Project Structure

```
scrouge/
├── agent.ts          # Main CLI agent (browsing, extraction, idea generation, ranking)
├── nlp.ts            # analyzePost() — per-post LLM analysis (sentiment, topics, summary)
├── recording.mov     # Demo recording
├── .gitignore
└── README.md
```

## Key Design Decisions

- **Multi-layer post extraction** — DOM selectors → LLM candidate filtering → full-text chunked LLM fallback → raw DOM scan.
- **Non-obvious ideas only** — the idea-generation prompt explicitly rejects generic guides/checklists and filters them client-side.
- **Batch + prompt loop** — processes an initial batch of 10, then chunks of 3, prompting the user each time so you can stop early.
- **Retry with exponential backoff** — all LLM calls use jittered backoff for rate-limit resilience.
- **Realistic browser fingerprint** — custom UA, Sec-CH-UA, Sec-Fetch-*, DNT, referer, and other headers to reduce blocking.

## Notes

- Some sites (Reddit, Twitter/X) aggressively block automated browsers. If you see "blocked by network security", try a different URL or add a proxy.
- Large `.mov` files should be tracked with [Git LFS](https://git-lfs.github.com/).
- Do **not** commit API keys or secrets.
