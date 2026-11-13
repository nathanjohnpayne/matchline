/**
 * Per-stage model selection. Keeping model identifiers out of call sites
 * means a stage can be re-tuned (or routed to a different provider) without
 * touching business logic.
 *
 * See specs/matchline.md § AI pipeline → Model strategy.
 */
import type { Effort } from "./modelProfile.js";

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
  "claim_extraction",
  "traceability",
  "specificity",
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * The three validation subtasks, each separately configurable (#489).
 * These strings are the only spelling used across config keys, sweep
 * `model.<stage>` / `effort.<stage>` keys, `UsageRecord.subtask`, eval
 * CallRecords and reports. Usage records keep `stage: "validation"`
 * with `subtask` set to one of these, so `scripts/latency/*` grouping
 * is unchanged.
 */
export const VALIDATION_STAGES = ["claim_extraction", "traceability", "specificity"] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

const defaults: Record<Stage, ModelConfig> = {
  // Frontier class — extraction quality is the foundation of the product.
  // Selected by the #495 comparison (round 2a, rule 4) and confirmed on
  // current main (rule 9, 2026-10-29): +5.3 points extraction accuracy over
  // claude-sonnet-4-6 with every guard holding, no failed flows, and about
  // half the p50 extraction latency. Effort follows the model profile
  // default (high) unless `effort.extraction` is overridden. Proposal PR per
  // #632; the owner approves before this merges.
  extraction: { provider: "anthropic", model: "claude-sonnet-5-5" },
  requirement_parsing: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  // Reserved; never read. Match rationales are produced by the
  // deterministic `generateRationale()` template (`matching/rationale.ts`,
  // #100) and embeddings are unchanged, so editing this entry changes
  // nothing. The eval sweep refuses `model.rationale` and
  // `effort.rationale` as not exercised.
  rationale: { provider: "anthropic", model: "claude-sonnet-4-6" },
  // Cheaper class — generation is the highest-volume stage.
  generation: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  // Validation subtasks (#489): audited default; a change needs a
  // measured, approved PR (#489).
  claim_extraction: { provider: "anthropic", model: "claude-sonnet-4-6" },
  // Audited default; a change needs a measured, approved PR (#489).
  traceability: { provider: "anthropic", model: "claude-sonnet-4-6" },
  // Audited default; a change needs a measured, approved PR (#489).
  specificity: { provider: "anthropic", model: "claude-sonnet-4-6" },
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

/**
 * Runtime per-stage effort overrides (#495). Same inversion as the
 * model overrides above, for the same reason: the sweep sets them
 * before a variant runs and production leaves the map empty, in which
 * case each model's profile default applies (see `llm/modelProfile.ts`).
 * Call `clearEffortOverrides()` in test teardown.
 */
const runtimeEffortOverrides = new Map<Stage, Effort>();

/** Replace the entire effort override map (full replacement, not a merge). */
export function setEffortOverrides(overrides: Partial<Record<Stage, Effort>>): void {
  runtimeEffortOverrides.clear();
  for (const [stage, effort] of Object.entries(overrides)) {
    if (effort !== undefined) runtimeEffortOverrides.set(stage as Stage, effort);
  }
}

export function clearEffortOverrides(): void {
  runtimeEffortOverrides.clear();
}

export function getEffortOverrides(): Readonly<Partial<Record<Stage, Effort>>> {
  return Object.freeze(Object.fromEntries(runtimeEffortOverrides)) as Readonly<
    Partial<Record<Stage, Effort>>
  >;
}

/** The effort override for a stage, or `undefined` to use the model's default. */
export function effortFor(stage: Stage): Effort | undefined {
  return runtimeEffortOverrides.get(stage);
}

export const EMBEDDING_MODEL = "text-embedding-3-small";
