/**
 * Resume extraction pipeline core.
 *
 * Takes pasted resume text + caller context and produces a typed
 * array of `ExperienceUnit`s ready to be handed to the embedding
 * pipeline (#68) and persisted. No Firestore writes, no embeddings —
 * those are #68's concern.
 *
 * Retry policy per `specs/matchline.md § Execution targets /
 * Reliability`:
 *
 *   1. First attempt uses the prompt as authored.
 *   2. On schema violation or missing tool_use, re-prompt with a
 *      stricter reminder appended to the system prompt.
 *   3. Second retry appends an even stricter reminder.
 *   4. After 2 retries (3 total attempts), throw `ExtractionError`
 *      with the per-attempt failure log.
 *
 * One recovery runs before validation (#650): when the tool call's
 * `units` is a string that `JSON.parse`s to an array
 * (`claude-sonnet-4-6` sometimes double-encodes it on long résumés),
 * that array is validated in its place, so a well-formed one succeeds
 * without spending a retry. The attempt's usage record, and any
 * schema_error the decoded array still fails with, carry
 * `recovered: "units-string"`, and a warn line without résumé content
 * is logged. A string that does not decode to an array fails exactly
 * as before. After any attempt whose `units` arrived as a string,
 * decoded or not, every later attempt's reminder says `units` must be
 * a JSON array, not a string. See `prepareToolInput`.
 *
 * `recordUsage` fires after every attempt, successful or not, so the
 * cost accounting in #47 doesn't undercount retries.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID, createHash } from "node:crypto";
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { anthropic } from "../llm/anthropic.js";
import { effortFor, modelFor } from "../llm/config.js";
import { toolCallRequest } from "../llm/modelProfile.js";
import {
  anthropicUsageFields,
  promptVersionLabel,
  recordUsage,
  safeRecordUsage,
} from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
import { logRetryExhaustion } from "../llm/retryDiagnostics.js";
import { logger } from "firebase-functions";
import { safeProgress, type ProgressReporter } from "../llm/progress.js";
import {
  ExtractionResponseV1Schema,
  type ExtractionResponseV1,
  type ExtractedUnitV1,
} from "../prompts/extraction/resume.v1.schema.js";
import { loadPromptText } from "../prompts/loader.js";
import type { ExperienceUnit } from "../types/capability.js";

import {
  ExtractionError,
  type ExtractionAttemptFailure,
  type ExtractionRecovery,
} from "./errors.js";

export interface ExtractionContext {
  /** Firebase Auth uid of the owner stamped on every returned Unit. */
  readonly ownerUid: string;
}

export interface ExtractionDeps {
  /** Override for tests; defaults to the lazy Anthropic singleton. */
  readonly client?: Anthropic;
  /** Override for tests; defaults to the real `recordUsage` writer. */
  readonly record?: typeof recordUsage;
  /** Override for tests so ids and timestamps are deterministic. */
  readonly generateId?: () => string;
  readonly now?: () => Date;
  /**
   * Optional progress sink (#428). Reports each attempt so a retry is
   * visible to the user instead of looking like a hang.
   */
  readonly onProgress?: ProgressReporter;
  /**
   * Aborted when the caller is gone (client disconnect). Checked only
   * BEFORE starting a new attempt — never to discard work already
   * done. See the check in the retry loop for why (#436).
   */
  readonly signal?: AbortSignal;
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_experience_units";

/**
 * Output-token budget per attempt. Real resumes (Nathan's 9k-char
 * fixture: 8 roles × ~3 Units each = ~24 Units) serialize to
 * ~10-12k output tokens once each Unit's full schema is populated
 * (raw_text + normalized_summary + skills/tools/domains arrays +
 * metrics + signals). The previous `4096` ceiling silently
 * truncated mid-tool — the API returned `stop_reason: max_tokens`
 * and an empty `tool_use.input`, which the Zod validator then
 * read as `units: undefined` and bounced through all 3 attempts.
 *
 * `16_384` (4× the prior value) gives generous headroom for the
 * worst observed real-resume (Nathan's) and stays well inside
 * Sonnet 4.6's 64,000-token output ceiling. Cost impact is bounded
 * because billing is per-token-actually-emitted, not per-budget.
 *
 * Tracked at #145 (eval harness can't run end-to-end at the prior
 * cap). Same fix applied to `parsing/jd.ts` because long JDs hit
 * the same wall.
 */
const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Retry reminders appended to the system prompt on successive
 * attempts. Index i is appended on attempt (i+1), so attempt 0 gets
 * the original prompt unmodified.
 */
const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.",
  "\n\nYour previous two attempts failed schema validation. Be strict about field types, required fields, and enum values. If uncertain about a field, drop the Unit rather than invent a value.",
];

/**
 * Appended after the attempt's reminder once an earlier attempt's
 * `units` arrived as a string, whether or not it decoded (#650). The
 * generic reminders above did not change that shape in the #495 runs,
 * so this one names it.
 */
const UNITS_STRING_REMINDER =
  "\n\n`units` must be a JSON array, not a string. A previous response returned `units` as a string; return the array of Unit objects itself, not a string that encodes it.";

/** A tool call's input as it goes to validation, after `prepareToolInput`. */
export interface PreparedToolInput {
  /** What to validate: the input as returned, or with `units` decoded. */
  readonly input: unknown;
  /** True when the input's `units` arrived as a string, decodable or not. */
  readonly unitsWasString: boolean;
  /** Set only when the string was decoded into the array validated here. */
  readonly recovered?: ExtractionRecovery;
}

/**
 * Tolerant pre-parse of the tool call's input (#650). Pure.
 *
 * `claude-sonnet-4-6` sometimes returns `units` as a string holding the
 * JSON-encoded array instead of the array itself, and the stricter
 * reminders do not change it: on the longest fixture résumé that
 * failed all three attempts, about six minutes of model time per flow.
 *
 * When `units` is a string whose `JSON.parse` is an array, the result
 * is a shallow copy of the input with that array as `units` and
 * `recovered: "units-string"`. Anything else, including a string that
 * is not JSON or decodes to a non-array, comes back as the same input
 * object, so validation rejects it exactly as before. Only `units` is
 * touched: other keys, unknown ones included, still go to the
 * `.strict()` schema as the model sent them, and the decoded array's
 * contents are validated like any other.
 */
export function prepareToolInput(input: unknown): PreparedToolInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { input, unitsWasString: false };
  }
  const units: unknown = (input as Record<string, unknown>)["units"];
  if (typeof units !== "string") return { input, unitsWasString: false };
  let decoded: unknown;
  try {
    decoded = JSON.parse(units);
  } catch {
    return { input, unitsWasString: true };
  }
  if (!Array.isArray(decoded)) return { input, unitsWasString: true };
  return {
    input: { ...(input as Record<string, unknown>), units: decoded },
    unitsWasString: true,
    recovered: "units-string",
  };
}

type ToolUseBlock = Extract<Anthropic.Messages.ContentBlock, { type: "tool_use" }>;

/**
 * The response's first tool_use block. Guarded so a malformed
 * `content` (not an array, or holding a non-object element) cannot
 * throw ahead of usage recording, which now waits on this lookup; it
 * reads as no tool_use and is retried like one.
 */
function findToolUse(content: Anthropic.Messages.Message["content"]): ToolUseBlock | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (b): b is ToolUseBlock => b !== null && typeof b === "object" && b.type === "tool_use",
  );
}

export async function extractFromResume(
  text: string,
  ctx: ExtractionContext,
  deps: ExtractionDeps = {},
): Promise<ExperienceUnit[]> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const report = safeProgress(deps.onProgress);
  const signal = deps.signal;
  let abortedBeforeAttempt = false;

  const prompt = loadPromptText("extraction", "resume");
  const { provider, model } = modelFor("extraction");
  if (provider !== "anthropic") {
    throw new Error(
      `Extraction stage expects an Anthropic model; modelFor("extraction") " +
      "returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToToolSchema(ExtractionResponseV1Schema);
  // Model-specific request shape: tool choice, output budget, effort and
  // timeout (#495). Unchanged for the current pins; see llm/modelProfile.ts.
  const request = toolCallRequest({
    model,
    toolName: TOOL_NAME,
    baseMaxTokens: MAX_OUTPUT_TOKENS,
    effort: effortFor("extraction"),
  });

  const failures: ExtractionAttemptFailure[] = [];
  // Set after any attempt whose `units` arrived as a string, decoded or
  // not, so every later attempt's reminder names the shape (#650). A
  // later attempt runs only if that one failed.
  let sawUnitsString = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // 1-based for display: "attempt 2 of 3" reads correctly, and a
    // value above 1 is what tells the user a retry is under way.
    // Checked before EVERY attempt, including the first: the
    // client can disconnect while the callable is still doing
    // its pre-flight work (the Role ownership read, for the JD
    // path), so `attempt > 0` let a full request launch for a
    // caller already gone — defeating the bound it was added
    // for (Codex P2, #436). Still never used to discard work
    // already done; see the callable.
    if (signal?.aborted === true) {
      abortedBeforeAttempt = true;
      break;
    }
    report({ stage: "analyzing", attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS });
    const start = Date.now();
    const systemWithReminder =
      prompt.system +
      request.systemSuffix +
      (RETRY_REMINDERS[attempt] ?? "") +
      (sawUnitsString ? UNITS_STRING_REMINDER : "");
    const userContent = `${prompt.userFewShot}\n\nResume to extract:\n\n${text}`;

    let response: Anthropic.Messages.Message;
    try {
      // Non-streaming call: pass stream: false explicitly so
      // TypeScript picks the Message overload (the default union
      // includes Stream<RawMessageStreamEvent>).
      response = await client.messages.create({
        model,
        max_tokens: request.max_tokens,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description: "Record extracted Experience Units from the resume.",
            // zod-to-json-schema returns a JSON-schema-shaped object;
            // Anthropic's SDK accepts it verbatim as `input_schema`.
            input_schema: toolSchema as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: request.tool_choice,
        ...(request.output_config !== undefined && { output_config: request.output_config }),
        messages: [{ role: "user", content: userContent }],
        stream: false,
      }, request.requestOptions);
    } catch (err) {
      failures.push({
        attempt,
        kind: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
      // Transport errors still incur a token cost in rare cases; no
      // usage object to record. Sleep with exponential backoff +
      // jitter (longer for 429/503) before retrying so a rate-limit
      // window isn't compounded by a 3× rapid burst — see
      // functions/src/llm/retry.ts.
      if (attempt < MAX_ATTEMPTS - 1) {
        // Announce the wait BEFORE sleeping: a 429 carries a
        // retry-after that can be long, and staying on
        // "analyzing" through it recreates the apparent hang
        // this feature exists to remove (Codex P2, #436).
        report({
          stage: "retrying",
          attempt: attempt + 2,
          maxAttempts: MAX_ATTEMPTS,
        });
        await sleep(transportBackoffMs(attempt, err), signal);
      }
      continue;
    }

    // The tool call and its tolerant pre-parse are read before usage is
    // recorded, so the usage record can say the attempt was recovered
    // (#650). A refusal or a truncation never reaches validation, so
    // neither is read.
    const reachesValidation =
      response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens";
    const toolUse = reachesValidation ? findToolUse(response.content) : undefined;
    const prepared = toolUse === undefined ? undefined : prepareToolInput(toolUse.input);

    // Cost telemetry must never block a successful LLM verdict.
    // safeRecordUsage centralizes the try/catch + log-warn shape
    // (CodeRabbit Nitpick on PR #118); see llm/cost.ts for the
    // redaction contract.
    await safeRecordUsage(
      record,
      () => ({
        stage: "extraction",
        provider: "anthropic",
        model,
        ...anthropicUsageFields(response),
        promptVersion: promptVersionLabel(prompt),
        attempt,
        maxTokens: request.max_tokens,
        ...(request.effort !== undefined && { effort: request.effort }),
        ...(prepared?.recovered !== undefined && { recovered: prepared.recovered }),
        latencyMs: Date.now() - start,
        ownerUid: ctx.ownerUid,
      }),
      "extraction.resume",
    );

    // `stop_reason: "max_tokens"` means the model hit the budget
    // mid-tool-call and the `tool_use.input` is truncated (we've
    // observed `{}` in the wild on Nathan's resume at the prior
    // 4096 cap). Surface this as its own failure kind so debug
    // runs don't waste cycles chasing a misleading "units required"
    // schema error. Retries can't fix the truncation — bumping
    // MAX_OUTPUT_TOKENS is the only fix — but we still record all
    // 3 attempts so the cost accounting is honest.
    // A safety classifier declined the request (5.5 models report
    // `stop_reason: "refusal"`). Resending the same input declines the
    // same way, so stop here instead of spending the retry budget.
    if (response.stop_reason === "refusal") {
      failures.push({
        attempt,
        kind: "refusal",
        message:
          `Anthropic declined the request (stop_reason: "refusal"` +
          `${response.stop_details?.category ? `, category: ${response.stop_details.category}` : ""}).`,
      });
      break;
    }

    if (response.stop_reason === "max_tokens") {
      failures.push({
        attempt,
        kind: "max_tokens_exceeded",
        message:
          `Anthropic returned stop_reason: "max_tokens" — the model hit the ` +
          `${request.max_tokens}-token output budget mid-tool-call and the ` +
          `tool_use.input was truncated. Retries cannot recover; raise ` +
          `MAX_OUTPUT_TOKENS in extraction/resume.ts.`,
      });
      continue;
    }

    if (prepared === undefined) {
      failures.push({
        attempt,
        kind: "no_tool_use",
        message:
          "Anthropic response did not include a tool_use block; model returned text instead.",
      });
      continue;
    }

    if (prepared.unitsWasString) sawUnitsString = true;
    if (prepared.recovered !== undefined) {
      // Fixed fields only: no résumé text, no model output (the
      // redaction rule in llm/retryDiagnostics.ts).
      logger.warn("extraction.resume: tool input `units` arrived as a JSON string; validating the decoded array", {
        model,
        attempt,
        recovered: prepared.recovered,
      });
    }

    const parsed = ExtractionResponseV1Schema.safeParse(prepared.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
        ...(prepared.recovered !== undefined && { recovered: prepared.recovered }),
      });
      continue;
    }

    // Success — stamp server-side fields and return.
    return stampServerFields(parsed.data, text, ctx, generateId, now);
  }

  // Log before throwing: `failures` reaches the browser via
  // HttpsError.details but nothing wrote it to Cloud Logging, so a
  // production failure left no server-side trace of WHY (#426).
  // Not a retry-budget exhaustion when we stopped because the
  // caller disconnected — logging it as one would misattribute
  // a deliberate stop as a failure (#436).
  // A refusal stops after one attempt, so it is neither a retry-budget
  // exhaustion nor "Extraction failed after 3 attempts" (CodeRabbit on #579). Log it
  // as what it is, without request content, and say so to the caller.
  const refusal = failures.at(-1)?.kind === "refusal" ? failures.at(-1) : undefined;
  if (refusal) {
    logger.warn("extraction.resume: model declined the request", { model, detail: refusal.message });
  } else if (!abortedBeforeAttempt) {
    logRetryExhaustion("extraction.resume", model, failures);
  }
  throw new ExtractionError(
    refusal
      ? `Extraction was declined by the model (stop_reason: "refusal"). See .failures for detail.`
      : `Extraction failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

/**
 * Stamp the server-side fields that the prompt deliberately doesn't
 * emit (see `resume.v1.schema.ts` docstring for the exclusion list).
 * Every Unit lands with `user_approved: false` so the Unit Review
 * surface is the only path into matching per the zero-fabrication
 * invariant.
 */
function stampServerFields(
  response: ExtractionResponseV1,
  sourceText: string,
  ctx: ExtractionContext,
  generateId: () => string,
  now: () => Date,
): ExperienceUnit[] {
  const nowIso = now().toISOString();
  const sourceHash = createHash("sha256")
    .update(sourceText)
    .digest("hex")
    .slice(0, 16);

  return response.units.map((raw, idx) =>
    stampOne(raw, ctx, nowIso, sourceHash, idx, generateId),
  );
}

function stampOne(
  raw: ExtractedUnitV1,
  ctx: ExtractionContext,
  nowIso: string,
  sourceHash: string,
  idx: number,
  generateId: () => string,
): ExperienceUnit {
  // Firestore rejects documents containing `undefined` values by
  // default. `date_range` on the extraction response is optional,
  // so we only include it when present — same pattern as
  // recordUsage in functions/src/llm/cost.ts (Codex P1 on #47 and
  // repeated here on #68; both legitimate).
  return {
    id: generateId(),
    owner_uid: ctx.ownerUid,
    source_type: "resume",
    source_ref: `resume:${sourceHash}:${idx}`,
    raw_text: raw.raw_text,
    normalized_summary: raw.normalized_summary,
    unit_type: raw.unit_type,
    skills: raw.skills,
    tools: raw.tools,
    domains: raw.domains,
    seniority_signals: raw.seniority_signals,
    scope_signals: raw.scope_signals,
    business_outcomes: raw.business_outcomes,
    metrics: raw.metrics,
    evidence_type: raw.evidence_type,
    confidence_score: raw.confidence_score,
    user_approved: false,
    created_at: nowIso,
    updated_at: nowIso,
    ...(raw.date_range !== undefined && { date_range: raw.date_range }),
  };
}
