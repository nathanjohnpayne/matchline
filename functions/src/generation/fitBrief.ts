/**
 * Fit-brief generation (#495 Phase 3).
 *
 * Given a job description and the candidate's canonical résumé (plus an
 * optional skills inventory and claim rules), produce the decision
 * document for that role: bottom line, strengths tied to JD clauses with
 * verbatim evidence, exposures, positioning, preparation, questions, and
 * what the package does not claim.
 *
 * Eval-only for now. The model is passed in explicitly rather than read
 * from `config.ts`, so this adds no production default; a product
 * surface adopts it only through its own approved change.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

import { anthropic } from "../llm/anthropic.js";
import {
  anthropicUsageFields,
  promptVersionLabel,
  recordUsage,
  safeRecordUsage,
} from "../llm/cost.js";
import { toolCallRequest, type Effort } from "../llm/modelProfile.js";
import { isRetryableApiError, sleep as defaultSleep, transportBackoffMs } from "../llm/retry.js";
import { zodToToolSchema } from "../llm/zodToolSchema.js";
import { loadPromptText } from "../prompts/loader.js";
import {
  FitBriefResponseV1Schema,
  type FitBriefResponseV1,
} from "../prompts/generation/fitBrief.v1.schema.js";

export interface FitBriefInput {
  readonly jdText: string;
  readonly resumeText: string;
  /** Optional skills/tools inventory, quoted as evidence alongside the résumé. */
  readonly inventoryText?: string;
  /** Optional claim rules the brief must obey. */
  readonly claimRulesText?: string;
}

export interface FitBriefDeps {
  /** Anthropic model id; must be registered in rates.ts and modelProfile.ts. */
  readonly model: string;
  readonly effort?: Effort;
  readonly client?: Anthropic;
  readonly record?: typeof recordUsage;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Copied onto usage records, e.g. an eval run id. */
  readonly runId?: string;
}

export interface FitBriefAttemptFailure {
  readonly attempt: number;
  readonly kind:
    | "transport_error"
    | "refusal"
    | "max_tokens_exceeded"
    | "no_tool_use"
    | "schema_error";
  readonly message: string;
}

export class FitBriefError extends Error {
  constructor(
    message: string,
    readonly failures: readonly FitBriefAttemptFailure[],
  ) {
    super(message);
    this.name = "FitBriefError";
  }
}

export interface FitBriefResult {
  readonly brief: FitBriefResponseV1;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 8192;
const TOOL_NAME = "record_fit_brief";

const SCHEMA_REMINDER =
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema: every strength needs at least one verbatim evidence line, strengths may be empty only with verdict skip, and verdict must be one of apply, hold, referral_needed, skip.";
const NO_TOOL_REMINDER =
  "\n\nYour previous response did not call the tool. Respond only by calling the tool with the complete brief.";

export async function generateFitBrief(
  input: FitBriefInput,
  deps: FitBriefDeps,
): Promise<FitBriefResult> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms));
  const prompt = loadPromptText("generation", "fitBrief");
  const toolSchema = zodToToolSchema(FitBriefResponseV1Schema);
  const request = toolCallRequest({
    model: deps.model,
    toolName: TOOL_NAME,
    baseMaxTokens: MAX_OUTPUT_TOKENS,
    effort: deps.effort,
  });
  const userContent = buildUserContent(prompt.userFewShot, input);

  const failures: FitBriefAttemptFailure[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const operationStart = Date.now();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previous = failures.at(-1);
    const reminder =
      previous?.kind === "schema_error"
        ? `${SCHEMA_REMINDER}\n\nValidation errors:\n${previous.message.slice(0, 2000)}`
        : previous?.kind === "no_tool_use"
          ? NO_TOOL_REMINDER
          : "";
    const start = Date.now();

    let response: Anthropic.Messages.Message;
    try {
      response = await client.messages.create(
        {
          model: deps.model,
          max_tokens: request.max_tokens,
          system: prompt.system + request.systemSuffix + reminder,
          tools: [
            {
              name: TOOL_NAME,
              description: "Record the fit brief for this role.",
              input_schema: toolSchema as Anthropic.Messages.Tool["input_schema"],
            },
          ],
          tool_choice: request.tool_choice,
          ...(request.output_config !== undefined && { output_config: request.output_config }),
          messages: [{ role: "user", content: userContent }],
          stream: false,
        },
        request.requestOptions,
      );
    } catch (err) {
      failures.push({
        attempt,
        kind: "transport_error",
        message: err instanceof Error ? err.message : String(err),
      });
      // A 4xx other than 408/409/429 fails the same way on retry.
      if (!isRetryableApiError(err)) break;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(transportBackoffMs(attempt, err));
      continue;
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    await safeRecordUsage(
      record,
      () => ({
        stage: "fit_brief",
        provider: "anthropic",
        model: deps.model,
        ...anthropicUsageFields(response),
        promptVersion: promptVersionLabel(prompt),
        attempt,
        maxTokens: request.max_tokens,
        ...(request.effort !== undefined && { effort: request.effort }),
        ...(deps.runId !== undefined && { runId: deps.runId }),
        latencyMs: Date.now() - start,
      }),
      "generation.fitBrief",
    );

    if (response.stop_reason === "refusal") {
      failures.push({
        attempt,
        kind: "refusal",
        message: `Anthropic declined the request (stop_reason: "refusal"${
          response.stop_details?.category ? `, category: ${response.stop_details.category}` : ""
        }).`,
      });
      break;
    }
    if (response.stop_reason === "max_tokens") {
      failures.push({
        attempt,
        kind: "max_tokens_exceeded",
        message: `The model hit the ${request.max_tokens}-token output budget mid-tool-call.`,
      });
      // A retry with the same budget truncates the same way; stop rather
      // than pay for it.
      break;
    }

    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (!toolUse) {
      failures.push({
        attempt,
        kind: "no_tool_use",
        message: "The response did not call the tool.",
      });
      continue;
    }

    const parsed = FitBriefResponseV1Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({ attempt, kind: "schema_error", message: parsed.error.message });
      continue;
    }

    return {
      brief: parsed.data,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - operationStart,
    };
  }

  const last = failures.at(-1)?.kind;
  throw new FitBriefError(
    last === "refusal"
      ? `Fit brief was declined by the model (stop_reason: "refusal"). See .failures for detail.`
      : last === "max_tokens_exceeded"
        ? `Fit brief was truncated at the output budget. See .failures for detail.`
        : `Fit brief failed after ${failures.length} attempts. See .failures for per-attempt detail.`,
    failures,
  );
}

/**
 * Identifies everything the generator sends apart from the model and the
 * inputs: system prompt, few-shot, tool name, tool schema, retry reminders
 * and the user-message template (built for a fixed canary input). The
 * prompt version label alone misses code-side template changes, so evals
 * record this too (Codex P2, #581).
 */
export function fitBriefRequestFingerprint(): string {
  const prompt = loadPromptText("generation", "fitBrief");
  const canary: FitBriefInput = {
    jdText: "<jd>",
    resumeText: "<resume>",
    inventoryText: "<inventory>",
    claimRulesText: "<rules>",
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        prompt.system,
        TOOL_NAME,
        zodToToolSchema(FitBriefResponseV1Schema),
        SCHEMA_REMINDER,
        NO_TOOL_REMINDER,
        buildUserContent(prompt.userFewShot, canary),
      ]),
    )
    .digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

function buildUserContent(fewShot: string, input: FitBriefInput): string {
  const parts = [
    fewShot,
    "Now write the brief for this role.",
    `Job description:\n\n${input.jdText}`,
    `Résumé:\n\n${input.resumeText}`,
  ];
  if (input.inventoryText) parts.push(`Skills and tools inventory:\n\n${input.inventoryText}`);
  if (input.claimRulesText) parts.push(`Claim rules (obey every one):\n\n${input.claimRulesText}`);
  return parts.join("\n\n---\n\n");
}
