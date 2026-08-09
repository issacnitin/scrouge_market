import type { AppConfig } from '../config.js';
import type { LlmClient } from '../llm/client.js';
import { rankingPrompt, type RankingCandidate } from '../llm/prompts.js';
import { ranking, type RankedIdea } from '../llm/schemas.js';
import type { AnalyzedPost } from './analyze.js';

const MAX_CANDIDATES_TO_RANK = 30;
const MAX_EXAMPLES_PER_IDEA = 3;

export interface IdeaAggregate {
  readonly idea: string;
  count: number;
  sentimentSum: number;
  readonly topics: Set<string>;
  readonly reasons: Set<string>;
  readonly examples: string[];
}

const SENTIMENT_SCORE = { positive: 1, neutral: 0, negative: -1 } as const;

/** Groups identical ideas across posts so repetition becomes a demand signal. */
export function aggregateIdeas(analyzed: readonly AnalyzedPost[]): Map<string, IdeaAggregate> {
  const store = new Map<string, IdeaAggregate>();

  for (const { analysis, ideas, post } of analyzed) {
    for (const idea of ideas) {
      const key = idea.title.trim().toLowerCase();
      if (!key) continue;

      let entry = store.get(key);
      if (!entry) {
        entry = {
          idea: `${idea.title} — ${idea.pitch} | ${idea.differentiator} | ${idea.pricing}`,
          count: 0,
          sentimentSum: 0,
          topics: new Set<string>(),
          reasons: new Set<string>(),
          examples: [],
        };
        store.set(key, entry);
      }

      entry.count++;
      entry.sentimentSum += SENTIMENT_SCORE[analysis.sentiment];
      for (const topic of analysis.topics.slice(0, 5)) entry.topics.add(topic);
      if (analysis.summary) entry.reasons.add(analysis.summary.slice(0, 200));
      if (entry.examples.length < MAX_EXAMPLES_PER_IDEA) entry.examples.push(post.slice(0, 300));
    }
  }

  return store;
}

export interface RankResult {
  readonly ranked: readonly RankedIdea[];
  readonly aggregates: ReadonlyMap<string, IdeaAggregate>;
}

export interface RankDeps {
  client: LlmClient;
  config: AppConfig;
  signal?: AbortSignal;
}

export async function rankIdeas(
  aggregates: ReadonlyMap<string, IdeaAggregate>,
  deps: RankDeps,
): Promise<RankResult> {
  if (aggregates.size === 0) return { ranked: [], aggregates };

  // Rank the strongest signals first so the token budget is spent where it matters.
  const candidates: RankingCandidate[] = [...aggregates.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CANDIDATES_TO_RANK)
    .map((entry) => ({
      idea: entry.idea,
      count: entry.count,
      sentimentSum: entry.sentimentSum,
      topics: [...entry.topics].slice(0, 5),
      reasons: [...entry.reasons].slice(0, 2),
    }));

  const prompt = rankingPrompt(candidates);
  const result = await deps.client.complete({
    stage: 'ranking',
    model: deps.config.llm.models.ranking,
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens: 6_000,
    temperature: 0,
    schema: ranking,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  const sorted = [...result.ranked].sort((a, b) => a.priority - b.priority);
  return { ranked: sorted, aggregates };
}
