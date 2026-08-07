# Scrouge — Market Idea Agent

Scrouge is an AI-powered CLI agent that browses URLs (forums, subreddits, social feeds), extracts user posts, analyzes sentiment and topics, and generates **non-obvious, high-value product/service ideas** ranked by estimated revenue potential.

## Demo

![](./recording.gif)

## How It Works

1. **Validate** — every URL is checked against an SSRF guard before a browser is launched.
2. **Browse** — Playwright opens the target with realistic headers and scrolls to load more posts.
3. **Extract** — DOM candidates → LLM filtering → chunked full-text fallback → DOM-only fallback.
4. **Analyze** — each post gets a sentiment, topic and summary pass, run with bounded concurrency.
5. **Ideate** — a product-strategist prompt proposes up to 3 differentiated ideas per post.
6. **Rank** — ideas are aggregated across posts, then ranked with revenue, pricing and channels.
7. **Prompt** — after each batch you choose whether to continue.

## Prerequisites

- **Node.js ≥ 20.11**
- **Playwright Chromium** — `npm run browsers`
- **An OpenAI API key**

## Setup

```bash
git clone https://github.com/issacnitin/scrouge_market.git && cd scrouge_market
npm install
npm run browsers
cp .env.example .env      # then fill in OPENAI_API_KEY
```

## Usage

```bash
# Interactive (prompts for URLs, asks before each batch)
npm run dev

# Non-interactive / scriptable
npm run dev -- --url https://example.com/forum --yes --headless

# The ranked report goes to stdout, logs go to stderr — so this works:
npm run dev -- -u https://example.com/forum -y > report.txt
```

| Flag | Description |
|---|---|
| `-u, --url <url>` | Target URL. Repeatable, and accepts comma-separated values. |
| `-y, --yes` | Never prompt between batches. Required for non-interactive use. |
| `--headless` / `--headful` | Force browser visibility, overriding `SHOW_BROWSER`. |
| `-h, --help` | Show usage. |

Exit codes: `0` success, `1` failure, `64` usage error, `78` configuration error, `130` interrupted.

## Configuration

All settings are environment variables, validated at startup — see [.env.example](./.env.example) for the full list. The most relevant ones:

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at a compatible gateway. |
| `MODEL_ANALYSIS` / `MODEL_IDEAS` / `MODEL_RANKING` | `gpt-4o-mini`, `gpt-4o-mini`, `gpt-4o` | Per-stage models. |
| `LLM_CONCURRENCY` | `4` | Max in-flight LLM requests. |
| `LLM_TIMEOUT_MS` | `60000` | Hard per-request timeout. |
| `MAX_POSTS_PER_URL` | `200` | Cost and memory ceiling. |
| `ALLOW_PRIVATE_HOSTS` | `0` | **Only** enable for local development. |
| `PERSIST_INSIGHTS` | `0` | Write analyzed insights to `INSIGHTS_PATH`. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | `LOG_FORMAT=json` for machine-readable logs. |

## Security model

This tool feeds **attacker-controlled web content** into an LLM, so it is built defensively:

- **SSRF protection** — URLs are restricted to `http`/`https` on ports 80/443, with no embedded
  credentials. Every DNS-resolved address is checked against loopback, RFC1918, CGNAT,
  link-local (including `169.254.169.254` cloud metadata), multicast and reserved ranges, in both
  IPv4 and IPv6, covering IPv4-mapped, NAT64 and 6to4 encodings. Redirect targets are re-validated.
- **Prompt-injection hardening** — scraped text is stripped of control characters, bidi overrides
  and forged role/special tokens, then wrapped in a per-call random delimiter that embedded text
  cannot forge. Every prompt states that fenced content is untrusted data, never instructions.
- **Secret redaction** — API keys and bearer tokens are scrubbed from every log line and every
  error message, because provider error bodies routinely echo the submitted `Authorization` header.
- **Schema-validated output** — responses are constrained with a strict JSON schema *and*
  re-validated with Zod, so malformed or hostile model output cannot flow downstream.
- **Resource bounds** — DOM traversal, post counts, post length, retry delays and the insight log
  are all capped.

Report vulnerabilities via a private GitHub security advisory rather than a public issue.

## Project structure

```
src/
├── index.ts              # Entry point: config, signals, graceful shutdown
├── cli.ts                # Argument parsing and prompts
├── config.ts             # Environment parsing and validation
├── logger.ts             # Levelled structured logging with secret redaction
├── errors.ts             # Error taxonomy
├── llm/
│   ├── client.ts         # Single LLM entry point: retry, concurrency, caching, validation
│   ├── http.ts           # Timeout-enforcing JSON transport
│   ├── prompts.ts        # Injection-hardened prompt construction
│   └── schemas.ts        # Zod + JSON schemas per stage
├── net/url-guard.ts      # SSRF validation
├── scrape/
│   ├── browser.ts        # Playwright lifecycle and navigation
│   └── extract.ts        # Multi-strategy post extraction
├── pipeline/
│   ├── analyze.ts        # Concurrent per-post analysis and ideation
│   ├── rank.ts           # Cross-post aggregation and ranking
│   ├── report.ts         # Pure rendering
│   ├── run.ts            # Orchestration
│   └── storage.ts        # Atomic, schema-validated insight log
└── util/                 # retry, concurrency, text sanitization
```

## Development

```bash
npm run verify        # typecheck + lint + test
npm run test:watch
npm run test:coverage
npm run build         # emit dist/
```

TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
ESLint uses type-aware rules. CI runs all of the above on Node 20 and 22, plus `npm audit`.

## Notes

- Some sites (Reddit, Twitter/X) aggressively block automated browsers. Scrouge detects
  login/consent walls and reports them instead of scraping an empty page.
- Scraping may violate a site's terms of service. Check before you point this at a target.
- Large media files should be tracked with [Git LFS](https://git-lfs.github.com/).
- Never commit `.env` or API keys.
