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

/**
 * Runtime list of stages, and `Stage` derived from it so the two can
 * never drift. Tooling that validates a user-supplied stage name
 * (the eval sweep's `--variant model.<stage>=...`) needs the values
 * at runtime, not just the type.
 */
export const STAGES = [
  "extraction",
  "requirement_parsing",
  "rationale",
  "generation",
  "validation",
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

const defaults: Record<Stage, ModelConfig> = {
  // Frontier class — extraction quality is the foundation of the product.
  extraction: { provider: "anthropic", model: "claude-sonnet-4-6" },
  requirement_parsing: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  rationale: { provider: "anthropic", model: "claude-sonnet-4-6" },
  // Cheaper class — generation is the highest-volume stage.
  generation: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  validation: { provider: "anthropic", model: "claude-sonnet-4-6" },
};

/**
 * Runtime per-stage model overrides. Empty by default.
 *
 * **Why this exists (#389, serving #177).** The eval harness needs to
 * A/B compare models per stage — "does Haiku clear the 80/80 bar on
 * extraction, or do we actually need Sonnet?" — without editing the
 * `defaults` table, which would change production behavior. The sweep
 * sets overrides before running a variant; production paths leave the
 * map empty and fall through to `defaults`.
 *
 * This deliberately mirrors `prompts/loader.ts § runtimeOverrides`,
 * which established the same inversion for prompt versions. The
 * rationale carries over verbatim: eval calls into the same
 * extraction / parsing / generation modules production uses, and those
 * modules call `modelFor(stage)` without an options bag. Threading an
 * override through every public API just for the harness would be
 * invasive; a single "before any pipeline call, set the overrides for
 * this run" inversion is much narrower.
 *
 * Always call `clearModelOverrides()` in test teardown if a test sets
 * overrides — this is module state and leaks between tests otherwise.
 */
const runtimeModelOverrides = new Map<Stage, ModelConfig>();

/**
 * Replace the entire override map. Full replacement, not a merge — a
 * caller that sets `{ extraction }` after `{ generation }` ends with
 * only the extraction override active, so a sweep variant can never
 * inherit a stale stage from the previous variant.
 */
export function setModelOverrides(
  overrides: Partial<Record<Stage, ModelConfig>>,
): void {
  runtimeModelOverrides.clear();
  for (const [stage, config] of Object.entries(overrides)) {
    if (config !== undefined) {
      runtimeModelOverrides.set(stage as Stage, config);
    }
  }
}

/** Clear all model overrides. Equivalent to `setModelOverrides({})`. */
export function clearModelOverrides(): void {
  runtimeModelOverrides.clear();
}

/**
 * Snapshot the active overrides. Returned frozen so a caller can drop
 * it into eval-report metadata without mutating loader state.
 */
export function getModelOverrides(): Readonly<Partial<Record<Stage, ModelConfig>>> {
  return Object.freeze(Object.fromEntries(runtimeModelOverrides)) as Readonly<
    Partial<Record<Stage, ModelConfig>>
  >;
}

export function modelFor(stage: Stage): ModelConfig {
  return runtimeModelOverrides.get(stage) ?? defaults[stage];
}

export const EMBEDDING_MODEL = "text-embedding-3-small";
