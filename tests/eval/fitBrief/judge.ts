/**
 * Model judge for the fit-brief eval (#495 Phase 3).
 *
 * One call per generated brief. The judge reads the owner's reference
 * brief, the generated brief, the job description, the candidate's
 * sources and the claim rules, and returns:
 *
 * - the strengths and exposures the reference identifies, each marked
 *   covered / partial / missing in the generated brief (→ recall);
 * - the generated brief's points, each marked as matching a reference
 *   point or not (→ precision);
 * - statements about the candidate the sources don't support;
 * - claim-rule violations;
 * - the reference's verdict.
 *
 * Everything this returns is model-graded and reported as such.
 * Eval-only: the prompt lives here, not in functions/src/prompts.
 */

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";
import { z } from "zod";

import { anthropicUsageFields, recordUsage, safeRecordUsage } from "../../../functions/src/llm/cost.ts";
import { toolCallRequest, type Effort } from "../../../functions/src/llm/modelProfile.ts";
import {
  isRetryableApiError,
  sleep as defaultSleep,
  transportBackoffMs,
} from "../../../functions/src/llm/retry.ts";
import {
  FIT_BRIEF_VERDICTS,
  type FitBriefResponseV1,
} from "../../../functions/src/prompts/generation/fitBrief.v1.schema.ts";

const nonEmpty = z.string().trim().min(1);

export const JudgeResultSchema = z
  .object({
    reference_points: z.array(
      z
        .object({
          kind: z.enum(["strength", "exposure"]),
          jd_clause: nonEmpty,
          point: nonEmpty,
          coverage: z.enum(["covered", "partial", "missing"]),
        })
        .strict(),
    ),
    generated_points: z.array(
      z
        .object({
          kind: z.enum(["strength", "exposure"]),
          point: nonEmpty,
          matches_reference: z.boolean(),
        })
        .strict(),
    ),
    unsupported_candidate_claims: z.array(
      z.object({ quote: nonEmpty, reason: nonEmpty }).strict(),
    ),
    claim_rule_violations: z.array(z.object({ rule: nonEmpty, quote: nonEmpty }).strict()),
    reference_verdict: z.enum([...FIT_BRIEF_VERDICTS, "unclear"]),
  })
  .strict();

export type JudgeResult = z.infer<typeof JudgeResultSchema>;

const TOOL_NAME = "record_judgement";
const MAX_OUTPUT_TOKENS = 8192;
const MAX_ATTEMPTS = 3;

export const JUDGE_SYSTEM = `You grade a generated fit brief against a reference fit brief the candidate wrote and approved. A fit brief tells a candidate whether and how to pursue one role: strengths tied to job-description clauses, exposures, positioning, and what not to claim.

Return your judgement via the \`${TOOL_NAME}\` tool.

1. reference_points: list every distinct strength and exposure the REFERENCE brief identifies, each tied to the job-description clause it concerns. For each, mark coverage in the GENERATED brief: "covered" if it makes the same point, "partial" if it touches the point but misses what matters, "missing" otherwise. Judge substance, not wording or order.
2. generated_points: list every distinct strength and exposure in the GENERATED brief and mark whether it matches any reference point.
3. unsupported_candidate_claims: quote every statement in the GENERATED brief about the candidate's own background (employers, roles, projects, metrics, dates, skills, scope) that the candidate sources do not support. Statements about the role or the company, advice, and reasonable conclusions drawn from the sources are not candidate claims. Return an empty list when there are none.
4. claim_rule_violations: quote every place the GENERATED brief breaks a claim rule, naming the rule. Empty when none, or when there are no rules.
5. reference_verdict: the reference brief's recommendation as one of apply, hold, referral_needed, skip; "unclear" if it states none.

Be strict and literal. Do not reward length.`;

function renderGenerated(brief: FitBriefResponseV1): string {
  const list = (xs: readonly string[]) => xs.map((x) => `- ${x}`).join("\n") || "(none)";
  return [
    `Bottom line: ${brief.bottom_line}`,
    "Strengths:",
    ...brief.strengths.map(
      (s) => `- [${s.jd_clause}] ${s.argument}\n  Evidence: ${s.evidence.map((e) => `"${e}"`).join("; ")}`,
    ),
    "Exposures:",
    ...brief.exposures.map((e) => `- [${e.jd_clause}] ${e.gap} Handling: ${e.handling}`),
    `Positioning: ${brief.positioning}`,
    ...(brief.level_strategy ? [`Level strategy: ${brief.level_strategy}`] : []),
    `Homework:\n${list(brief.homework)}`,
    `Questions to ask:\n${list(brief.questions_to_ask)}`,
    `Does not claim:\n${list(brief.does_not_claim)}`,
    `Verdict: ${brief.verdict}`,
  ].join("\n");
}

export interface JudgeInput {
  readonly jdText: string;
  readonly referenceText: string;
  readonly generated: FitBriefResponseV1;
  /** Résumé, plus inventory when present. */
  readonly sourcesText: string;
  readonly claimRulesText?: string;
}

export interface JudgeDeps {
  readonly client: Anthropic;
  readonly model: string;
  readonly effort?: Effort;
  readonly record?: typeof recordUsage;
  readonly runId?: string;
  /** Backoff between transient-failure retries; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function judgeBrief(input: JudgeInput, deps: JudgeDeps): Promise<JudgeResult> {
  const record = deps.record ?? recordUsage;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms));
  const request = toolCallRequest({
    model: deps.model,
    toolName: TOOL_NAME,
    baseMaxTokens: MAX_OUTPUT_TOKENS,
    effort: deps.effort,
  });
  const content = [
    `Job description:\n\n${input.jdText}`,
    `REFERENCE brief (written and approved by the candidate):\n\n${input.referenceText}`,
    `GENERATED brief:\n\n${renderGenerated(input.generated)}`,
    `Candidate sources:\n\n${input.sourcesText}`,
    `Claim rules:\n\n${input.claimRulesText ?? "(none)"}`,
  ].join("\n\n---\n\n");

  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const start = Date.now();
    let response: Awaited<ReturnType<typeof deps.client.messages.create>>;
    try {
      response = await deps.client.messages.create(
      {
        model: deps.model,
        max_tokens: request.max_tokens,
        system: JUDGE_SYSTEM + request.systemSuffix,
        tools: [
          {
            name: TOOL_NAME,
            description: "Record the judgement of the generated fit brief.",
            // Root and functions/ resolve separate zod installs, so convert with
            // this file's own zod rather than functions' zodToToolSchema.
            input_schema: z.toJSONSchema(JudgeResultSchema, { target: "draft-7" }) as Anthropic.Messages.Tool["input_schema"],
          },
        ],
        tool_choice: request.tool_choice,
        ...(request.output_config !== undefined && { output_config: request.output_config }),
        messages: [{ role: "user", content }],
        stream: false,
      },
      request.requestOptions,
    );
    } catch (err) {
      // A transient failure (connection, 408/409/429, 5xx) retries with
      // backoff instead of discarding the already-paid generation; a budget
      // stop, a spend-limit 429 or another 4xx stays terminal (Codex P2, #581).
      if (!isRetryableApiError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(transportBackoffMs(attempt, err));
      continue;
    }
    await safeRecordUsage(
      record,
      () => ({
        stage: "fit_brief_judge",
        provider: "anthropic",
        model: deps.model,
        ...anthropicUsageFields(response),
        attempt,
        maxTokens: request.max_tokens,
        ...(request.effort !== undefined && { effort: request.effort }),
        ...(deps.runId !== undefined && { runId: deps.runId }),
        latencyMs: Date.now() - start,
      }),
      "eval.fitBrief.judge",
    );
    if (response.stop_reason === "refusal") {
      throw new Error('The judge declined the request (stop_reason: "refusal").');
    }
    // A retry at the same budget truncates the same way, and the caller
    // cannot recheck --max-usd between these attempts (Codex P1, #581).
    if (response.stop_reason === "max_tokens") {
      throw new Error(`The judge was truncated at its ${request.max_tokens}-token output budget.`);
    }
    const toolUse = response.content.find(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );
    const parsed = toolUse ? JudgeResultSchema.safeParse(toolUse.input) : undefined;
    if (parsed?.success) return parsed.data;
    lastError = parsed ? parsed.error.message : "no tool call";
  }
  throw new Error(`Judge failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
