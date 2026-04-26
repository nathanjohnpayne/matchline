/**
 * JD parsing core. Pasted job-description text + `{ownerUid, roleId}`
 * context → array of `JobRequirementUnit`s ready for embedding and
 * persistence (see `pipeline.ts` for the composition).
 *
 * Same retry + cost-tracking pattern as `extraction/resume.ts`:
 *   1. First attempt uses the prompt as authored.
 *   2. Retry with a progressively stricter reminder up to 2 times.
 *   3. After 2 retries, throw `JdParsingError` with per-attempt log.
 * `recordUsage` fires per successful response so retries never
 * silently undercount the cost.
 *
 * Server-stamped fields (deliberately excluded from the prompt's
 * response): `id`, `owner_uid`, `role_id`, `embedding`. Stamped here.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { randomUUID } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import { sleep, transportBackoffMs } from "../llm/retry.js";
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
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_job_requirements";

const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.",
  "\n\nYour previous two attempts failed. Be strict about field types, required fields, and enum values. If a requirement's category is unclear, drop it rather than invent.",
];

export async function parseJobRequirements(
  text: string,
  ctx: JdParsingContext,
  deps: JdParsingDeps = {},
): Promise<JobRequirementUnit[]> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const generateId = deps.generateId ?? randomUUID;

  const prompt = loadPromptText("parsing", "jd");
  const { provider, model } = modelFor("requirement_parsing");
  if (provider !== "anthropic") {
    throw new Error(
      `Parsing stage expects an Anthropic model; modelFor("requirement_parsing") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToJsonSchema(JdParsingResponseV1Schema, {
    target: "openApi3",
    $refStrategy: "none",
  });

  const failures: JdParsingAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = `${prompt.userFewShot}\n\nJob description to parse:\n\n${text}`;

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 4096,
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
        stage: "requirement_parsing",
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
      logger.warn("parsing.jd: recordUsage failed (non-fatal)", {
        stage: "requirement_parsing",
        model,
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
