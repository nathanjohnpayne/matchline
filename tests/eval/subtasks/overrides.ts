/**
 * Install a variant's overrides for the subtask suites, and prove they
 * were removed afterwards (#488, #489).
 *
 * The corpus sweep's `runVariant` keeps its own install/clear code; this
 * is the subtask suites' equivalent, stricter in two ways: it refuses to
 * start if an earlier variant leaked an override, and after clearing it
 * asserts every stage resolves to the same default it did before.
 */

import {
  clearEffortOverrides,
  clearModelOverrides,
  effortFor,
  getEffortOverrides,
  getModelOverrides,
  modelFor,
  setEffortOverrides,
  setModelOverrides,
  STAGES,
  VALIDATION_STAGES,
  type ModelConfig,
  type Stage,
} from "../../../functions/src/llm/config.ts";
import { profileFor, toolCallRequest, type Effort } from "../../../functions/src/llm/modelProfile.ts";
import {
  clearPromptVersionOverrides,
  getPromptVersionOverrides,
  setPromptVersionOverrides,
} from "../../../functions/src/prompts/loader.ts";
import type { PromptName, PromptStage } from "../../../functions/src/prompts/config.ts";

import { promptFingerprint } from "../runForFixture.ts";
import type { SweepVariant } from "../sweep.ts";
import type { SweepScope } from "../sweepScope.ts";

/**
 * Tool name and base output cap each subtask module sends. These
 * duplicate production constants; `overrides.test.ts` asserts each
 * equals what the module actually sends to a mock client, so they
 * cannot drift.
 */
export const STAGE_REQUEST_TABLE: Readonly<
  Partial<Record<Stage, { readonly toolName: string; readonly baseMaxTokens: number; readonly promptKey: string }>>
> = Object.freeze({
  claim_extraction: { toolName: "record_claims", baseMaxTokens: 2048, promptKey: "validation/claimExtraction" },
  traceability: { toolName: "record_traceability", baseMaxTokens: 1024, promptKey: "validation/traceability" },
  specificity: { toolName: "record_specificity", baseMaxTokens: 512, promptKey: "validation/specificity" },
  generation: { toolName: "record_resume", baseMaxTokens: 4096, promptKey: "generation/resume" },
});

export interface ResolvedStageSettings {
  readonly provider: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly toolChoice: "forced" | "auto";
  readonly effort?: Effort;
  readonly outputBudgetFactor: number;
}

export interface ResolvedVariant {
  readonly label: string;
  readonly stages: Readonly<Record<string, ResolvedStageSettings>>;
  readonly promptVersions: Readonly<Record<string, { readonly version: string; readonly fingerprint: string }>>;
}

/**
 * The pinned downstream validator a generation run reports a pass rate
 * from: its per-stage settings and prompt fingerprints at production
 * defaults. Recorded once per run, outside any variant override, so two
 * generation runs graded by different judges are never compared.
 */
export interface ResolvedJudge {
  readonly stages: Readonly<Record<string, ResolvedStageSettings>>;
  readonly promptVersions: Readonly<Record<string, { readonly version: string; readonly fingerprint: string }>>;
}

export function assertNoOverrides(): void {
  const leaked = {
    models: getModelOverrides(),
    efforts: getEffortOverrides(),
    prompts: getPromptVersionOverrides(),
  };
  if (
    Object.keys(leaked.models).length > 0 ||
    Object.keys(leaked.efforts).length > 0 ||
    Object.keys(leaked.prompts).length > 0
  ) {
    throw new Error(`override leaked: ${JSON.stringify(leaked)}`);
  }
}

/** Every stage's production default. Throws if any override is installed. */
export function snapshotDefaults(): Readonly<Record<Stage, ModelConfig>> {
  assertNoOverrides();
  return Object.freeze(Object.fromEntries(STAGES.map((s) => [s, { ...modelFor(s) }]))) as Readonly<
    Record<Stage, ModelConfig>
  >;
}

/**
 * The validator that grades generated output must be the production
 * one: no model or effort override on any validation stage.
 */
export function assertValidationAtDefaults(defaults: Readonly<Record<Stage, ModelConfig>>): void {
  for (const s of VALIDATION_STAGES) {
    const now = modelFor(s);
    if (now.provider !== defaults[s].provider || now.model !== defaults[s].model || effortFor(s) !== undefined) {
      throw new Error(
        `validator under test is not pinned to production defaults: ${s} resolves to ${now.model}` +
          (effortFor(s) !== undefined ? ` with effort ${effortFor(s)}` : ""),
      );
    }
  }
}

/** The settings a stage sends right now, under whatever overrides are installed. */
export function resolveStage(stage: Stage): ResolvedStageSettings {
  const entry = STAGE_REQUEST_TABLE[stage];
  if (entry === undefined) throw new Error(`no request table entry for stage ${stage}`);
  const { provider, model } = modelFor(stage);
  const req = toolCallRequest({
    model,
    toolName: entry.toolName,
    baseMaxTokens: entry.baseMaxTokens,
    effort: effortFor(stage),
  });
  return {
    provider,
    model,
    maxTokens: req.max_tokens,
    toolChoice: req.tool_choice.type === "tool" ? "forced" : "auto",
    ...(req.effort !== undefined && { effort: req.effort }),
    outputBudgetFactor: profileFor(model).outputBudgetFactor,
  };
}

function splitKey(key: string): [PromptStage, string] {
  const [stage, name] = key.split("/") as [PromptStage, string];
  return [stage, name];
}

function fingerprint(key: string): { version: string; fingerprint: string } {
  const [stage, name] = splitKey(key);
  const fp = promptFingerprint(stage, name as PromptName<typeof stage>);
  return { version: fp.slice(0, fp.indexOf(":")), fingerprint: fp };
}

function restore(defaults: Readonly<Record<Stage, ModelConfig>>): void {
  clearModelOverrides();
  clearEffortOverrides();
  clearPromptVersionOverrides();
  assertNoOverrides();
  for (const s of STAGES) {
    const now = modelFor(s);
    if (now.provider !== defaults[s].provider || now.model !== defaults[s].model) {
      throw new Error(`override restore failed: ${s} resolves to ${now.model}, default ${defaults[s].model}`);
    }
  }
}

/**
 * Install `variant` (plus the command-wide prompt versions) for `fn`,
 * then clear everything and prove the defaults are back, whether `fn`
 * resolved or threw. Resolution runs `toolCallRequest` per stage, so an
 * unsupported effort refuses here, before `fn` and before any request.
 */
export async function withVariantOverrides<T>(
  variant: SweepVariant,
  scope: SweepScope,
  basePromptVersions: Readonly<Record<string, string>>,
  fn: (resolved: ResolvedVariant) => Promise<T>,
): Promise<{ value: T; resolved: ResolvedVariant }> {
  const defaults = snapshotDefaults();
  const outOfScope: string[] = [];
  for (const s of Object.keys(variant.models ?? {})) if (!scope.stages.includes(s as Stage)) outOfScope.push(`model.${s}`);
  for (const s of Object.keys(variant.efforts ?? {})) if (!scope.stages.includes(s as Stage)) outOfScope.push(`effort.${s}`);
  for (const k of [...Object.keys(variant.promptVersions ?? {}), ...Object.keys(basePromptVersions)]) {
    if (!scope.promptKeys.includes(k)) outOfScope.push(`prompt.${k}`);
  }
  if (outOfScope.length > 0) {
    throw new Error(
      `variant "${variant.label}": ${outOfScope.join(", ")} not exercised by suite ${scope.suite}`,
    );
  }

  try {
    setModelOverrides(variant.models ?? {});
    setEffortOverrides(variant.efforts ?? {});
    setPromptVersionOverrides({ ...basePromptVersions, ...(variant.promptVersions ?? {}) });
    const stages: Record<string, ResolvedStageSettings> = {};
    for (const s of scope.stages) stages[s] = resolveStage(s);
    const promptVersions: Record<string, { version: string; fingerprint: string }> = {};
    for (const k of scope.promptKeys) promptVersions[k] = fingerprint(k);
    const resolved: ResolvedVariant = Object.freeze({ label: variant.label, stages, promptVersions });
    const value = await fn(resolved);
    return { value, resolved };
  } finally {
    restore(defaults);
  }
}

/**
 * Resolve `judgeScope` (the validation suite's stages and prompts) with
 * no override installed: the judge a generation run grades with. Throws
 * if any override is installed, so a leaked override can never be
 * recorded as the judge.
 */
export function resolveJudge(judgeScope: SweepScope): ResolvedJudge {
  assertNoOverrides();
  const stages: Record<string, ResolvedStageSettings> = {};
  for (const s of judgeScope.stages) stages[s] = resolveStage(s);
  const promptVersions: Record<string, { version: string; fingerprint: string }> = {};
  for (const k of judgeScope.promptKeys) promptVersions[k] = fingerprint(k);
  return Object.freeze({ stages, promptVersions });
}
