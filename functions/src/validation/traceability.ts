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
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { anthropic } from "../llm/anthropic.js";
import { effortFor, modelFor, type ValidationStage } from "../llm/config.js";
import { toolCallRequest } from "../llm/modelProfile.js";
import {
  anthropicUsageFields,
  promptVersionLabel,
  recordUsage,
  safeRecordUsage,
} from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
import {
  TraceabilityResponseV2Schema,
  type TraceabilityResponseV2,
} from "../prompts/validation/traceability.v2.schema.js";
import { loadPromptText } from "../prompts/loader.js";
import type { ExperienceUnit } from "../types/capability.js";
import { logRetryExhaustion } from "../llm/retryDiagnostics.js";

import {
  TraceabilityCheckError,
  type ValidationAttemptFailure,
} from "./errors.js";
import type { Claim } from "./claimExtraction.js";
import {
  citedEntityId,
  formatUnitBlock,
  promptDate,
  quote,
  type UnitPromptFields,
} from "./unitPromptText.js";

/** This module's separately configurable model stage (#489). */
const STAGE: ValidationStage = "traceability";

/** Output-token budget per attempt; also recorded on each usage record. */
const MAX_OUTPUT_TOKENS = 1024;

export interface TraceabilityResult {
  /** Strict binary verdict — see schema for the contract. */
  readonly supports: boolean;
  /** Set when `supports: true`; the id of the Unit backing the claim. */
  readonly supporting_unit_id?: string;
  /** Plain-English explanation. */
  readonly rationale: string;
}

export interface TraceabilityContext {
  /**
   * Cancels the in-flight request and skips further retries: the
   * orchestrator aborts it at its deadline or after another call fails
   * (#619).
   */
  readonly signal?: AbortSignal;
  readonly ownerUid: string;
  /** Application whose asset is being validated; recorded on usage telemetry. */
  readonly applicationId?: string;
}

export interface TraceabilityDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  /** Clock for the run date the prompt shows (`promptDate`); injectable for tests. */
  readonly clock?: () => Date;
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_traceability";

/**
 * Model-visible reminder appended to the system prompt after a failed
 * attempt, keyed by what went wrong, as generation does
 * (`RETRY_REMINDER` in `../generation/pipeline.ts`, #485). The previous
 * list was keyed by attempt index, so attempt 1 blamed "schema
 * validation" even after a transport error, when the model had sent
 * nothing. A transport failure says nothing about the response, so the
 * reminder comes from the latest failure that produced one
 * (`lastResponseFailure`): after schema_error then transport_error,
 * attempt 3 still gets the schema reminder.
 */
const RETRY_REMINDER: Readonly<Record<ValidationAttemptFailure["kind"], string>> = {
  transport_error: "",
  no_tool_use:
    "\n\nYour previous response did not call the `record_traceability` tool. Respond only by calling it.",
  schema_error:
    "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields. Remember: supporting_unit_id MUST be present when supports=true and absent when supports=false. If unsure whether a Unit supports the claim, return supports=false.",
};

/**
 * The reminder for the next attempt: from the latest failure whose
 * attempt got a response from the model, or none when every failure so
 * far was a transport error (or there is none).
 */
export function traceabilityRetryReminder(failures: readonly ValidationAttemptFailure[]): string {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i]!;
    if (f.kind !== "transport_error") return RETRY_REMINDER[f.kind];
  }
  return "";
}

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
  const { provider, model } = modelFor(STAGE);
  if (provider !== "anthropic") {
    throw new Error(
      `Validation stage "${STAGE}" expects an Anthropic model; modelFor("${STAGE}") returned provider=${provider}. Update config.ts.`,
    );
  }
  // Model-specific request shape, built once before the retry loop so an
  // unsupported effort refuses before any request (modelProfile.ts, #579).
  // Never sends a manual `thinking` field: forced tool choice only where the
  // model accepts it, otherwise `auto` plus the suffix; a text answer is the
  // existing `no_tool_use` failure and retries (#489).
  const request = toolCallRequest({
    model,
    toolName: TOOL_NAME,
    baseMaxTokens: MAX_OUTPUT_TOKENS,
    effort: effortFor(STAGE),
  });

  const toolSchema = zodToToolSchema(TraceabilityResponseV2Schema);

  const failures: ValidationAttemptFailure[] = [];
  // Rendered once: the run date and the Units do not change between attempts.
  const today = promptDate((deps.clock ?? (() => new Date()))());
  const userContent = `${prompt.userFewShot}\n\n${renderTraceabilityInput(claim.text, today, candidateUnits)}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Don't start an attempt the orchestrator has already cancelled,
    // e.g. after a backoff that `sleep` cut short (Codex on #621).
    ctx.signal?.throwIfAborted();
    const start = Date.now();
    const systemWithReminder = prompt.system + request.systemSuffix + traceabilityRetryReminder(failures);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: request.max_tokens,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Record the traceability verdict for one claim against the candidate Experience Units.",
            input_schema: toolSchema as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: request.tool_choice,
        ...(request.output_config !== undefined && { output_config: request.output_config }),
        messages: [{ role: "user", content: userContent }],
        stream: false,
      }, { signal: ctx.signal, ...request.requestOptions });
    } catch (err) {
      // An abort is the orchestrator's decision, not a transport
      // fault: no retry, no backoff.
      if (ctx.signal?.aborted) throw err;
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
        await sleep(transportBackoffMs(attempt, err), ctx.signal);
      }
      continue;
    }

    // Cost telemetry must never block a successful LLM verdict.
    // safeRecordUsage centralizes the try/catch + log-warn shape
    // (CodeRabbit Nitpick on PR #118); see llm/cost.ts for the
    // redaction contract.
    await safeRecordUsage(
      record,
      () => ({
        stage: "validation",
        provider: "anthropic",
        model,
        subtask: STAGE,
        ...anthropicUsageFields(response),
        promptVersion: promptVersionLabel(prompt),
        attempt,
        maxTokens: request.max_tokens,
        ...(request.effort !== undefined && { effort: request.effort }),
        latencyMs: Date.now() - start,
        ownerUid: ctx.ownerUid,
        ...(ctx.applicationId !== undefined && { applicationId: ctx.applicationId }),
      }),
      "validation.traceability",
    );

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

    const parsed = TraceabilityResponseV2Schema.safeParse(toolUse.input);
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

  // Retry budget exhausted — record why, server-side (#426).
  logRetryExhaustion("validation.traceability", model, failures);
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
  raw: TraceabilityResponseV2,
  candidateUnits: readonly ExperienceUnit[],
): TraceabilityResult {
  // A model may echo the quotes `renderEntityId` puts around an unsafe
  // id; map that back to the raw id before the membership check.
  const supportingUnitId =
    raw.supporting_unit_id === undefined ? undefined : citedEntityId(raw.supporting_unit_id);
  if (raw.supports && supportingUnitId !== undefined) {
    const candidateIds = new Set(candidateUnits.map((u) => u.id));
    if (!candidateIds.has(supportingUnitId)) {
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
      supporting_unit_id: supportingUnitId,
      rationale: raw.rationale,
    };
  }
  return {
    supports: false,
    rationale: raw.rationale,
  };
}

/**
 * The real input that follows the prompt's few-shot examples: the claim,
 * the run date, then the Units. The Unit block is the same text
 * generation reads and the evidence version hashes
 * (`./unitPromptText.ts`, #485). The run date sits outside it, so it
 * never changes an evidence version; the prompt uses it only to treat a
 * `date_range` end later than today as no end (traceability.v2 rule 3).
 * Exported so the few-shot examples can be pinned to it.
 */
export function renderTraceabilityInput(
  claimText: string,
  today: string,
  candidateUnits: readonly UnitPromptFields[],
): string {
  return `Claim: ${quote(claimText)}\n\nToday: ${quote(today)}\n\nCandidate Experience Units:\n\n${formatUnitBlock(candidateUnits)}`;
}

