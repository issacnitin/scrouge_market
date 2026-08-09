import type { AppConfig } from '../config.js';
import { describeError } from '../errors.js';
import type { LlmClient } from '../llm/client.js';
import { analysisPrompt, ideaPrompt } from '../llm/prompts.js';
import { ideaList, postAnalysis, type PostAnalysis, type ProductIdea } from '../llm/schemas.js';
import type { Logger } from '../logger.js';
import { mapWithConcurrency } from '../util/concurrency.js';

export interface AnalyzedPost {
  readonly post: string;
  readonly analysis: PostAnalysis;
  readonly ideas: readonly ProductIdea[];
}

export interface AnalyzeDeps {
  client: LlmClient;
  config: AppConfig;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

async function analyzeOne(post: string, deps: AnalyzeDeps): Promise<AnalyzedPost> {
  const { client, config, signal } = deps;

  const analysisRequest = analysisPrompt(post);
  const analysis = await client.complete({
    stage: 'analysis',
    model: config.llm.models.analysis,
    system: analysisRequest.system,
    user: analysisRequest.user,
    maxOutputTokens: 800,
    temperature: 0,
    schema: postAnalysis,
    ...(signal ? { signal } : {}),
  });

  const ideasRequest = ideaPrompt({
    summary: analysis.summary,
    sentiment: analysis.sentiment,
    topics: analysis.topics,
    post,
  });

  // A post can be analyzable but yield no worthwhile ideas; that must not fail the post.
  let ideas: readonly ProductIdea[] = [];
  try {
    const result = await client.complete({
      stage: 'ideas',
      model: config.llm.models.ideas,
      system: ideasRequest.system,
      user: ideasRequest.user,
      maxOutputTokens: 1_200,
      temperature: 0.2,
      schema: ideaList,
      ...(signal ? { signal } : {}),
    });
    ideas = result.ideas;
  } catch (error) {
    deps.logger.warn('idea generation failed for post', { error: describeError(error) });
  }

  return { post, analysis, ideas };
}

/** Analyzes a batch concurrently; a failing post is logged and skipped, never fatal. */
export async function analyzePosts(
  posts: readonly string[],
  deps: AnalyzeDeps,
): Promise<AnalyzedPost[]> {
  let completed = 0;

  const results = await mapWithConcurrency(
    posts,
    deps.config.llm.concurrency,
    async (post) => {
      try {
        return await analyzeOne(post, deps);
      } finally {
        deps.onProgress?.(++completed, posts.length);
      }
    },
    deps.signal,
  );

  const analyzed: AnalyzedPost[] = [];
  for (const result of results) {
    if (result.value) analyzed.push(result.value);
    else if (result.error) {
      deps.logger.warn('post analysis failed', { error: describeError(result.error) });
    }
  }

  return analyzed;
}
