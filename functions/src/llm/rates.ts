/**
 * Per-model pricing, denominated in USD per 1K tokens.
 *
 * Edit this file when Anthropic / OpenAI change their published rates.
 * Every model referenced by `functions/src/llm/config.ts` or used for
 * embeddings must have an entry here; `rateFor` throws if a model is
 * missing so a silent-zero-cost regression is impossible. The eval
 * harness's model sweep refuses a variant whose model has no entry, so
 * a model must be registered here before it can be compared.
 *
 * Anthropic rates were re-verified on 2026-10-19 against
 * https://platform.claude.com/docs/en/about-claude/pricing (first-party
 * API, global routing). The OpenAI embedding rate was captured on
 * 2026-04-23. Re-verify periodically — vendor pricing is not stable.
 *
 * These are list-price estimates, not invoices: they ignore credits,
 * batch discounts, and the 1.1× US-only `inference_geo` multiplier, none
 * of which Matchline uses today.
 */

/** One rate card: the prices that apply to a single request. */
export interface RateCard {
  readonly inputUsdPer1k: number;
  readonly outputUsdPer1k: number;
  /**
   * 5-minute prompt-cache write. Absent on models that cannot cache
   * (embeddings). Matchline sets no `cache_control` today and never
   * uses the 1-hour TTL, so only the 5-minute write rate is modeled.
   */
  readonly cacheWriteUsdPer1k?: number;
  /** Prompt-cache hit / refresh. Absent on models that cannot cache. */
  readonly cacheReadUsdPer1k?: number;
}

export interface ModelRate extends RateCard {
  /**
   * A second rate card for long prompts. When a request's prompt —
   * every input token, cache reads and cache writes included — is
   * over `thresholdTokens`, the whole request is priced on `rate`
   * instead. Only Haiku 5.5 has one today.
   */
  readonly longPrompt?: {
    readonly thresholdTokens: number;
    readonly rate: RateCard;
  };
}

/** Per-MTok list prices → per-1K, the unit this table stores. */
function perMTok(card: {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}): RateCard {
  return Object.freeze({
    inputUsdPer1k: card.input / 1000,
    outputUsdPer1k: card.output / 1000,
    ...(card.cacheWrite !== undefined && { cacheWriteUsdPer1k: card.cacheWrite / 1000 }),
    ...(card.cacheRead !== undefined && { cacheReadUsdPer1k: card.cacheRead / 1000 }),
  });
}

// Deep-freeze: each ModelRate entry (and any nested long-prompt card)
// is frozen individually so `RATES[model].inputUsdPer1k = ...` can't
// silently corrupt pricing. Shallow freeze on the outer container
// alone would leave nested objects mutable.
export const RATES: Readonly<Record<string, Readonly<ModelRate>>> = Object.freeze({
  // Anthropic — Sonnet 4.6 (current extraction / validation pin).
  "claude-sonnet-4-6": perMTok({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }),

  // Anthropic — Haiku 4.5 (dated ID, matches config.ts).
  "claude-haiku-4-5-20251001": perMTok({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }),

  // Anthropic — Claude 5.5 family, registered for the #495 eval sweep.
  // Not pinned by config.ts; adopting one is its own approved change.
  // Opus/Sonnet 5.5 cache reads are 0.05× input, not the usual 0.1×.
  "claude-sonnet-5-5": perMTok({ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }),
  "claude-opus-5-5": perMTok({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }),
  "claude-haiku-5-5": Object.freeze({
    ...perMTok({ input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 }),
    longPrompt: Object.freeze({
      thresholdTokens: 100_000,
      rate: perMTok({ input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 }),
    }),
  }),

  // OpenAI — text-embedding-3-small. Single input-token rate; no output tokens.
  "text-embedding-3-small": perMTok({ input: 0.02, output: 0 }),
});

export function rateFor(model: string): ModelRate {
  // Object.hasOwn so inherited keys like "toString" or "constructor"
  // can't masquerade as valid model identifiers.
  const rate = Object.hasOwn(RATES, model) ? RATES[model] : undefined;
  if (!rate) {
    throw new Error(
      `No rate registered for model: ${model}. Add an entry to functions/src/llm/rates.ts.`,
    );
  }
  return rate;
}
