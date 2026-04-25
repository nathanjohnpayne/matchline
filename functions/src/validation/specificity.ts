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
import { logger } from "firebase-functions";
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

  // Layer 1: deterministic deny-list as a HINT to the LLM, not
  // a hard veto. Codex P1 round 1 on PR #113 caught the prior
  // hard-veto behavior: "drove results — shipped a 30% revenue
  // lift" trips the deny-list AND has concrete anchors, but the
  // hard-veto branch returned specific=false without consulting
  // the LLM. False-positive flag, blocked export until manual
  // dismissal.
  //
  // New shape: deny-list match → run LLM fallback WITH the
  // matched pattern as context. The LLM weighs the trope
  // against the rest of the claim and decides. The result
  // always carries matched_pattern when a deny-list hit
  // occurred (so the orchestrator can surface both signals
  // in the Application Editor flag detail).
  const denyHit = matchDenyList(claim.text, denyList);
  return runLlmFallback(claim, ctx, deps, denyHit);
}

/**
 * Case-insensitive substring scan. Returns the first matching
 * entry or null. The order of `denyList` entries is the
 * deny-list's curated priority — earlier-listed patterns win on
 * ties. SPECIFICITY_DENY_LIST is ordered roughly by frequency
 * of occurrence in PM resume tropes.
 *
 * Both sides are lowercased to ensure case-insensitive
 * comparison. The production deny-list is curated to be all-
 * lowercase (pinned by `denyList.test.ts`), but a deps-injected
 * deny-list (used by tests + future custom callers) might
 * contain mixed-case patterns. CodeRabbit Minor on PR #113
 * caught the prior version that only lowercased the claim text.
 */
function matchDenyList(
  claimText: string,
  denyList: readonly DenyListEntry[],
): DenyListEntry | null {
  const lower = claimText.toLowerCase();
  for (const entry of denyList) {
    if (lower.includes(entry.pattern.toLowerCase())) return entry;
  }
  return null;
}

async function runLlmFallback(
  claim: Claim,
  ctx: SpecificityContext,
  deps: SpecificityDeps,
  denyHit: DenyListEntry | null,
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
    // Append the deny-list match as context when one occurred.
    // The prompt's hard rule 5 ("don't be overly strict") and
    // rules 3-4 (numbers/names usually specific; bare action
    // verbs not) give the model the framework to decide. The
    // hint flags the trope; the LLM weighs the rest.
    const denyListContext = denyHit
      ? `\n\nNote: this claim contains the phrase ${JSON.stringify(denyHit.pattern)}, which is on a curated list of vague PM tropes (${denyHit.reason}). Consider whether the rest of the claim contains specific anchors (numbers, named products, surfaces) that override the vagueness, or whether the trope is the substance of the claim.`
      : "";
    const userContent = `${prompt.userFewShot}\n\nClaim: ${JSON.stringify(claim.text)}${denyListContext}`;

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
      logger.warn("validation.specificity: recordUsage failed (non-fatal)", {
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

    return finalizeResult(parsed.data, denyHit);
  }

  throw new SpecificityCheckError(
    `Specificity check failed after ${MAX_ATTEMPTS} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

function finalizeResult(
  raw: SpecificityResponseV1,
  denyHit: DenyListEntry | null,
): SpecificityResult {
  // matched_pattern surfaces when a deny-list hit occurred,
  // regardless of the LLM's verdict. The orchestrator (#109)
  // uses this to render both signals in the Application Editor
  // flag detail: "trope detected, LLM decided X."
  return {
    specific: raw.specific,
    rationale: raw.rationale,
    ...(denyHit !== null && { matched_pattern: denyHit.pattern }),
  };
}
