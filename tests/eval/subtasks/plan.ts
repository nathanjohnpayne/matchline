/**
 * Dry-run request plan and spend projection for the subtask suites
 * (#488). Runs with no keys and constructs no client.
 *
 * Counts follow the suites exactly where they are deterministic
 * (isolated passes) and use heuristics where the model decides (claims
 * extracted in the whole-asset pass, items generated, claims per
 * generated item). Neither the generation schema nor the claim schema
 * bounds those counts, so the "conservative estimate" (`worstCaseUsd`:
 * every request at all 3 attempts and its full output cap) is NOT an
 * upper bound on spend; the expected case assumes 1 attempt at half the
 * cap. The per-request budget ledger (`budget.ts`) is the actual stop.
 */

import { VALIDATION_STAGES, type ModelConfig, type Stage } from "../../../functions/src/llm/config.ts";
import { priceFor } from "../../../functions/src/llm/cost.ts";
import { toolCallRequest } from "../../../functions/src/llm/modelProfile.ts";
import { loadPromptText } from "../../../functions/src/prompts/loader.ts";
import type { PromptName, PromptStage } from "../../../functions/src/prompts/config.ts";
import { canonicalJson } from "../../../functions/src/validation/attestation.ts";

import { estimateTokens } from "../tokenSource.ts";

import type { LoadedCase, LoadedSnapshot } from "./fixtures.ts";
import { STAGE_REQUEST_TABLE, type ResolvedStageSettings, type ResolvedVariant } from "./overrides.ts";

export const MAX_ATTEMPTS = 3;
/** Margin on the character-count token estimate. */
export const INPUT_MARGIN = 1.25;
/** Extra margin for the 5.5 tokenizer (≈ +30–35% tokens for the same text). */
export const TOKENIZER_55_FACTOR = 1.35;
/** Allowance for the longest retry reminder the modules append (they are not exported). */
export const RETRY_REMINDER_ALLOWANCE_CHARS = 600;
/** Heuristic (not a bound) for claims the whole-asset pass extracts per item: max(2·|A|, 8). */
export const WHOLE_ASSET_CLAIMS_FLOOR = 8;
/** Heuristic (not a bound) for claims per generated item in downstream validation. */
export const CLAIMS_PER_GENERATED_ITEM = 4;

export interface PlannedRequest {
  readonly variant: string;
  readonly stage: Stage;
  readonly pass: "isolated" | "whole_asset" | "generation" | "downstream";
  readonly count: number;
  readonly model: string;
  readonly maxTokens: number;
  readonly inputEstTokens: number;
}

export function is55(model: string): boolean {
  return /-5-5(?:$|-)/.test(model);
}

function promptText(stage: Stage): string {
  const key = STAGE_REQUEST_TABLE[stage]!.promptKey;
  const [s, n] = key.split("/") as [PromptStage, string];
  const p = loadPromptText(s, n as PromptName<typeof s>);
  return p.system + p.userFewShot;
}

/** Characters the 5.5 tool-use suffix adds to the system prompt (an upper bound). */
const AUTO_TOOL_SUFFIX_CHARS = 160;

/**
 * Input estimate for one request: prompt (system + few-shot, as loaded
 * under the installed overrides), the longest retry reminder, the 5.5
 * tool-use suffix, and the stage inputs, all with a 1.25 margin, then
 * x1.35 for a 5.5 model.
 */
export function inputEstimate(stage: Stage, settings: ResolvedStageSettings, stageInputs: unknown): number {
  const text =
    promptText(stage) +
    " ".repeat(RETRY_REMINDER_ALLOWANCE_CHARS + (settings.toolChoice === "auto" ? AUTO_TOOL_SUFFIX_CHARS : 0)) +
    canonicalJson(stageInputs);
  const base = Math.ceil(INPUT_MARGIN * estimateTokens(text));
  return Math.ceil(base * (is55(settings.model) ? TOKENIZER_55_FACTOR : 1));
}

function unitInputs(units: readonly { raw_text: string; normalized_summary: string }[]): unknown {
  return units.map((u) => ({ raw_text: u.raw_text, normalized_summary: u.normalized_summary }));
}

/** Plan one validation variant. Call while the variant's overrides are installed. */
export function planValidation(cases: readonly LoadedCase[], resolved: ResolvedVariant, samples: number): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  const add = (stage: Stage, pass: PlannedRequest["pass"], count: number, inputs: unknown): void => {
    if (count === 0) return;
    const st = resolved.stages[stage]!;
    out.push({
      variant: resolved.label,
      stage,
      pass,
      count: count * samples,
      model: st.model,
      maxTokens: st.maxTokens,
      inputEstTokens: inputEstimate(stage, st, inputs),
    });
  };
  for (const lc of cases) {
    const c = lc.case;
    const cited = c.units.filter((u) => c.item.source_unit_ids.includes(u.id));
    const a = c.gold.assertions.length;
    const longest = c.gold.assertions.reduce((m, x) => (x.text.length > m.length ? x.text : m), "");
    add("claim_extraction", "isolated", 1, c.item);
    // The empty-candidates short-circuit makes no call.
    add("traceability", "isolated", cited.length > 0 ? a : 0, { claim: longest, units: unitInputs(cited) });
    // Always a call: the deny-list is a hint, not a skip.
    add("specificity", "isolated", c.gold.assertions.filter((x) => x.specific !== null).length, { claim: longest });
    const wholeClaims = Math.max(2 * a, WHOLE_ASSET_CLAIMS_FLOOR);
    add("claim_extraction", "whole_asset", 1, c.item);
    add("traceability", "whole_asset", wholeClaims, { claim: c.item.text, units: unitInputs(cited) });
    add("specificity", "whole_asset", wholeClaims, { claim: c.item.text });
  }
  return out;
}

/** The settings a validation stage sends on its production default (no effort). */
export function defaultSettings(stage: Stage, defaults: Readonly<Record<Stage, ModelConfig>>): ResolvedStageSettings {
  const entry = STAGE_REQUEST_TABLE[stage]!;
  const req = toolCallRequest({ model: defaults[stage].model, toolName: entry.toolName, baseMaxTokens: entry.baseMaxTokens });
  return {
    provider: defaults[stage].provider,
    model: defaults[stage].model,
    maxTokens: req.max_tokens,
    toolChoice: req.tool_choice.type === "tool" ? "forced" : "auto",
    ...(req.effort !== undefined && { effort: req.effort }),
    outputBudgetFactor: 1,
  };
}

/** Units a generated item could cite, largest evidence text first: the downstream traceability input estimate. */
export const DOWNSTREAM_CITED_UNITS = 3;

/** The `k` Units with the most evidence text (raw_text + normalized_summary). */
export function largestUnits<U extends { raw_text: string; normalized_summary: string }>(units: readonly U[], k: number): U[] {
  return [...units]
    .sort((a, b) => b.raw_text.length + b.normalized_summary.length - (a.raw_text.length + a.normalized_summary.length))
    .slice(0, k);
}

/** Plan one generation variant. Downstream validation always uses production defaults. */
export function planGeneration(
  snaps: readonly LoadedSnapshot[],
  resolved: ResolvedVariant,
  defaults: Readonly<Record<Stage, ModelConfig>>,
  samples: number,
): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  for (const ls of snaps) {
    const s = ls.snapshot;
    const gen = resolved.stages.generation!;
    out.push({
      variant: resolved.label,
      stage: "generation",
      pass: "generation",
      count: samples,
      model: gen.model,
      maxTokens: gen.maxTokens,
      inputEstTokens: inputEstimate("generation", gen, { units: s.units, requirements: s.requirements, role: s.role, matches: s.approved_matches }),
    });
    const items = s.item_upper_bound;
    const units = unitInputs(largestUnits(s.units, DOWNSTREAM_CITED_UNITS));
    const counts: Record<string, number> = {
      claim_extraction: items,
      traceability: items * CLAIMS_PER_GENERATED_ITEM,
      specificity: items * CLAIMS_PER_GENERATED_ITEM,
    };
    for (const stage of VALIDATION_STAGES) {
      const st = defaultSettings(stage, defaults);
      out.push({
        variant: resolved.label,
        stage,
        pass: "downstream",
        count: counts[stage]! * samples,
        model: st.model,
        maxTokens: st.maxTokens,
        inputEstTokens: inputEstimate(stage, st, { claim: "x".repeat(400), units }),
      });
    }
  }
  return out;
}

export interface Projection {
  readonly requests: number;
  readonly expectedUsd: number;
  /** Conservative estimate (3 attempts × full cap at the heuristic counts); not a bound. */
  readonly worstCaseUsd: number;
  readonly rows: readonly (PlannedRequest & { readonly expectedUsd: number; readonly worstCaseUsd: number })[];
}

export function project(plan: readonly PlannedRequest[]): Projection {
  const rows = plan.map((r) => ({
    ...r,
    expectedUsd: r.count * priceFor(r.model, { inputTokens: r.inputEstTokens, outputTokens: Math.ceil(r.maxTokens / 2) }),
    worstCaseUsd: r.count * MAX_ATTEMPTS * priceFor(r.model, { inputTokens: r.inputEstTokens, outputTokens: r.maxTokens }),
  }));
  return {
    requests: rows.reduce((s, r) => s + r.count, 0),
    expectedUsd: rows.reduce((s, r) => s + r.expectedUsd, 0),
    worstCaseUsd: rows.reduce((s, r) => s + r.worstCaseUsd, 0),
    rows,
  };
}
