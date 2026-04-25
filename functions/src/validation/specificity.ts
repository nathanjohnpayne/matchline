/**
 * Validation pipeline — specificity check (sub-issue #108 of #23).
 *
 * Two-layer design: deterministic deny-list + LLM fallback. The
 * deny-list catches the canonical empty-PM tropes ("collaborated
 * cross-functionally", "drove results", etc.) at zero cost. The
 * LLM only runs for claims that escape the deny-list.
 *
 * Why two layers:
 *   - The deny-list patterns are 100% confident — no LLM needed.
 *     Burning a Sonnet call on "Drove results" wastes budget.
 *   - The LLM catches the harder case: claims that aren't on the
 *     deny-list but are still vague ("The user took ownership of
 *     outcomes" — different wording, same emptiness).
 *
 * Same retry + cost-tracking shape as `claimExtraction.ts` and
 * `traceability.ts` for the LLM fallback. The deny-list path
 * costs no tokens and emits no recordUsage call.
 *
 * Sized "S" per the issue spec — the smallest of the four #23
 * sub-issues. Most of the substance lives in the deny-list +
 * the prompt; the orchestration is straightforward.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";

import { anthropic } from "../llm/anthropic.js";
import { modelFor } from "../llm/config.js";
import { recordUsage } from "../llm/cost.js";
import {
  SpecificityResponseV1Schema,
  type SpecificityResponseV1,
} from "../prompts/validation/specificity.v1.schema.js";
import { loadPromptText } from "../prompts/loader.js";

import type { Claim } from "./claimExtraction.js";
import {
  SpecificityCheckError,
  type ValidationAttemptFailure,
} from "./errors.js";
import {
  SPECIFICITY_DENY_LIST,
  type DenyListEntry,
} from "./specificity.denyList.js";

export interface SpecificityResult {
  readonly specific: boolean;
  readonly rationale: string;
  /**
   * Set when the result came from a deny-list match (deterministic
   * path). Absent when the result came from the LLM fallback.
   * The orchestrator (#109) uses this to disambiguate flag
   * provenance in the Application Editor's hover detail.
   */
  readonly matched_pattern?: string;
}

export interface SpecificityContext {
  readonly ownerUid: string;
}

export interface SpecificityDeps {
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  /** Override the deny-list for tests. */
  readonly denyList?: readonly DenyListEntry[];
}

const MAX_ATTEMPTS = 3;
const TOOL_NAME = "record_specificity";

const RETRY_REMINDERS: readonly string[] = [
  "",
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema; do not add fields that aren't in the schema; do not omit required fields.",
  "\n\nYour previous two attempts failed. Be strict about field types and required fields. If unsure, return specific=false — false-negatives surface as flags the user can dismiss; false-positives let vague prose ship.",
];

export async function checkSpecificity(
  claim: Claim,
  ctx: SpecificityContext,
  deps: SpecificityDeps = {},
): Promise<SpecificityResult> {
  const denyList = deps.denyList ?? SPECIFICITY_DENY_LIST;

  // Layer 1: deterministic deny-list. Microseconds-fast, zero
  // tokens. Returns the FIRST matching pattern; the rationale
  // surfaces both the pattern and the curator's "why this is
  // vague" explanation.
  const denyHit = matchDenyList(claim.text, denyList);
  if (denyHit !== null) {
    const rationale = denyHit.suggested_specific
      ? `${denyHit.reason} Consider: ${denyHit.suggested_specific}`
      : denyHit.reason;
    return {
      specific: false,
      rationale,
      matched_pattern: denyHit.pattern,
    };
  }

  // Layer 2: LLM fallback. Same retry + cost-tracking shape as
  // the rest of the validation pipeline.
  return runLlmFallback(claim, ctx, deps);
}

/**
 * Case-insensitive substring scan. Returns the first matching
 * entry or null. The order of `denyList` entries is the
 * deny-list's curated priority — earlier-listed patterns win on
 * ties. SPECIFICITY_DENY_LIST is ordered roughly by frequency
 * of occurrence in PM resume tropes.
 */
function matchDenyList(
  claimText: string,
  denyList: readonly DenyListEntry[],
): DenyListEntry | null {
  const lower = claimText.toLowerCase();
  for (const entry of denyList) {
    if (lower.includes(entry.pattern)) return entry;
  }
  return null;
}

async function runLlmFallback(
  claim: Claim,
  ctx: SpecificityContext,
  deps: SpecificityDeps,
): Promise<SpecificityResult> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;

  const prompt = loadPromptText("validation", "specificity");
  const { provider, model } = modelFor("validation");
  if (provider !== "anthropic") {
    throw new Error(
      `Validation stage expects an Anthropic model; modelFor("validation") returned provider=${provider}. Update config.ts.`,
    );
  }

  const toolSchema = zodToJsonSchema(SpecificityResponseV1Schema, {
    target: "openApi3",
    $refStrategy: "none",
  });

  const failures: ValidationAttemptFailure[] = [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    const systemWithReminder = prompt.system + (RETRY_REMINDERS[attempt] ?? "");
    const userContent = `${prompt.userFewShot}\n\nClaim: ${JSON.stringify(claim.text)}`;

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 512,
        system: systemWithReminder,
        tools: [
          {
            name: TOOL_NAME,
            description:
              "Record the specificity verdict for one claim — is it specific enough to fact-check?",
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

    const parsed = SpecificityResponseV1Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({
        attempt,
        kind: "schema_error",
        message: parsed.error.message,
        zodIssues: parsed.error.issues,
      });
      continue;
    }

    return finalizeResult(parsed.data);
  }

  throw new SpecificityCheckError(
    `Specificity check failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

function finalizeResult(raw: SpecificityResponseV1): SpecificityResult {
  return {
    specific: raw.specific,
    rationale: raw.rationale,
    // matched_pattern intentionally absent — LLM-fallback
    // results don't have a deny-list pattern. The orchestrator
    // distinguishes deny-list vs. LLM by this field's presence.
  };
}
