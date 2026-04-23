/**
 * Per-model pricing, denominated in USD per 1K tokens.
 *
 * Edit this file when Anthropic / OpenAI change their published rates.
 * Every model referenced by `functions/src/llm/config.ts` or used for
 * embeddings must have an entry here; `rateFor` throws if a model is
 * missing so a silent-zero-cost regression is impossible.
 *
 * Rates below were captured on 2026-04-23 from each provider's pricing
 * page. Re-verify periodically — vendor pricing is not stable.
 */

export interface ModelRate {
  readonly inputUsdPer1k: number;
  readonly outputUsdPer1k: number;
}

export const RATES: Record<string, ModelRate> = {
  // Anthropic — standard Sonnet tier.
  "claude-sonnet-4-6": {
    inputUsdPer1k: 0.003,
    outputUsdPer1k: 0.015,
  },

  // Anthropic — Haiku 4.5 (dated ID, matches config.ts).
  "claude-haiku-4-5-20251001": {
    inputUsdPer1k: 0.001,
    outputUsdPer1k: 0.005,
  },

  // OpenAI — text-embedding-3-small. Single input-token rate; no output tokens.
  "text-embedding-3-small": {
    inputUsdPer1k: 0.00002,
    outputUsdPer1k: 0,
  },
};

export function rateFor(model: string): ModelRate {
  const rate = RATES[model];
  if (!rate) {
    throw new Error(
      `No rate registered for model: ${model}. Add an entry to functions/src/llm/rates.ts.`,
    );
  }
  return rate;
}
