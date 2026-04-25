/**
 * Validation pipeline — claim extraction (sub-issue #106 of #23).
 *
 * Decomposes a generated bullet/sentence into discrete atomic
 * claims that downstream traceability (#107) and specificity
 * (#108) checks operate on.
 *
 * Same retry + cost-tracking shape as `parsing/jd.ts`:
 *   1. First attempt uses the prompt as authored.
 *   2. Retry with a progressively stricter reminder up to 2 times.
 *   3. After 2 retries, throw `ClaimExtractionError` with per-
 *      attempt log.
 * `recordUsage` fires per successful response so retries never
 * silently undercount cost.
 *
 * Server-stamped fields (deliberately excluded from the prompt's
 * response): `id`, `bullet_id`. Stamped here from
 * `ClaimExtractionContext`.
 *
 * Why pure-ish (one LLM call, no I/O beyond that): the
 * orchestrator (#109) will call this for each bullet of an
 * Application's generated asset. Keeping this module focused
 * makes per-bullet timing measurable + each call independently
 * unit-testable via DI.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import {
  ClaimExtractionResponseV1Schema,
  type ClaimExtractionResponseV1,
  type ClaimItemV1,
} from "../prompts/validation/claimExtraction.v1.schema.js";
import { loadPromptText } from "../prompts/loader.js";

import {
  ClaimExtractionError,
  type ValidationAttemptFailure,
} from "./errors.js";

export interface ClaimExtractionContext {
  readonly ownerUid: string;
  readonly assetId: string;
  readonly bulletId: string;
  /** Optional: the section title ("experience", "summary"). */
  readonly sectionTitle?: string;
}

export interface BulletInput {
  readonly text: string;
  readonly source_unit_ids: readonly string[];
}

export interface Claim {
  readonly id: string;
  readonly bullet_id: string;
  readonly text: string;
  readonly raw_span?: string;
}

export interface ClaimExtractionDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  /**
   * Generate a stable claim id given the parent bulletId and the
   * claim's text. The default is a SHA-256-based content hash
   * (`${bulletId}::${claimText}` → 24-char hex prefix), so re-
   * extracting an unchanged bullet yields identical claim ids
   * across runs — important because downstream traceability +
   * specificity flag records key on `(asset_id, bullet_id,
   * claim_id)`. A `randomUUID()` default would churn those
   * records on every re-validation; CodeRabbit Major on PR #110
   * caught the regression risk.
   *
   * Tests can inject a deterministic generator (e.g. a counter)
   * by providing this dep — mirrors the override pattern already
   * used elsewhere in the codebase.
   */
  readonly generateId?: (bulletId: string, claimText: string) => string;
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_claims";

const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.",
  "\n\nYour previous two attempts failed. Be strict about field types and required fields. If a claim is unclear, drop it rather than invent.",
];

export async function extractClaims(
  bullet: BulletInput,
  ctx: ClaimExtractionContext,
  deps: ClaimExtractionDeps = {},
): Promise<Claim[]> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const generateId = deps.generateId ?? defaultGenerateId;

  if (typeof bullet.text !== "string" || bullet.text.trim().length === 0) {
    // Empty input is a caller bug, not an LLM failure. Throw
    // synchronously so the orchestrator's per-bullet try/catch
    // distinguishes "bad input" from "LLM retry budget exhausted".
    throw new ClaimExtractionError(
      "extractClaims: bullet.text is empty or whitespace; nothing to extract.",
      [],
    );
  }

  const prompt = loadPromptText("validation", "claimExtraction");
  const { provider, model } = modelFor("validation");
  if (provider !== "anthropic") {
    throw new Error(
      `Validation stage expects an Anthropic model; modelFor("validation") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToJsonSchema(ClaimExtractionResponseV1Schema, {
    target: "openApi3",
    $refStrategy: "none",
  });

  const failures: ValidationAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = buildUserContent(prompt.userFewShot, bullet, ctx);

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Record atomic claims extracted from a generated resume bullet.",
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

    const parsed = ClaimExtractionResponseV1Schema.safeParse(toolUse.input);
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

  throw new ClaimExtractionError(
    `Claim extraction failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

function buildUserContent(
  userFewShot: string,
  bullet: BulletInput,
  ctx: ClaimExtractionContext,
): string {
  const sectionLine = ctx.sectionTitle
    ? `\nSection: ${ctx.sectionTitle}`
    : "";
  return `${userFewShot}\n\nBullet to decompose:${sectionLine}\n\n${bullet.text}`;
}

function stampServerFields(
  response: ClaimExtractionResponseV1,
  ctx: ClaimExtractionContext,
  generateId: (bulletId: string, claimText: string) => string,
): Claim[] {
  return response.claims.map((raw) => stampOne(raw, ctx, generateId));
}

function stampOne(
  raw: ClaimItemV1,
  ctx: ClaimExtractionContext,
  generateId: (bulletId: string, claimText: string) => string,
): Claim {
  // Firestore rejects undefined — only include raw_span when
  // present. Same conditional-spread pattern as
  // parsing/jd.ts::stampOne.
  return {
    id: generateId(ctx.bulletId, raw.text),
    bullet_id: ctx.bulletId,
    text: raw.text,
    ...(raw.raw_span !== undefined && { raw_span: raw.raw_span }),
  };
}

/**
 * Default stable id generator. SHA-256 of `${bulletId}::${claimText}`,
 * 24-char hex prefix. Stable across runs for the same (bullet,
 * claim text) pair → re-extracting an unchanged bullet yields
 * identical claim ids → downstream flag records don't churn.
 *
 * 24 chars of hex = 96 bits of collision space. With ~5 claims
 * per bullet × ~50 bullets per asset × ~100 assets = 25K claims
 * total in V1 expected use. The birthday-bound collision
 * probability at this scale is ~10^-21 — well below any
 * operational concern.
 *
 * The `::` separator avoids ambiguity if a bulletId or claimText
 * contains a colon. The double-colon isn't otherwise present in
 * UUIDs (the canonical bulletId source) or English prose (the
 * canonical claimText source).
 */
function defaultGenerateId(bulletId: string, claimText: string): string {
  return createHash("sha256")
    .update(`${bulletId}::${claimText}`)
    .digest("hex")
    .slice(0, 24);
}
