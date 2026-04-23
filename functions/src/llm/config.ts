/**
 * Per-stage model selection. Keeping model identifiers out of call sites
 * means a stage can be re-tuned (or routed to a different provider) without
 * touching business logic.
 *
 * See specs/matchline.md § AI pipeline → Model strategy.
 */
export interface ModelConfig {
  readonly provider: "anthropic" | "openai";
  readonly model: string;
}

export type Stage =
  | "extraction"
  | "requirement_parsing"
  | "rationale"
  | "generation"
  | "validation";

const defaults: Record<Stage, ModelConfig> = {
  // Frontier class — extraction quality is the foundation of the product.
  extraction: { provider: "anthropic", model: "claude-sonnet-4-6" },
  requirement_parsing: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  rationale: { provider: "anthropic", model: "claude-sonnet-4-6" },
  // Cheaper class — generation is the highest-volume stage.
  generation: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  validation: { provider: "anthropic", model: "claude-sonnet-4-6" },
};

export function modelFor(stage: Stage): ModelConfig {
  return defaults[stage];
}

export const EMBEDDING_MODEL = "text-embedding-3-small";
