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
 * `recordUsage` fires after every attempt, successful or not, so the
 * cost accounting in #47 doesn't undercount retries.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { randomUUID, createHash } from "node:crypto";
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
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

export async function extractFromResume(
  text: string,
  ctx: ExtractionContext,
  deps: ExtractionDeps = {},
): Promise<ExperienceUnit[]> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  const prompt = loadPromptText("extraction", "resume");
  const { provider, model } = modelFor("extraction");
  if (provider !== "anthropic") {
    throw new Error(
      `Extraction stage expects an Anthropic model; modelFor("extraction") " +
      "returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToToolSchema(ExtractionResponseV1Schema);

  const failures: ExtractionAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = `${prompt.userFewShot}\n\nResume to extract:\n\n${text}`;

    let response: Anthropic.Messages.Message;
    try {
      // Non-streaming call: pass stream: false explicitly so
      // TypeScript picks the Message overload (the default union
      // includes Stream<RawMessageStreamEvent>).
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
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
      // Transport errors still incur a token cost in rare cases; no
      // usage object to record. Sleep with exponential backoff +
      // jitter (longer for 429/503) before retrying so a rate-limit
      // window isn't compounded by a 3× rapid burst — see
      // functions/src/llm/retry.ts.
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
        stage: "extraction",
        provider: "anthropic",
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - start,
        ownerUid: ctx.ownerUid,
      });
    } catch (err) {
      // ownerUid intentionally omitted from the log payload —
      // matches the redaction shape `cost.ts` already uses on its
      // own internal failure paths so logs don't widen PII exposure
      // for an observability-only failure path. CodeRabbit Major on
      // PR #116.
      logger.warn("extraction.resume: recordUsage failed (non-fatal)", {
        stage: "extraction",
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // `stop_reason: "max_tokens"` means the model hit the budget
    // mid-tool-call and the `tool_use.input` is truncated (we've
    // observed `{}` in the wild on Nathan's resume at the prior
    // 4096 cap). Surface this as its own failure kind so debug
    // runs don't waste cycles chasing a misleading "units required"
    // schema error. Retries can't fix the truncation — bumping
    // MAX_OUTPUT_TOKENS is the only fix — but we still record all
    // 3 attempts so the cost accounting is honest.
    if (response.stop_reason === "max_tokens") {
      failures.push({
        attempt,
        kind: "max_tokens_exceeded",
        message:
          `Anthropic returned stop_reason: "max_tokens" — the model hit the ` +
          `${MAX_OUTPUT_TOKENS}-token output budget mid-tool-call and the ` +
          `tool_use.input was truncated. Retries cannot recover; raise ` +
          `MAX_OUTPUT_TOKENS in extraction/resume.ts.`,
      });
      continue;
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

    const parsed = ExtractionResponseV1Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
      });
      continue;
    }

    // Success — stamp server-side fields and return.
    return stampServerFields(parsed.data, text, ctx, generateId, now);
  }

  throw new ExtractionError(
    `Extraction failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
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
