import { z } from 'zod';

/**
 * Each stage declares a zod schema (validated at runtime) *and* a JSON Schema (sent to the
 * provider as a structured-output constraint). The provider constraint makes malformed output
 * rare; the zod check makes it harmless when it happens anyway.
 */
export interface SchemaPair<T> {
  readonly name: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly validator: z.ZodType<T>;
}

const boundedString = (max: number) => z.string().max(max);

// --- Post extraction -------------------------------------------------------

export const PostsExtractionSchema = z.object({
  posts: z.array(boundedString(20_000)).max(200),
});
export type PostsExtraction = z.infer<typeof PostsExtractionSchema>;

export const postsExtraction: SchemaPair<PostsExtraction> = {
  name: 'post_extraction',
  validator: PostsExtractionSchema,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['posts'],
    properties: {
      posts: {
        type: 'array',
        description: 'Verbatim user-visible posts or messages, stripped of UI chrome.',
        items: { type: 'string' },
      },
    },
  },
};

// --- Per-post analysis -----------------------------------------------------

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const PostAnalysisSchema = z.object({
  summary: boundedString(2_000),
  sentiment: z.enum(SENTIMENTS),
  topics: z.array(boundedString(80)).max(10),
  toxicityScore: z.number().min(0).max(1),
});
export type PostAnalysis = z.infer<typeof PostAnalysisSchema>;

export const postAnalysis: SchemaPair<PostAnalysis> = {
  name: 'post_analysis',
  validator: PostAnalysisSchema,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'sentiment', 'topics', 'toxicityScore'],
    properties: {
      summary: { type: 'string', description: 'One or two sentences.' },
      sentiment: { type: 'string', enum: [...SENTIMENTS] },
      topics: { type: 'array', items: { type: 'string' } },
      toxicityScore: { type: 'number', description: 'Between 0 and 1 inclusive.' },
    },
  },
};

// --- Idea generation -------------------------------------------------------

export const ProductIdeaSchema = z.object({
  title: boundedString(160),
  pitch: boundedString(400),
  differentiator: boundedString(400),
  pricing: boundedString(160),
});
export type ProductIdea = z.infer<typeof ProductIdeaSchema>;

export const IdeaListSchema = z.object({ ideas: z.array(ProductIdeaSchema).max(3) });
export type IdeaList = z.infer<typeof IdeaListSchema>;

export const ideaList: SchemaPair<IdeaList> = {
  name: 'product_ideas',
  validator: IdeaListSchema,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ideas'],
    properties: {
      ideas: {
        type: 'array',
        description: 'At most 3 non-obvious, monetizable ideas.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'pitch', 'differentiator', 'pricing'],
          properties: {
            title: { type: 'string' },
            pitch: { type: 'string', description: 'One line: what it does, for whom.' },
            differentiator: { type: 'string', description: 'Why it is non-obvious and defensible.' },
            pricing: { type: 'string', description: 'Suggested price or packaging.' },
          },
        },
      },
    },
  },
};

// --- Ranking ---------------------------------------------------------------

export const RankedIdeaSchema = z.object({
  idea: boundedString(400),
  priority: z.number().int().min(1).max(100),
  score: z.number().min(0).max(10),
  rationale: boundedString(1_200),
  estimatedRevenueUsd: z.number().min(0).max(1e12),
  recommendedPriceRange: boundedString(120),
  goToMarketChannels: z.array(boundedString(120)).max(8),
});
export type RankedIdea = z.infer<typeof RankedIdeaSchema>;

export const RankingSchema = z.object({ ranked: z.array(RankedIdeaSchema).max(30) });
export type Ranking = z.infer<typeof RankingSchema>;

export const ranking: SchemaPair<Ranking> = {
  name: 'idea_ranking',
  validator: RankingSchema,
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['ranked'],
    properties: {
      ranked: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'idea',
            'priority',
            'score',
            'rationale',
            'estimatedRevenueUsd',
            'recommendedPriceRange',
            'goToMarketChannels',
          ],
          properties: {
            idea: { type: 'string' },
            priority: { type: 'integer', description: '1 is highest priority.' },
            score: { type: 'number', description: 'Between 0 and 10.' },
            rationale: { type: 'string' },
            estimatedRevenueUsd: { type: 'number', description: 'Annual, in USD.' },
            recommendedPriceRange: { type: 'string' },
            goToMarketChannels: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};
