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
 *
 * Two prompt versions (#655). v1 is the default and is sent exactly as
 * before. v2 (`fitBrief.v2.md`) keeps v1's inputs and adds, after the
 * claim rules as written, one numbered check per rule quoting the rule
 * verbatim (`claimRuleChecks`, `renderClaimRuleChecks`); its response
 * cites a span for every point and records a self-audit (`rule_audit`,
 * `dropped_points`), which `auditProblem` checks against the number of
 * checks sent. The caller picks the version with `deps.promptVersion`.
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
import { loadPromptTextVersion, resolvePromptVersion } from "../prompts/loader.js";
import {
  FitBriefResponseV1Schema,
  type FitBriefResponseV1,
} from "../prompts/generation/fitBrief.v1.schema.js";
import {
  FitBriefResponseV2Schema,
  type FitBriefResponseV2,
} from "../prompts/generation/fitBrief.v2.schema.js";

/** The fit-brief prompt versions the generator can send. v1 is the default. */
export const FIT_BRIEF_PROMPT_VERSIONS = ["v1", "v2"] as const;
export type FitBriefPromptVersion = (typeof FIT_BRIEF_PROMPT_VERSIONS)[number];

export function isFitBriefPromptVersion(value: string): value is FitBriefPromptVersion {
  return (FIT_BRIEF_PROMPT_VERSIONS as readonly string[]).includes(value);
}

/** The label usage records and eval reports carry, e.g. `generation/fitBrief.v2`. */
export function fitBriefPromptLabel(version: FitBriefPromptVersion): string {
  return `generation/fitBrief.${version}`;
}

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
  /**
   * The prompt version to send. Omitted: the loader's resolved version
   * (a runtime override, else `PROMPT_CONFIG`, which says v1).
   */
  readonly promptVersion?: FitBriefPromptVersion;
}

export interface FitBriefAttemptFailure {
  readonly attempt: number;
  readonly kind:
    | "transport_error"
    | "refusal"
    | "max_tokens_exceeded"
    | "no_tool_use"
    | "schema_error"
    /** v2 only: `rule_audit` or a dropped point's `check` does not match the checks sent. */
    | "incomplete_audit";
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

interface FitBriefUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

/** The brief, tagged with the prompt version that produced it. */
export type FitBriefResult =
  | (FitBriefUsage & { readonly promptVersion: "v1"; readonly brief: FitBriefResponseV1 })
  | (FitBriefUsage & { readonly promptVersion: "v2"; readonly brief: FitBriefResponseV2 });

const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 8192;
const TOOL_DESCRIPTION = "Record the fit brief for this role.";
const TOOL_NAME = "record_fit_brief";

const SCHEMA_REMINDER =
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema: every strength needs at least one verbatim evidence line, strengths may be empty only with verdict skip, and verdict must be one of apply, hold, referral_needed, skip.";
const NO_TOOL_REMINDER =
  "\n\nYour previous response did not call the tool. Respond only by calling the tool with the complete brief.";

const SCHEMA_REMINDER_V2 =
  "\n\nYour previous response failed schema validation. Return data that exactly matches the tool schema: every strength needs at least one verbatim evidence span, every exposure has an evidence array (empty only when the sources are silent on the clause), strengths may be empty only with verdict skip, verdict must be one of apply, hold, referral_needed, skip, every rule_audit outcome is obeyed or not_applicable, and a dropped point carries a check number exactly when its reason is claim_rule.";
const AUDIT_REMINDER_V2 =
  "\n\nYour previous response's self-audit did not match the claim-rule checks. rule_audit must list every check exactly once, in order, and a dropped point may name only a check that exists.";

/** What differs between prompt versions on the request side. */
interface VersionSpec {
  readonly schema: typeof FitBriefResponseV1Schema | typeof FitBriefResponseV2Schema;
  readonly schemaReminder: string;
  readonly userContent: (fewShot: string, input: FitBriefInput) => string;
}

const VERSION_SPECS: Readonly<Record<FitBriefPromptVersion, VersionSpec>> = {
  v1: { schema: FitBriefResponseV1Schema, schemaReminder: SCHEMA_REMINDER, userContent: buildUserContent },
  v2: { schema: FitBriefResponseV2Schema, schemaReminder: SCHEMA_REMINDER_V2, userContent: buildUserContentV2 },
};

function resolveVersion(requested: string | undefined): FitBriefPromptVersion {
  const version = requested ?? resolvePromptVersion("generation", "fitBrief");
  if (!isFitBriefPromptVersion(version)) {
    throw new Error(
      `Unknown fit-brief prompt version ${version}; expected one of ${FIT_BRIEF_PROMPT_VERSIONS.join(", ")}.`,
    );
  }
  return version;
}

export async function generateFitBrief(
  input: FitBriefInput,
  deps: FitBriefDeps,
): Promise<FitBriefResult> {
  const client = deps.client ?? anthropic();
  const record = deps.record ?? recordUsage;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms));
  const version = resolveVersion(deps.promptVersion);
  const spec = VERSION_SPECS[version];
  // v2: split the rules before any request, so rules text with no rule
  // line fails here rather than after spend.
  const checkCount = version === "v2" ? claimRuleChecks(input.claimRulesText).length : 0;
  const prompt = loadPromptTextVersion("generation", "fitBrief", version);
  const toolSchema = zodToToolSchema(spec.schema);
  const request = toolCallRequest({
    model: deps.model,
    toolName: TOOL_NAME,
    baseMaxTokens: MAX_OUTPUT_TOKENS,
    effort: deps.effort,
  });
  const userContent = spec.userContent(prompt.userFewShot, input);

  const failures: FitBriefAttemptFailure[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const operationStart = Date.now();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previous = failures.at(-1);
    const reminder =
      previous?.kind === "schema_error"
        ? `${spec.schemaReminder}\n\nValidation errors:\n${previous.message.slice(0, 2000)}`
        : previous?.kind === "no_tool_use"
          ? NO_TOOL_REMINDER
          : previous?.kind === "incomplete_audit"
            ? `${AUDIT_REMINDER_V2}\n\n${previous.message}`
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
              description: TOOL_DESCRIPTION,
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

    const usage = () => ({ inputTokens, outputTokens, latencyMs: Date.now() - operationStart });
    if (version === "v1") {
      const parsed = FitBriefResponseV1Schema.safeParse(toolUse.input);
      if (!parsed.success) {
        failures.push({ attempt, kind: "schema_error", message: parsed.error.message });
        continue;
      }
      return { promptVersion: "v1", brief: parsed.data, ...usage() };
    }
    const parsed = FitBriefResponseV2Schema.safeParse(toolUse.input);
    if (!parsed.success) {
      failures.push({ attempt, kind: "schema_error", message: parsed.error.message });
      continue;
    }
    const problem = auditProblem(parsed.data, checkCount);
    if (problem !== undefined) {
      failures.push({ attempt, kind: "incomplete_audit", message: problem });
      continue;
    }
    return { promptVersion: "v2", brief: parsed.data, ...usage() };
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
 * Identifies everything the generator sends for `model` and `effort`
 * apart from the inputs: system prompt, few-shot, tool name and
 * description, the resolved request shape, tool schema, retry reminders
 * and the user-message template (built for a fixed canary input). The
 * prompt version label alone misses code-side template changes, so evals
 * record this too (Codex P2, #581).
 */
export function fitBriefRequestFingerprint(
  model: string,
  effort?: Effort,
  promptVersion: FitBriefPromptVersion = "v1",
): string {
  if (promptVersion === "v2") return fitBriefRequestFingerprintV2(model, effort);
  const prompt = loadPromptTextVersion("generation", "fitBrief", "v1");
  // The request shape as resolved for this model and effort (output
  // budget, tool choice, system suffix, output config), so a model-profile
  // correction changes the fingerprint too (Codex P2, #581).
  const request = toolCallRequest({ model, toolName: TOOL_NAME, baseMaxTokens: MAX_OUTPUT_TOKENS, effort });
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
        TOOL_DESCRIPTION,
        request,
        zodToToolSchema(FitBriefResponseV1Schema),
        SCHEMA_REMINDER,
        NO_TOOL_REMINDER,
        buildUserContent(prompt.userFewShot, canary),
        // Optional inputs absent, so a change to how an omitted section is
        // rendered changes the fingerprint too (Codex P2, #581).
        buildUserContent(prompt.userFewShot, { jdText: canary.jdText, resumeText: canary.resumeText }),
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

/**
 * v2's fingerprint. It starts with the version label, so a v2 request can
 * never share a fingerprint with v1 even if their text converged, and it
 * renders several claim-rule layouts so a change to the splitter or the
 * check renderer changes it too.
 */
function fitBriefRequestFingerprintV2(model: string, effort?: Effort): string {
  const prompt = loadPromptTextVersion("generation", "fitBrief", "v2");
  const request = toolCallRequest({ model, toolName: TOOL_NAME, baseMaxTokens: MAX_OUTPUT_TOKENS, effort });
  const base: FitBriefInput = { jdText: "<jd>", resumeText: "<resume>", inventoryText: "<inventory>" };
  const structuredRules = [
    "# <section>",
    "",
    "<preamble>",
    "",
    "<lead-in>:",
    "",
    "- <rule a>",
    "* <rule b>",
    "  <rule b continued>",
    "  - <rule b detail>",
    "1. <rule c>",
    "",
    "---",
    "",
    "<paragraph rule>",
    "<paragraph rule continued>",
    "---",
    "- <rule d>",
    "  # <rule d continued>",
    "",
    "<underlined title>",
    "===",
    "",
    "<rule e>",
    "",
    "<underlined title with no rule>",
    "===",
  ].join("\n");
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        fitBriefPromptLabel("v2"),
        prompt.system,
        TOOL_NAME,
        TOOL_DESCRIPTION,
        request,
        zodToToolSchema(FitBriefResponseV2Schema),
        SCHEMA_REMINDER_V2,
        NO_TOOL_REMINDER,
        AUDIT_REMINDER_V2,
        auditProblem({ rule_audit: [], dropped_points: [] }, 2),
        buildUserContentV2(prompt.userFewShot, { ...base, claimRulesText: structuredRules }),
        buildUserContentV2(prompt.userFewShot, { ...base, claimRulesText: "<rules>" }),
        buildUserContentV2(prompt.userFewShot, base),
        buildUserContentV2(prompt.userFewShot, { jdText: base.jdText, resumeText: base.resumeText }),
      ]),
    )
    .digest("hex");
  return `sha256:${hash.slice(0, 12)}`;
}

/** v2's user message: v1's sections unchanged, then the numbered checks, then the closing step. */
function buildUserContentV2(fewShot: string, input: FitBriefInput): string {
  const parts = [buildUserContent(fewShot, input)];
  const checks = claimRuleChecks(input.claimRulesText);
  if (checks.length > 0) parts.push(renderClaimRuleChecks(checks));
  parts.push(V2_CLOSING);
  return parts.join("\n\n---\n\n");
}

const V2_CLOSING = "Run the self-audit, then call the tool.";

/** One claim rule as a numbered check. `text` is the rule as written. */
export interface ClaimRuleCheck {
  /** 1-based, in the order the rules are written. */
  readonly number: number;
  /** The rule text, verbatim apart from a bullet glyph and line indentation. */
  readonly text: string;
  /** The heading and lead-in the rule sits under, verbatim, joined by " › ". */
  readonly context?: string;
}

const RULE_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const RULE_SETEXT_UNDERLINE = /^ {0,3}=+[ \t]*$/u;
const RULE_DASH_LINE = /^ {0,3}-+[ \t]*$/u;
const RULE_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const RULE_LIST_ITEM = /^([ \t]*)(?:([-*+•])|(\d+[.)]))[ \t]+(\S.*)$/u;

/**
 * Split claim-rules text into one check per rule, in order, without
 * rewording anything. The text's layout is the owner's, so the split is
 * line-based, and where the layout is ambiguous it errs toward more
 * checks, never fewer: an extra check costs a `not_applicable` audit
 * entry, a lost one costs a rule.
 *
 * - a list item (`-`, `*`, `+`, `•`, or `1.` / `1)`) is one rule; a
 *   bullet glyph is dropped, a number is kept. Indented lines (an
 *   indented `#` line included), nested list items and unindented lines
 *   that follow it without a blank line belong to it (Markdown's own
 *   reading of a list item);
 * - a paragraph is one rule however many lines it spans, as in Markdown,
 *   so rules written one per line with no bullet and no blank line
 *   between them are ONE check (the owner confirms the count in the
 *   dry-run plan). A paragraph ending in ":" that introduces a list
 *   becomes the context of that list's rules instead;
 * - a `#` heading is never a rule; it becomes the context of the rules
 *   under it. A paragraph underlined with `===` is a heading too, unless
 *   no rule follows it before the next heading or the end, in which case
 *   it is kept as a rule. A paragraph followed by a `-`/`---` line is a
 *   rule and the line a separator (never Markdown's `---` heading
 *   underline, which would silently hide a rule above a separator);
 * - a horizontal rule ends a lead-in's reach; blank lines only separate.
 *
 * Absent or blank text has no checks (as in v1, which then sends no
 * rules section). Text that is not blank but holds no rule, only
 * headings or separators, throws: sending the raw rules with zero checks
 * would silently make v2 a different experiment.
 */
export function claimRuleChecks(text: string | undefined): ClaimRuleCheck[] {
  if (text === undefined || text.trim() === "") return [];
  const checks: ClaimRuleCheck[] = [];
  let section: string | undefined;
  let leadIn: string | undefined;
  // The block being read: a list item (with its indentation) or a paragraph.
  let block: { kind: "item" | "paragraph"; indent: number; lines: string[] } | undefined;
  // A paragraph ending in ":", held until the next block shows whether it introduces a list.
  let pendingLeadIn: string | undefined;
  // An `===`-underlined heading no rule has followed yet: kept as a rule if none does.
  let pendingSetext: string | undefined;

  const contextOf = (): string | undefined => {
    const parts = [section, leadIn].filter((p): p is string => p !== undefined && p !== "");
    return parts.length > 0 ? parts.join(" › ") : undefined;
  };
  const emit = (ruleText: string): void => {
    pendingSetext = undefined;
    const context = contextOf();
    checks.push({ number: checks.length + 1, text: ruleText, ...(context !== undefined && { context }) });
  };
  const releasePendingAsRule = (): void => {
    if (pendingLeadIn === undefined) return;
    leadIn = undefined;
    emit(pendingLeadIn);
    pendingLeadIn = undefined;
  };
  // Before a new heading or the end: an `===` heading with no rule under it is a rule after all.
  const releasePendingSetext = (): void => {
    if (pendingSetext === undefined) return;
    const ruleText = pendingSetext;
    section = undefined;
    leadIn = undefined;
    emit(ruleText);
  };
  const flush = (): void => {
    if (block === undefined) return;
    const joined = block.lines.join("\n");
    if (block.kind === "item") {
      emit(joined);
    } else if (joined.endsWith(":")) {
      pendingLeadIn = joined;
    } else {
      leadIn = undefined;
      emit(joined);
    }
    block = undefined;
  };

  for (const raw of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.replace(/[ \t]+$/u, "");
    if (line.trim() === "") {
      flush();
      continue;
    }
    const lineIndent = /^[ \t]*/u.exec(line)![0].replace(/\t/gu, "    ").length;
    if (block?.kind === "item" && lineIndent > 0 && RULE_HEADING.test(line)) {
      // An indented "# ..." line inside a list item is its text, not a heading.
      block.lines.push(line.trim());
      continue;
    }
    const heading = RULE_HEADING.exec(line);
    if (heading) {
      flush();
      releasePendingAsRule();
      releasePendingSetext();
      section = heading[1] || undefined;
      leadIn = undefined;
      continue;
    }
    if (block?.kind === "paragraph" && RULE_SETEXT_UNDERLINE.test(line)) {
      // "Title" over "===" is a heading, unless no rule ever follows it.
      releasePendingAsRule();
      releasePendingSetext();
      section = block.lines.join(" ");
      pendingSetext = block.lines.join("\n");
      leadIn = undefined;
      block = undefined;
      continue;
    }
    if (RULE_BREAK.test(line) || (block?.kind === "paragraph" && RULE_DASH_LINE.test(line))) {
      // A paragraph over "---" (or "-", "--") is a rule above a separator.
      flush();
      releasePendingAsRule();
      leadIn = undefined;
      continue;
    }
    const item = RULE_LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1]!.replace(/\t/gu, "    ").length;
      if (block?.kind === "item" && indent > block.indent) {
        // A nested item elaborates its parent rule; keep it, marker and all.
        block.lines.push(line.trim());
        continue;
      }
      flush();
      if (pendingLeadIn !== undefined) {
        leadIn = pendingLeadIn;
        pendingLeadIn = undefined;
      }
      const label = item[3];
      block = { kind: "item", indent, lines: [label !== undefined ? `${label} ${item[4]!}` : item[4]!] };
      continue;
    }
    if (block !== undefined) {
      // A continuation line, indented or lazy, belongs to the open block.
      block.lines.push(line.trim());
      continue;
    }
    releasePendingAsRule();
    block = { kind: "paragraph", indent: 0, lines: [line.trim()] };
  }
  flush();
  releasePendingAsRule();
  releasePendingSetext();

  if (checks.length === 0) {
    throw new Error("The claim rules text has no rule lines (only headings or separators); refusing to send no checks.");
  }
  return checks;
}

/**
 * The numbered checks block of a v2 request. Each check quotes its rule
 * exactly; nothing is summarized or reworded. Empty for no checks.
 */
export function renderClaimRuleChecks(checks: readonly ClaimRuleCheck[]): string {
  if (checks.length === 0) return "";
  const n = checks.length;
  const header =
    `Claim-rule checks: the ${n} ${n === 1 ? "rule" : "rules"} above as numbered checks, one per rule, ` +
    "in the order written, each quoted exactly. Apply every check to every point and every prose field " +
    "before you write it, then record each check in rule_audit.";
  const body = checks.map((c) =>
    [`Check ${c.number} of ${n}`, ...(c.context !== undefined ? [`Context: ${c.context}`] : []), `Rule: ${c.text}`].join("\n"),
  );
  return [header, ...body].join("\n\n");
}

/**
 * What the schema cannot check, because it depends on the checks sent:
 * `rule_audit` names checks 1..N once each, in order, and a dropped point
 * names only a check that exists. Undefined when the audit is complete.
 */
export function auditProblem(
  brief: Pick<FitBriefResponseV2, "rule_audit" | "dropped_points">,
  checkCount: number,
): string | undefined {
  const expected = Array.from({ length: checkCount }, (_, i) => i + 1);
  const got = brief.rule_audit.map((a) => a.check);
  if (got.length !== expected.length || got.some((c, i) => c !== expected[i])) {
    return (
      `rule_audit must list checks ${checkCount === 0 ? "(none: no claim rules were sent)" : `1 to ${checkCount}`} ` +
      `in order, each once; got [${got.join(", ")}].`
    );
  }
  const unknown = brief.dropped_points
    .map((d) => d.check)
    .filter((c): c is number => c !== undefined && c > checkCount);
  if (unknown.length > 0) {
    return `dropped_points name check(s) ${unknown.join(", ")}, but only ${checkCount} check(s) were sent.`;
  }
  return undefined;
}
