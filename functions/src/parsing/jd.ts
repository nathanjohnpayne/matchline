/**
 * JD parsing core. Pasted job-description text + `{ownerUid, roleId}`
 * context → array of `JobRequirementUnit`s ready for embedding and
 * persistence (see `pipeline.ts` for the composition).
 *
 * Same retry + cost-tracking pattern as `extraction/resume.ts`:
 *   1. First attempt uses the prompt as authored.
 *   2. Retry up to 2 times, with a reminder chosen by the *previous*
 *      attempt's actual failure kind (schema error vs no tool_use vs
 *      transport/truncation) rather than by attempt index — see
 *      `retryReminderFor`.
 *   3. After 2 retries, throw `JdParsingError` with per-attempt log.
 * `recordUsage` fires per successful response so retries never
 * silently undercount the cost.
 *
 * Server-stamped fields (deliberately excluded from the prompt's
 * response): `id`, `owner_uid`, `role_id`, `embedding`. Stamped here.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { zodToToolSchema } from "../llm/zodToolSchema.js";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage, safeRecordUsage } from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
import { logRetryExhaustion } from "../llm/retryDiagnostics.js";
import { safeProgress, type ProgressReporter } from "../llm/progress.js";
import {
  JdParsingResponseV1Schema,
  type JdParsingResponseV1,
  type ParsedRequirementV1,
} from "../prompts/parsing/jd.v1.schema.js";
import { loadPromptText } from "../prompts/loader.js";
import type { JobRequirementUnit } from "../types/capability.js";

import {
  JdParsingError,
  type JdParsingAttemptFailure,
} from "./errors.js";

export interface JdParsingContext {
  readonly ownerUid: string;
  readonly roleId: string;
}

export interface JdParsingDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  readonly generateId?: () => string;
  /** Optional progress sink (#428); reports each attempt. */
  readonly onProgress?: ProgressReporter;
  /**
   * Aborted when the caller is gone (client disconnect). Checked only
   * BEFORE starting a new attempt — never to discard work already
   * done. See the check in the retry loop for why (#436).
   */
  readonly signal?: AbortSignal;
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_job_requirements";

/**
 * Output-token budget per attempt. Mirrors `MAX_OUTPUT_TOKENS`
 * in `extraction/resume.ts`. The previous `4096` ceiling silently
 * truncated long JD parses (Google's SPM listing carries ~25
 * Requirements once each is fully labeled with category, priority,
 * extracted_from, and skills/tools/domains). `16_384` (4× prior)
 * gives generous headroom and stays well inside Sonnet 4.6's
 * 64,000-token output ceiling.
 */
const MAX_OUTPUT_TOKENS = 16_384;

const SCHEMA_ERROR_REMINDER =
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.";
const REPEATED_SCHEMA_ERROR_REMINDER =
  "\n\nYour previous two attempts failed. Be strict about field types, required fields, and enum values. If a requirement's category is unclear, drop it rather than invent.";
const NO_TOOL_USE_REMINDER =
  "\n\nYour previous response did not call the tool. You must respond by calling the tool with the parsed requirements; do not respond with plain text.";

/**
 * Build the reminder text to append to the system prompt for the next
 * attempt, keyed by the *previous* attempt's actual failure kind
 * rather than by attempt index. `transport_error` and
 * `max_tokens_exceeded` get no reminder — a retry can't correct
 * either via prompt text (transport failures aren't the model's
 * fault, and truncation needs a higher token budget, not stricter
 * instructions). See #334.
 */
function retryReminderFor(
  previousFailure: JdParsingAttemptFailure | undefined,
  attempt: number,
): string {
  if (!previousFailure) return "";
  switch (previousFailure.kind) {
    case "schema_error":
      return attempt >= 2 ? REPEATED_SCHEMA_ERROR_REMINDER : SCHEMA_ERROR_REMINDER;
    case "no_tool_use":
      return NO_TOOL_USE_REMINDER;
    case "transport_error":
    case "max_tokens_exceeded":
      return "";
  }
}

export async function parseJobRequirements(
  text: string,
  ctx: JdParsingContext,
  deps: JdParsingDeps = {},
): Promise<JobRequirementUnit[]> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const generateId = deps.generateId ?? randomUUID;
  const report = safeProgress(deps.onProgress);
  const signal = deps.signal;
  let abortedBeforeAttempt = false;

  const prompt = loadPromptText("parsing", "jd");
  const { provider, model } = modelFor("requirement_parsing");
  if (provider !== "anthropic") {
    throw new Error(
      `Parsing stage expects an Anthropic model; modelFor("requirement_parsing") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToToolSchema(JdParsingResponseV1Schema);

  const failures: JdParsingAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
      prompt.system + retryReminderFor(failures.at(-1), attempt);
    const userContent = `${prompt.userFewShot}\n\nJob description to parse:\n\n${text}`;

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description: "Record parsed Requirement Units from the job description.",
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
      // Exponential backoff + jitter on transport errors only;
      // schema/no-tool-use failures stay zero-delay (those are
      // content failures the model can fix on the next attempt).
      // See functions/src/llm/retry.ts for the schedule.
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

    // Cost telemetry must never block a successful LLM verdict.
    // safeRecordUsage centralizes the try/catch + log-warn shape
    // (CodeRabbit Nitpick on PR #118); see llm/cost.ts for the
    // redaction contract.
    await safeRecordUsage(
      record,
      () => ({
        stage: "requirement_parsing",
        provider: "anthropic",
        model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs: Date.now() - start,
        ownerUid: ctx.ownerUid,
      }),
      "parsing.jd",
    );

    // `stop_reason: "max_tokens"` means the model hit the budget
    // mid-tool-call and the `tool_use.input` is truncated. Surface
    // as its own failure kind so debug runs don't chase a
    // misleading "requirements required" schema error. Retries
    // can't fix the truncation. See extraction/resume.ts for the
    // full rationale.
    if (response.stop_reason === "max_tokens") {
      failures.push({
        attempt,
        kind: "max_tokens_exceeded",
        message:
          `Anthropic returned stop_reason: "max_tokens" — the model hit the ` +
          `${MAX_OUTPUT_TOKENS}-token output budget mid-tool-call and the ` +
          `tool_use.input was truncated. Retries cannot recover; raise ` +
          `MAX_OUTPUT_TOKENS in parsing/jd.ts.`,
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

    const parsed = JdParsingResponseV1Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
      });
      continue;
    }

    return stampServerFields(parsed.data, ctx, generateId);
  }

  // See extraction/resume.ts — same silent-failure gap (#426).
  // Not a retry-budget exhaustion when we stopped because the
  // caller disconnected — logging it as one would misattribute
  // a deliberate stop as a failure (#436).
  if (!abortedBeforeAttempt) logRetryExhaustion("parsing.jd", model, failures);
  throw new JdParsingError(
    `JD parsing failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

function stampServerFields(
  response: JdParsingResponseV1,
  ctx: JdParsingContext,
  generateId: () => string,
): JobRequirementUnit[] {
  return response.requirements.map((raw) => stampOne(raw, ctx, generateId));
}

function stampOne(
  raw: ParsedRequirementV1,
  ctx: JdParsingContext,
  generateId: () => string,
): JobRequirementUnit {
  // Firestore rejects undefined — only include seniority_level when
  // present. Same conditional-spread pattern as resume.ts::stampOne
  // (Codex P1 on #47 / #68).
  return {
    id: generateId(),
    owner_uid: ctx.ownerUid,
    role_id: ctx.roleId,
    raw_text: raw.raw_text,
    normalized_requirement: raw.normalized_requirement,
    category: raw.category,
    keywords: raw.keywords,
    tools: raw.tools,
    domains: raw.domains,
    priority: raw.priority,
    must_have: raw.must_have,
    extracted_from: raw.extracted_from,
    ...(raw.seniority_level !== undefined && { seniority_level: raw.seniority_level }),
  };
}
