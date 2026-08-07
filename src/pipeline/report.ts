import type { RankedIdea } from '../llm/schemas.js';
import type { IdeaAggregate } from './rank.js';

const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

export interface RenderOptions {
  color: boolean;
  maxExamples?: number;
}

function currency(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

/** Renders the ranked ideas as text. Pure, so output formatting is directly testable. */
export function renderReport(
  ranked: readonly RankedIdea[],
  aggregates: ReadonlyMap<string, IdeaAggregate>,
  options: RenderOptions,
): string {
  const bold = options.color ? BOLD : '';
  const cyan = options.color ? CYAN : '';
  const dim = options.color ? DIM : '';
  const reset = options.color ? RESET : '';
  const maxExamples = options.maxExamples ?? 2;

  if (ranked.length === 0) {
    return 'No product ideas were generated for this batch.';
  }

  const byTitle = new Map<string, IdeaAggregate>();
  for (const entry of aggregates.values()) byTitle.set(entry.idea, entry);

  const lines: string[] = ['', `${cyan}${bold}Product ideas (ranked)${reset}`, ''];

  for (const [index, item] of ranked.entries()) {
    lines.push(`${bold}${index + 1}. ${item.idea}${reset}`);
    lines.push(
      `   score ${item.score.toFixed(1)}/10  ·  est. annual revenue ${currency(
        item.estimatedRevenueUsd,
      )}  ·  ${item.recommendedPriceRange}`,
    );
    if (item.goToMarketChannels.length > 0) {
      lines.push(`   channels: ${item.goToMarketChannels.join(', ')}`);
    }
    lines.push(`   ${item.rationale}`);

    const aggregate = byTitle.get(item.idea);
    if (aggregate) {
      lines.push(
        `   ${dim}seen in ${aggregate.count} post(s); sentiment ${
          aggregate.sentimentSum > 0 ? '+' : ''
        }${aggregate.sentimentSum}${reset}`,
      );
      for (const example of aggregate.examples.slice(0, maxExamples)) {
        lines.push(`   ${dim}› ${example.replace(/\s+/g, ' ').slice(0, 160)}${reset}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderBanner(color: boolean): string {
  const cyan = color ? CYAN : '';
  const bold = color ? BOLD : '';
  const reset = color ? RESET : '';
  return [
    '',
    `${cyan}${bold}  ____                                 ${reset}`,
    `${cyan}${bold} / ___|  ___ _ __ ___  _   _  __ _  ___ ${reset}`,
    `${cyan}${bold} \\___ \\ / __| '__/ _ \\| | | |/ _\` |/ _ \\${reset}`,
    `${cyan}${bold}  ___) | (__| | | (_) | |_| | (_| |  __/${reset}`,
    `${cyan}${bold} |____/ \\___|_|  \\___/ \\__,_|\\__, |\\___|${reset}`,
    `${cyan}${bold}                             |___/      ${reset}`,
    `${cyan}Market Idea Agent${reset}`,
    '',
  ].join('\n');
}
