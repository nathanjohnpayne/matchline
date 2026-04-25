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
import { zodToJsonSchema } from "zod-to-json-schema";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
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
      continue;
    }

    await record({
      stage: "validation",
      provider: "anthropic",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs: Date.now() - start,
      ownerUid: ctx.ownerUid,
    });

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
          `Model emitted supporting_unit_id="${raw.supporting_unit_id}" which is not in the candidate set; ` +
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
  return `${userFewShot}\n\nClaim: "${claim.text}"\n\nCandidate Experience Units:\n\n${unitsBlock}`;
}

function formatUnit(unit: ExperienceUnit): string {
  // Deterministic, prompt-friendly formatting. Including only
  // the fields the prompt's hard rules reference (raw_text,
  // normalized_summary, metrics) — adding more would burn tokens
  // for no gain. The Unit `id` is critical because the model's
  // response uses it as `supporting_unit_id`.
  const metricsBlock =
    unit.metrics && unit.metrics.length > 0
      ? unit.metrics
          .map(
            (m) =>
              `  { claim: "${m.claim}"${m.value !== undefined ? `, value: ${m.value}` : ""}${m.unit !== undefined ? `, unit: "${m.unit}"` : ""}${m.direction !== undefined ? `, direction: "${m.direction}"` : ""} }`,
          )
          .join(",\n")
      : "  (no metrics)";
  return [
    `[Unit ${unit.id}]`,
    `raw_text: "${unit.raw_text}"`,
    `normalized_summary: "${unit.normalized_summary}"`,
    `metrics: [`,
    metricsBlock,
    `]`,
  ].join("\n");
}
