/**
 * Validation pipeline — traceability check (sub-issue #107 of #23).
 *
 * The load-bearing zero-fabrication gate at the per-claim level.
 * Given a claim + candidate Experience Units, an LLM call decides
 * whether any Unit semantically supports the claim. The orchestrator
 * (#109) treats `supports: false` as an export-blocking flag.
 *
 * Same retry + cost-tracking shape as `claimExtraction.ts`:
 *   1. First attempt uses the prompt as authored.
 *   2. Retry with a progressively stricter reminder up to 2 times.
 *   3. After 2 retries, throw `TraceabilityCheckError` with per-
 *      attempt log.
 * `recordUsage` fires per successful response so retries never
 * silently undercount cost.
 *
 * Pure-ish (one LLM call, no I/O beyond that). The orchestrator
 * (#109) calls this for each claim of an Application's generated
 * asset; keeping this module focused makes per-claim timing
 * measurable + each call independently unit-testable via DI.
 *
 * Empty `candidateUnits` short-circuits to `supports: false`
 * WITHOUT calling the LLM. This is both a cost optimization and
 * an explicit pin: no Units = no support possible. Documented in
 * the prompt's hard rule 7, and enforced redundantly here so the
 * caller doesn't accidentally rely on the LLM to say no — it
 * might fabricate a yes.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { zodToJsonSchema } from "zod-to-json-schema";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
import {
  TraceabilityResponseV1Schema,
  type TraceabilityResponseV1,
} from "../prompts/validation/traceability.v1.schema.js";
import { loadPromptText } from "../prompts/loader.js";
import type { ExperienceUnit } from "../types/capability.js";

import {
  TraceabilityCheckError,
  type ValidationAttemptFailure,
} from "./errors.js";
import type { Claim } from "./claimExtraction.js";

export interface TraceabilityResult {
  /** Strict binary verdict — see schema for the contract. */
  readonly supports: boolean;
  /** Set when `supports: true`; the id of the Unit backing the claim. */
  readonly supporting_unit_id?: string;
  /** Plain-English explanation. */
  readonly rationale: string;
}

export interface TraceabilityContext {
  readonly ownerUid: string;
}

export interface TraceabilityDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_traceability";

const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields. Remember: supporting_unit_id MUST be present when supports=true and absent when supports=false.",
  "\n\nYour previous two attempts failed. Be strict about field types and required fields. If unsure whether a Unit supports the claim, return supports=false — false-negatives are recoverable; false-positives let fabrications ship.",
];

/**
 * The synthetic rationale emitted when `candidateUnits` is empty.
 * Exported only for tests that pin this contract — production
 * callers should never need it directly.
 */
export const EMPTY_UNITS_RATIONALE =
  "No Experience Units provided as candidates; no support is possible.";

export async function checkTraceability(
  claim: Claim,
  candidateUnits: readonly ExperienceUnit[],
  ctx: TraceabilityContext,
  deps: TraceabilityDeps = {},
): Promise<TraceabilityResult> {
  // Empty-units short-circuit. Documented in the module
  // docstring + the prompt's hard rule 7. We enforce here too
  // so a misuse (calling with empty Units expecting the LLM to
  // catch it) doesn't risk the model fabricating an id.
  if (candidateUnits.length === 0) {
    return {
      supports: false,
      rationale: EMPTY_UNITS_RATIONALE,
    };
  }

  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;

  const prompt = loadPromptText("validation", "traceability");
  const { provider, model } = modelFor("validation");
  if (provider !== "anthropic") {
    throw new Error(
      `Validation stage expects an Anthropic model; modelFor("validation") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToJsonSchema(TraceabilityResponseV1Schema, {
    target: "openApi3",
    $refStrategy: "none",
  });

  const failures: ValidationAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = buildUserContent(prompt.userFewShot, claim, candidateUnits);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Record the traceability verdict for one claim against the candidate Experience Units.",
            input_schema: toolSchema as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: userContent }],
        stream: false,
      });
    } catch (err) {
      failures.push({
        attempt,
        kind: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
      // Exponential backoff + jitter on transport errors only.
      // The orchestrator (#109) calls checkTraceability per-claim,
      // so an asset with N claims fans out N×3 attempts; without
      // backoff a single 429 quickly cascades into a window-spanning
      // burst. See functions/src/llm/retry.ts.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(transportBackoffMs(attempt, err));
      }
      continue;
    }

    // Cost telemetry must never block a successful LLM verdict.
    // recordUsage is fire-and-forget by contract (see llm/cost.ts);
    // this guard is defense-in-depth so a future regression — or a
    // test-injected `record` that rejects — can't kill the pipeline.
    // CodeRabbit on PR #113.
    try {
      await record({
        stage: "validation",
        provider: "anthropic",
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - start,
        ownerUid: ctx.ownerUid,
      });
    } catch (err) {
      logger.warn("validation.traceability: recordUsage failed (non-fatal)", {
        stage: "validation",
        model,
        ownerUid: ctx.ownerUid,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (!toolUse) {
      failures.push({
        attempt,
        kind: "no_tool_use",
        message:
          "Anthropic response did not include a tool_use block; model returned text instead.",
      });
      continue;
    }

    const parsed = TraceabilityResponseV1Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
      });
      continue;
    }

    return finalizeResult(parsed.data, candidateUnits);
  }

  throw new TraceabilityCheckError(
    `Traceability check failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

/**
 * Final guard before returning to caller: when `supports: true`,
 * verify the model's `supporting_unit_id` actually appears in the
 * candidate set. The model may emit a confident-looking id that
 * doesn't match any input Unit — that's a fabrication of a
 * different shape than the schema can catch (the schema only
 * verifies the shape, not the value). If the id doesn't match,
 * we downgrade to `supports: false` with a diagnostic rationale
 * so the user sees the disagreement rather than getting an
 * invisible-to-them dangling reference.
 */
function finalizeResult(
  raw: TraceabilityResponseV1,
  candidateUnits: readonly ExperienceUnit[],
): TraceabilityResult {
  if (raw.supports && raw.supporting_unit_id !== undefined) {
    const candidateIds = new Set(candidateUnits.map((u) => u.id));
    if (!candidateIds.has(raw.supporting_unit_id)) {
      return {
        supports: false,
        rationale:
          `Model emitted supporting_unit_id=${JSON.stringify(raw.supporting_unit_id)} which is not in the candidate set; ` +
          `treating as unsupported. Original rationale: ${raw.rationale}`,
      };
    }
  }
  if (raw.supports) {
    return {
      supports: true,
      supporting_unit_id: raw.supporting_unit_id,
      rationale: raw.rationale,
    };
  }
  return {
    supports: false,
    rationale: raw.rationale,
  };
}

function buildUserContent(
  userFewShot: string,
  claim: Claim,
  candidateUnits: readonly ExperienceUnit[],
): string {
  const unitsBlock = candidateUnits.map(formatUnit).join("\n\n");
  return `${userFewShot}\n\nClaim: ${quote(claim.text)}\n\nCandidate Experience Units:\n\n${unitsBlock}`;
}

/**
 * Safely embed an arbitrary user-controlled string as a quoted
 * literal in the prompt body. `JSON.stringify` escapes embedded
 * `"`, backslashes, newlines, and control chars — the same shape
 * the few-shot examples already use.
 *
 * Codex P1 round 2 on PR #111: the prior version interpolated raw
 * strings inside `"..."` quotes, so any `"` inside the input
 * (legitimate — e.g. a quoted project name, a metric claim with
 * a quoted phrase) broke the format. A claim text `The user led
 * "Project Alpha"` would render as `Claim: "The user led "Project
 * Alpha"."` — malformed, and the prompt-friendly structure the
 * downstream model depends on was lost.
 *
 * `JSON.stringify` for short strings is identical to a hand-
 * written escape function but is part of the runtime, well-
 * tested, and unambiguous to readers.
 */
function quote(value: string): string {
  return JSON.stringify(value);
}

function formatUnit(unit: ExperienceUnit): string {
  // Deterministic, prompt-friendly formatting. Includes every
  // field the prompt's hard rules reference:
  //   - raw_text + normalized_summary (rules 1, 2, 5, 6)
  //   - metrics (rule 1: "Numeric facts (percentages, counts,
  //     durations) DO need to match within reasonable rounding")
  //   - seniority_signals (rule 3: "role-level fact (lead, owner,
  //     principal) and no Unit's seniority_signals or prose backs
  //     that level → false") — Codex P2 round 1 on PR #111 caught
  //     a prior version that omitted this field, leaving the
  //     prompt rule unable to fire.
  //   - scope_signals (rule 3 by analogy: scope claims need their
  //     scope context, same shape as seniority).
  // The Unit `id` is critical — the model's response uses it as
  // `supporting_unit_id`, and the value-level guard in
  // `finalizeResult` checks set membership.
  //
  // Every embedded string is run through `quote()` (= JSON.stringify)
  // so embedded `"`, `\\`, newlines, etc. don't break the format.
  // Codex P1 round 2 on PR #111.
  const metricsBlock =
    unit.metrics && unit.metrics.length > 0
      ? unit.metrics
          .map((m) => formatMetric(m))
          .join(",\n")
      : "  (no metrics)";
  const lines: string[] = [
    `[Unit ${unit.id}]`,
    `raw_text: ${quote(unit.raw_text)}`,
    `normalized_summary: ${quote(unit.normalized_summary)}`,
    `metrics: [`,
    metricsBlock,
    `]`,
  ];
  // Seniority + scope are emitted only when non-empty — the
  // prompt's rule 3 only needs them for role-level / scope
  // claims, and most Units won't have both. Keeping the format
  // tight reduces token cost on the common case.
  if (unit.seniority_signals && unit.seniority_signals.length > 0) {
    lines.push(
      `seniority_signals: [${unit.seniority_signals.map(quote).join(", ")}]`,
    );
  }
  if (unit.scope_signals && unit.scope_signals.length > 0) {
    lines.push(
      `scope_signals: [${unit.scope_signals.map(quote).join(", ")}]`,
    );
  }
  return lines.join("\n");
}

function formatMetric(m: ExperienceUnit["metrics"][number]): string {
  const parts: string[] = [`claim: ${quote(m.claim)}`];
  if (m.value !== undefined) parts.push(`value: ${m.value}`);
  if (m.unit !== undefined) parts.push(`unit: ${quote(m.unit)}`);
  if (m.direction !== undefined) parts.push(`direction: ${quote(m.direction)}`);
  return `  { ${parts.join(", ")} }`;
}
