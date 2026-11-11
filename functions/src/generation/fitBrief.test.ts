import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { recordUsage as RecordUsage } from "../llm/cost.ts";
import { LONG_REQUEST_TIMEOUT_MS } from "../llm/modelProfile.ts";

import {
  _clearCacheForTests,
  clearPromptVersionOverrides,
  setPromptVersionOverrides,
} from "../prompts/loader.ts";

import {
  auditProblem,
  claimRuleChecks,
  FitBriefError,
  fitBriefMaxTokens,
  fitBriefPromptLabel,
  fitBriefRequestFingerprint,
  generateFitBrief,
  isFitBriefPromptVersion,
  renderClaimRuleChecks,
  type FitBriefDeps,
  type FitBriefPromptVersion,
} from "./fitBrief.ts";

const BRIEF = {
  bottom_line: "Strong platform fit.",
  strengths: [
    {
      jd_clause: "platform products",
      evidence: ["Owned the checkout API used by four storefront teams."],
      argument: "Internal teams were the customers.",
    },
  ],
  exposures: [],
  positioning: "Lead with the API.",
  homework: [],
  questions_to_ask: [],
  does_not_claim: [],
  verdict: "apply",
};

function message(
  input: unknown,
  overrides: Partial<Anthropic.Messages.Message> = {},
): Anthropic.Messages.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "t", name: "record_fit_brief", input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 500 },
    ...overrides,
  } as Anthropic.Messages.Message;
}

function client(responses: Anthropic.Messages.Message[]): Anthropic {
  const queue = [...responses];
  return {
    messages: {
      create: vi.fn(async () => {
        const next = queue.shift();
        if (!next) throw new Error("no more responses");
        return next;
      }),
    },
  } as unknown as Anthropic;
}

const INPUT = {
  jdText: "Senior PM, Payments Platform.",
  resumeText: "- Owned the checkout API used by four storefront teams.",
  claimRulesText: "Never claim PCI certification.",
};

describe("generateFitBrief", () => {
  it("returns the validated brief and records fit_brief usage", async () => {
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const c = client([message(BRIEF)]);

    const result = await generateFitBrief(INPUT, { model: "claude-sonnet-4-6", client: c, record, runId: "r1", promptVersion: "v1" });

    expect(result.brief.verdict).toBe("apply");
    expect(result.inputTokens).toBe(1000);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "fit_brief",
        model: "claude-sonnet-4-6",
        promptVersion: "generation/fitBrief.v1",
        attempt: 0,
        runId: "r1",
      }),
    );
    const body = vi.mocked(c.messages.create).mock.calls[0]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    const user = String(body.messages[0]!.content);
    expect(user).toContain("Senior PM, Payments Platform.");
    expect(user).toContain("Never claim PCI certification.");
  });

  it("retries once on a schema failure, with a reminder", async () => {
    const c = client([message({ ...BRIEF, verdict: "maybe" }), message(BRIEF)]);
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    });
    expect(result.brief.verdict).toBe("apply");
    const second = vi.mocked(c.messages.create).mock.calls[1]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    expect(String(second.system)).toMatch(/failed schema validation/);
    // The model is told which field failed (CodeRabbit, #581).
    expect(String(second.system)).toMatch(/Validation errors:[\s\S]*verdict/);
  });

  it("asks Sonnet 5.5 for the tool with tool_choice auto and an effort", async () => {
    const c = client([message(BRIEF, { model: "claude-sonnet-5-5" })]);
    await generateFitBrief(INPUT, {
      model: "claude-sonnet-5-5",
      promptVersion: "v1",
      effort: "medium",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    });
    const body = vi.mocked(c.messages.create).mock.calls[0]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("stops on a refusal and says so", async () => {
    const c = client([
      message(BRIEF, { content: [], stop_reason: "refusal" } as Partial<Anthropic.Messages.Message>),
      message(BRIEF),
    ]);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FitBriefError);
    expect((err as FitBriefError).message).toMatch(/declined by the model/);
    expect(vi.mocked(c.messages.create)).toHaveBeenCalledTimes(1);
  });

  it("stops on truncation instead of paying for retries that truncate the same way", async () => {
    const c = client([
      message(BRIEF, { stop_reason: "max_tokens" } as Partial<Anthropic.Messages.Message>),
      message(BRIEF),
    ]);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect((err as FitBriefError).message).toMatch(/truncated/);
    expect(vi.mocked(c.messages.create)).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable API error (CodeRabbit, #581)", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("invalid_request_error"), { status: 400 });
    });
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FitBriefError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 that reports the spend limit (CodeRabbit, #581)", async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error("429"), {
        status: 429,
        error: { type: "error", error: { type: "rate_limit_error", details: { error_code: "enforced_spend_limit_reached" } } },
      });
    });
    await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    }).catch(() => undefined);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit", async () => {
    let calls = 0;
    const create = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate_limit"), { status: 429 });
      return message(BRIEF);
    });
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: { messages: { create } } as unknown as Anthropic,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      sleep: async () => {},
    });
    expect(result.brief.verdict).toBe("apply");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("fails after three attempts without a tool call", async () => {
    const text = message(BRIEF, { content: [{ type: "text", text: "no" }] } as Partial<Anthropic.Messages.Message>);
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      promptVersion: "v1",
      client: client([text, text, text]),
      record: vi.fn<typeof RecordUsage>(async () => 0),
    }).catch((e: unknown) => e);
    expect((err as FitBriefError).failures.map((f) => f.kind)).toEqual([
      "no_tool_use",
      "no_tool_use",
      "no_tool_use",
    ]);
  });
});

describe("fitBriefRequestFingerprint", () => {
  it("is a stable short hash of the request template (Codex P2, #581)", () => {
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).toBe(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium"));
    // The resolved per-model request shape is part of it.
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).not.toBe(fitBriefRequestFingerprint("claude-sonnet-4-6"));
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).not.toBe(fitBriefRequestFingerprint("claude-sonnet-5-5", "high"));
  });
});

// -- v2 (#655) ----------------------------------------------------------------

const BRIEF_V2 = {
  ...BRIEF,
  exposures: [
    {
      jd_clause: "twelve product teams",
      evidence: ["Owned the checkout API used by four storefront teams."],
      gap: "Four teams, not twelve.",
      handling: "Say four plainly.",
    },
  ],
  rule_audit: [{ check: 1, outcome: "obeyed" }],
  dropped_points: [],
};

/** Collapse whitespace, so verbatim checks ignore only line breaks and indentation. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("claimRuleChecks", () => {
  it("makes each bullet one check, glyph dropped, in order", () => {
    const checks = claimRuleChecks("- First rule.\n* Second rule.\n+ Third rule.\n• Fourth rule.");
    expect(checks).toEqual([
      { number: 1, text: "First rule." },
      { number: 2, text: "Second rule." },
      { number: 3, text: "Third rule." },
      { number: 4, text: "Fourth rule." },
    ]);
  });

  it("keeps a numbered item's own number, since it can carry the rule's identity", () => {
    expect(claimRuleChecks("1. Never A.\n2) Never B.").map((c) => c.text)).toEqual(["1. Never A.", "2) Never B."]);
  });

  it("treats headings and a lead-in ending in ':' as context, never as rules", () => {
    const checks = claimRuleChecks("# Titles\n\nNever claim:\n\n- Director.\n- VP.\n\n## Scale\n\n- Say four teams.");
    expect(checks).toEqual([
      { number: 1, text: "Director.", context: "Titles › Never claim:" },
      { number: 2, text: "VP.", context: "Titles › Never claim:" },
      { number: 3, text: "Say four teams.", context: "Scale" },
    ]);
  });

  it("reads an '===' underlined paragraph as a heading when a rule follows it", () => {
    expect(claimRuleChecks("Titles\n======\n\n- Never Director.")).toEqual([
      { number: 1, text: "Never Director.", context: "Titles" },
    ]);
  });

  it("keeps an '===' underlined paragraph as a rule when no rule follows it before the next heading or the end", () => {
    expect(claimRuleChecks("Never claim A.\n===")).toEqual([{ number: 1, text: "Never claim A." }]);
    expect(claimRuleChecks("Never claim A.\nor A-prime.\n===\n\n# Scale\n\n- Say B.")).toEqual([
      { number: 1, text: "Never claim A.\nor A-prime." },
      { number: 2, text: "Say B.", context: "Scale" },
    ]);
    expect(claimRuleChecks("First title\n===\nSecond title\n===\n- Rule.")).toEqual([
      { number: 1, text: "First title" },
      { number: 2, text: "Rule.", context: "Second title" },
    ]);
  });

  it("never reads '---' under a paragraph as a heading underline: the paragraph is a rule, the line a separator (boundary)", () => {
    expect(claimRuleChecks("Rule.\n---\nNext.")).toEqual([
      { number: 1, text: "Rule." },
      { number: 2, text: "Next." },
    ]);
    expect(claimRuleChecks("Rule para one\n---\nRule two")).toEqual([
      { number: 1, text: "Rule para one" },
      { number: 2, text: "Rule two" },
    ]);
    expect(claimRuleChecks("- A.\n\nNever claim B.\n---")).toEqual([
      { number: 1, text: "A." },
      { number: 2, text: "Never claim B." },
    ]);
    expect(claimRuleChecks("Never claim A.\n---\n- B.")).toEqual([
      { number: 1, text: "Never claim A." },
      { number: 2, text: "B." },
    ]);
    expect(claimRuleChecks("Never claim A.\n-\nNever claim B.\n--").map((c) => c.text)).toEqual(["Never claim A.", "Never claim B."]);
    // A lead-in over a separator introduces nothing, so it is a rule too.
    expect(claimRuleChecks("Never claim:\n---\n- B.")).toEqual([
      { number: 1, text: "Never claim:" },
      { number: 2, text: "B." },
    ]);
  });

  it("keeps every rule when '===' lines separate rules: an '===' paragraph is a heading only over a list item (#655 round 2)", () => {
    const abc = [
      { number: 1, text: "Never claim A." },
      { number: 2, text: "Never claim B." },
      { number: 3, text: "Never claim C." },
    ];
    expect(claimRuleChecks("Never claim A.\n===\nNever claim B.\n===\nNever claim C.")).toEqual(abc);
    expect(claimRuleChecks("Never claim A.\n===\n\nNever claim B.\n===\n\nNever claim C.")).toEqual(abc);
    // A rule above a separator keeps the heading it sits under.
    expect(claimRuleChecks("# Rules\n\nNever claim A.\n===\nNever claim B.")).toEqual([
      { number: 1, text: "Never claim A.", context: "Rules" },
      { number: 2, text: "Never claim B.", context: "Rules" },
    ]);
    // Under a list item or on its own line, '===' underlines nothing: a separator, never rule text.
    expect(claimRuleChecks("- Never claim A.\n===\nNever claim B.\n===\nNever claim C.")).toEqual(abc);
    expect(claimRuleChecks("Never claim A.\n\n===\n\nNever claim B.")).toEqual(abc.slice(0, 2));
    // Over a list item (directly, or through a lead-in) it is still a heading.
    expect(claimRuleChecks("Titles\n===\n- Never Director.\n\nScale\n===\n\nNever claim:\n- Twelve teams.")).toEqual([
      { number: 1, text: "Never Director.", context: "Titles" },
      { number: 2, text: "Twelve teams.", context: "Scale › Never claim:" },
    ]);
    // Over a paragraph rule the title errs toward being a check too: an extra not_applicable, never a lost rule.
    expect(claimRuleChecks("Claim rules\n===========\n\nNever claim a certification.")).toEqual([
      { number: 1, text: "Claim rules" },
      { number: 2, text: "Never claim a certification." },
    ]);
  });

  it("reads a fenced block as text of the rule it sits in, never as headings, separators or items (#655 round 2)", () => {
    // The spurious checks this replaces: "```", "not a rule\n```".
    expect(claimRuleChecks("- Rule A.\n\n```\n# not heading\n- not a rule\n```")).toEqual([
      { number: 1, text: "Rule A." },
      { number: 2, text: "```\n# not heading\n- not a rule\n```" },
    ]);
    expect(
      claimRuleChecks("# Rules\n\n- Use this wording:\n```\n# not heading\n---\n- not an item\n===\n\nstill the rule\n```\n- Next rule."),
    ).toEqual([
      { number: 1, text: "Use this wording:\n```\n# not heading\n---\n- not an item\n===\n\nstill the rule\n```", context: "Rules" },
      { number: 2, text: "Next rule.", context: "Rules" },
    ]);
    // After a blank line a fence is a rule of its own, under the same heading; tildes and info strings count.
    expect(claimRuleChecks("# Rules\n\n- A.\n\n~~~md\n# not heading\n~~~\n\n- B.")).toEqual([
      { number: 1, text: "A.", context: "Rules" },
      { number: 2, text: "~~~md\n# not heading\n~~~", context: "Rules" },
      { number: 3, text: "B.", context: "Rules" },
    ]);
    // A fence closes only on the same character, at least as long as the opener.
    expect(claimRuleChecks("````\n```\n# x\n~~~~\n````\n\n- B.").map((c) => c.text)).toEqual(["````\n```\n# x\n~~~~\n````", "B."]);
    // An opener that never closes is an ordinary line, so it cannot merge the rules after it.
    expect(claimRuleChecks("- A.\n```\n# Scale\n- B.")).toEqual([
      { number: 1, text: "A.\n```" },
      { number: 2, text: "B.", context: "Scale" },
    ]);
    // '===' under a fenced block is a separator, never a heading underline.
    expect(claimRuleChecks("```\ncode rule\n```\n===\nNever claim B.")).toEqual([
      { number: 1, text: "```\ncode rule\n```" },
      { number: 2, text: "Never claim B." },
    ]);
  });

  it("keeps an indented '#' line inside a list item as the item's text; an unindented heading still closes it", () => {
    expect(claimRuleChecks("- Use # of teams wording\n  # teams is 4\n- other")).toEqual([
      { number: 1, text: "Use # of teams wording\n# teams is 4" },
      { number: 2, text: "other" },
    ]);
    expect(claimRuleChecks("- A.\n# Scale\n- B.")).toEqual([
      { number: 1, text: "A." },
      { number: 2, text: "B.", context: "Scale" },
    ]);
  });

  it("makes a multi-line paragraph one check, as Markdown reads it (rules one per line need bullets or blank lines)", () => {
    expect(claimRuleChecks("Never claim A.\nNever claim B.\nNever claim C.")).toEqual([
      { number: 1, text: "Never claim A.\nNever claim B.\nNever claim C." },
    ]);
    expect(claimRuleChecks("Never claim A.\n\nNever claim B.\n\nNever claim C.")).toHaveLength(3);
  });

  it("drops no rule line: every line that is not a heading or a separator lands in exactly one check's text, or (an '===' title or a ':' lead-in only) in a context", () => {
    const layouts = [
      "# Rules\n\nPreamble line.\n\nNever claim:\n\n- F1. Rule a.\n* F2. Rule b\n  continued.\n  - Rule b detail.\n1. S1. Rule c.\n\n---\n\nParagraph rule.\nParagraph rule continued.\n---\n- Rule d.\n  # Rule d continued.\n\nUnderlined title\n===\n\nRule e.\n\nUnderlined title with no rule\n===",
      "Rule para one\n---\nRule two",
      "- A item.\n\nNever claim B.\n---",
      "Never claim A.\n---\n- B item.",
      "Titles\n======\n\nLead-in:\n- Never Director.\n- Never VP.\n\n## Scale\n\nSay four teams.\n***\nLast rule.",
      "Never claim A.\n===\nNever claim B.\n===\n\nNever claim C.\n\n===\n\n- D item.\n===\nE para.",
      "- Rule A.\n```js\n# not heading\n- not an item\n===\n\nstill code\n```\n- Rule B.\n\n~~~\n---\n~~~",
    ];
    const isSeparator = (l: string) => /^ {0,3}(?:=+|-+|\*{3,}|_{3,}|(?:[-*_][ \t]*){3,})[ \t]*$/.test(l);
    const isHeading = (l: string) => /^#{1,6}(?:[ \t]|$)/.test(l);
    for (const source of layouts) {
      const checks = claimRuleChecks(source);
      const lines = source.split("\n");
      for (const [i, raw] of lines.entries()) {
        if (raw.trim() === "" || isSeparator(raw) || isHeading(raw)) continue;
        const mayBeContext = raw.trim().endsWith(":") || /^ {0,3}=+[ \t]*$/.test(lines[i + 1] ?? "");
        // A rule's first line loses its bullet glyph; a nested item keeps its marker.
        const forms = [raw.trim(), raw.trim().replace(/^[-*+•][ \t]+/, "")];
        const line = forms[1]!;
        const inText = checks.filter((c) => c.text.split("\n").some((t) => forms.includes(t)));
        const inContext = mayBeContext && checks.some((c) => c.context?.includes(line) ?? false);
        expect(inText.length === 1 || (inText.length === 0 && inContext), `${JSON.stringify(line)} in ${JSON.stringify(source)}`).toBe(true);
      }
    }
  });

  it("makes a plain paragraph its own check, and a ':' paragraph with no list after it too", () => {
    expect(claimRuleChecks("Never claim a certification.\n\nAlways say:").map((c) => c.text)).toEqual([
      "Never claim a certification.",
      "Always say:",
    ]);
  });

  it("joins indented, nested and lazy continuation lines to their rule", () => {
    const checks = claimRuleChecks("- Never claim X\n  unless Y.\n  - Exception: Z.\n- Never claim W\nbecause V.");
    expect(checks.map((c) => c.text)).toEqual(["Never claim X\nunless Y.\n- Exception: Z.", "Never claim W\nbecause V."]);
  });

  it("handles CRLF, ignores horizontal rules, and ends a lead-in at one", () => {
    const checks = claimRuleChecks("Never claim:\r\n- A.\r\n\r\n---\r\n\r\n- B.\r\n***\r\n- C.");
    expect(checks).toEqual([
      { number: 1, text: "A.", context: "Never claim:" },
      { number: 2, text: "B." },
      { number: 3, text: "C." },
    ]);
  });

  it("never rewords: every check is a contiguous run of the source, in source order", () => {
    const source = [
      "# Rules",
      "",
      "These rules bind every document.",
      "",
      "Never claim:",
      "",
      '- F1. A certification of any kind, including "PCI certified".',
      "- F2. Ownership of the platform roadmap",
      "  before 2023.",
      "",
      "1. S1. Say \"four storefront teams\", never \"multiple teams\".",
      "",
      "Use the job title exactly as the offer letter states it.",
    ].join("\n");
    const checks = claimRuleChecks(source);
    expect(checks).toHaveLength(5);
    let from = 0;
    const flat = squash(source);
    for (const c of checks) {
      const at = flat.indexOf(squash(c.text), from);
      expect(at, c.text).toBeGreaterThanOrEqual(from);
      from = at + squash(c.text).length;
    }
  });

  it("has no checks for absent or blank text (boundary)", () => {
    expect(claimRuleChecks(undefined)).toEqual([]);
    expect(claimRuleChecks("")).toEqual([]);
    expect(claimRuleChecks("  \n\t\n")).toEqual([]);
  });

  it("refuses text that is not blank but holds no rule (failure)", () => {
    expect(() => claimRuleChecks("# Claim rules\n\n---\n")).toThrow(/no rule lines/);
  });
});

describe("renderClaimRuleChecks", () => {
  it("numbers every check k of N, in order, with the rule text verbatim and context only when present", () => {
    const checks = claimRuleChecks('# Scale\n\n- Say "four teams".\n\nNever claim a certification.');
    const out = renderClaimRuleChecks(checks);
    expect(out).toContain('Check 1 of 2\nContext: Scale\nRule: Say "four teams".');
    expect(out).toContain("Check 2 of 2\nContext: Scale\nRule: Never claim a certification.");
    expect(out.indexOf("Check 1 of 2")).toBeLessThan(out.indexOf("Check 2 of 2"));
    expect(out.startsWith("Claim-rule checks: the 2 rules above")).toBe(true);
  });

  it("renders a single rule and no checks", () => {
    expect(renderClaimRuleChecks(claimRuleChecks("Never claim X."))).toMatch(/the 1 rule above[\s\S]*Check 1 of 1\nRule: Never claim X\.$/);
    expect(renderClaimRuleChecks([])).toBe("");
  });
});

describe("auditProblem", () => {
  const dropped = (check?: number) => ({
    kind: "strength" as const,
    jd_clause: "c",
    point: "p",
    evidence: [],
    reason: check === undefined ? ("no_span" as const) : ("claim_rule" as const),
    ...(check !== undefined && { check }),
  });
  const audit = (...checks: number[]) => checks.map((check) => ({ check, outcome: "obeyed" as const }));

  it("accepts checks 1..N in order, and an empty audit for no checks", () => {
    expect(auditProblem({ rule_audit: audit(1, 2, 3), dropped_points: [dropped(3)] }, 3)).toBeUndefined();
    expect(auditProblem({ rule_audit: [], dropped_points: [dropped()] }, 0)).toBeUndefined();
  });

  it("rejects a missing, out-of-order, duplicated or extra check", () => {
    expect(auditProblem({ rule_audit: audit(1), dropped_points: [] }, 2)).toMatch(/checks 1 to 2.*got \[1\]/);
    expect(auditProblem({ rule_audit: audit(2, 1), dropped_points: [] }, 2)).toMatch(/got \[2, 1\]/);
    expect(auditProblem({ rule_audit: audit(1, 1), dropped_points: [] }, 2)).toBeDefined();
    expect(auditProblem({ rule_audit: audit(1), dropped_points: [] }, 0)).toMatch(/no claim rules/);
  });

  it("rejects a dropped point naming a check that was not sent", () => {
    expect(auditProblem({ rule_audit: audit(1), dropped_points: [dropped(2)] }, 1)).toMatch(/check\(s\) 2/);
  });
});

describe("generateFitBrief prompt versions (#655)", () => {
  afterEach(() => {
    clearPromptVersionOverrides();
    _clearCacheForTests();
  });

  const body = (c: Anthropic, call = 0) =>
    vi.mocked(c.messages.create).mock.calls[call]![0] as Anthropic.Messages.MessageCreateParamsNonStreaming;

  it("sends v1 unchanged when asked for v1, and tags the result v1", async () => {
    const c = client([message(BRIEF)]);
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      promptVersion: "v1",
    });
    expect(result.promptVersion).toBe("v1");
    const user = String(body(c).messages[0]!.content);
    expect(user.endsWith("Claim rules (obey every one):\n\nNever claim PCI certification.")).toBe(true);
    expect(user).not.toContain("Claim-rule checks");
    const schema = body(c).tools![0]! as Anthropic.Messages.Tool;
    expect(Object.keys((schema.input_schema as { properties: object }).properties)).not.toContain("rule_audit");
  });

  it("sends v2's system, schema and numbered checks after the rules as written", async () => {
    const rules = "- Never claim PCI certification.\n- Say \"four storefront teams\".";
    const record = vi.fn<typeof RecordUsage>(async () => 0);
    const c = client([message({ ...BRIEF_V2, rule_audit: [{ check: 1, outcome: "obeyed" }, { check: 2, outcome: "not_applicable" }] })]);
    const result = await generateFitBrief(
      { ...INPUT, claimRulesText: rules },
      { model: "claude-sonnet-4-6", client: c, record, promptVersion: "v2" },
    );
    expect(result.promptVersion).toBe("v2");
    expect(result.brief).toMatchObject({ dropped_points: [], exposures: [{ evidence: [expect.any(String)] }] });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: "generation/fitBrief.v2" }));
    expect(String(body(c).system)).toMatch(/Self-audit/);
    const user = String(body(c).messages[0]!.content);
    // The rules as written, byte for byte, then the checks quoting each one.
    const rawBlock = `Claim rules (obey every one):\n\n${rules}`;
    const checksBlock = renderClaimRuleChecks(claimRuleChecks(rules));
    expect(user).toContain(`${rawBlock}\n\n---\n\n${checksBlock}\n\n---\n\nRun the self-audit, then call the tool.`);
    expect(checksBlock).toContain("Check 1 of 2\nRule: Never claim PCI certification.");
    expect(checksBlock).toContain('Check 2 of 2\nRule: Say "four storefront teams".');
    const props = Object.keys(((body(c).tools![0]! as Anthropic.Messages.Tool).input_schema as { properties: object }).properties);
    expect(props.slice(-2)).toEqual(["rule_audit", "dropped_points"]);
  });

  it("sends no checks block for v2 without claim rules", async () => {
    const c = client([message({ ...BRIEF_V2, rule_audit: [] })]);
    await generateFitBrief(
      { jdText: INPUT.jdText, resumeText: INPUT.resumeText },
      { model: "claude-sonnet-4-6", client: c, record: vi.fn<typeof RecordUsage>(async () => 0), promptVersion: "v2" },
    );
    // The few-shot shows an example rules section; the role's part has none.
    const user = String(body(c).messages[0]!.content).split("Now write the brief for this role.")[1]!;
    expect(user).not.toContain("Claim-rule checks");
    expect(user).not.toContain("Claim rules (obey every one)");
    expect(user.endsWith("Run the self-audit, then call the tool.")).toBe(true);
  });

  it("reads the version only from the caller: a runtime override never changes it", async () => {
    // One resolution path (#655 round 2): the harness passes its flag and
    // the generator sends exactly that, whatever the loader would resolve.
    setPromptVersionOverrides({ "generation/fitBrief": "v2" });
    const c = client([message(BRIEF)]);
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      promptVersion: "v1",
    });
    expect(result.promptVersion).toBe("v1");
    expect(String(body(c).system)).not.toMatch(/Self-audit/);
  });

  it("refuses an unknown or missing version before any request is built", async () => {
    // An unregistered model would make building the request throw, so the
    // version error proves the check runs first; no client call either.
    for (const promptVersion of ["v9", "V2", "../v1", undefined]) {
      const c = client([message(BRIEF)]);
      const deps = { model: "unregistered-model", client: c, record: vi.fn<typeof RecordUsage>(async () => 0), promptVersion };
      await expect(generateFitBrief(INPUT, deps as unknown as FitBriefDeps)).rejects.toThrow(
        /^Unknown fit-brief prompt version .*pass deps\.promptVersion as one of v1, v2\.$/,
      );
      expect(vi.mocked(c.messages.create)).not.toHaveBeenCalled();
    }
    expect(() => fitBriefRequestFingerprint("claude-sonnet-4-6", undefined, "v9" as FitBriefPromptVersion)).toThrow(
      /Unknown fit-brief prompt version "v9"/,
    );
  });

  it("refuses v2 rules text with no rule line before any request", async () => {
    const c = client([message(BRIEF_V2)]);
    await expect(
      generateFitBrief(
        { ...INPUT, claimRulesText: "# Claim rules\n" },
        { model: "claude-sonnet-4-6", client: c, record: vi.fn<typeof RecordUsage>(async () => 0), promptVersion: "v2" },
      ),
    ).rejects.toThrow(/no rule lines/);
    expect(vi.mocked(c.messages.create)).not.toHaveBeenCalled();
  });

  it("retries an incomplete self-audit with a reminder, then accepts a complete one", async () => {
    const c = client([message({ ...BRIEF_V2, rule_audit: [] }), message(BRIEF_V2)]);
    const result = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: c,
      record: vi.fn<typeof RecordUsage>(async () => 0),
      promptVersion: "v2",
    });
    expect(result.promptVersion).toBe("v2");
    expect(String(body(c, 1).system)).toMatch(/self-audit did not match[\s\S]*checks 1 to 1/);
  });

  it("gives up after three incomplete audits", async () => {
    const bad = message({ ...BRIEF_V2, rule_audit: [{ check: 2, outcome: "obeyed" }] });
    const err = await generateFitBrief(INPUT, {
      model: "claude-sonnet-4-6",
      client: client([bad, bad, bad]),
      record: vi.fn<typeof RecordUsage>(async () => 0),
      promptVersion: "v2",
    }).catch((e: unknown) => e);
    expect((err as FitBriefError).failures.map((f) => f.kind)).toEqual(["incomplete_audit", "incomplete_audit", "incomplete_audit"]);
  });

  it("validates v2 against v2's schema: a v1-shaped brief fails it", async () => {
    const c = client([message(BRIEF), message(BRIEF_V2)]);
    await generateFitBrief(INPUT, { model: "claude-sonnet-4-6", client: c, record: vi.fn<typeof RecordUsage>(async () => 0), promptVersion: "v2" });
    expect(String(body(c, 1).system)).toMatch(/failed schema validation[\s\S]*rule_audit/);
  });
});

describe("output budget per prompt version (#655 round 2)", () => {
  const firstCall = (c: Anthropic) => vi.mocked(c.messages.create).mock.calls[0]!;

  it("sends v1's request byte for byte as before v2 had its own budget", async () => {
    // sha256 of JSON.stringify([body, options]), captured from generateFitBrief at da95a4b.
    for (const [model, effort, maxTokens, sha] of [
      ["claude-sonnet-4-6", undefined, 8192, "d746cb219a1f776c"],
      ["claude-opus-5-5", "high", 16384, "ebb3aefaf8330575"],
    ] as const) {
      const c = client([message(BRIEF)]);
      await generateFitBrief(INPUT, {
        model,
        ...(effort !== undefined && { effort }),
        client: c,
        record: vi.fn<typeof RecordUsage>(async () => 0),
        promptVersion: "v1",
      });
      expect(firstCall(c)[0].max_tokens).toBe(maxTokens);
      expect(createHash("sha256").update(JSON.stringify(firstCall(c))).digest("hex").slice(0, 16)).toBe(sha);
      expect(fitBriefMaxTokens(model, "v1")).toBe(maxTokens);
    }
  });

  it("gives v2 twice v1's budget on every model, scaled by the profile, and records it on usage", async () => {
    for (const [model, effort, v1MaxTokens, longRequest] of [
      ["claude-sonnet-4-6", undefined, 8192, false],
      ["claude-opus-5-5", "high", 16384, true],
      ["claude-sonnet-5-5", "medium", 16384, true],
    ] as const) {
      const record = vi.fn<typeof RecordUsage>(async () => 0);
      const c = client([message(BRIEF_V2)]);
      await generateFitBrief(INPUT, { model, ...(effort !== undefined && { effort }), client: c, record, promptVersion: "v2" });
      const [sent, options] = firstCall(c);
      expect(sent.max_tokens).toBe(2 * v1MaxTokens);
      expect(fitBriefMaxTokens(model, "v2")).toBe(2 * v1MaxTokens);
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: "generation/fitBrief.v2", maxTokens: 2 * v1MaxTokens }));
      // Above the SDK's non-streaming limit the request carries its own timeout.
      expect(options).toEqual(longRequest ? { timeout: LONG_REQUEST_TIMEOUT_MS } : undefined);
    }
  });
});

describe("fitBriefRequestFingerprint versions (#655)", () => {
  it("pins v1 to the fingerprints of the Phase 3 matrix of record, so v1 can never drift", () => {
    expect(fitBriefRequestFingerprint("claude-opus-5-5", "high")).toBe("sha256:8f9a1d6d6a59");
    expect(fitBriefRequestFingerprint("claude-sonnet-5-5", "medium")).toBe("sha256:35ab6febcd95");
    expect(fitBriefRequestFingerprint("claude-sonnet-4-6")).toBe("sha256:f5ef37065d95");
    expect(fitBriefRequestFingerprint("claude-opus-5-5", "high", "v1")).toBe("sha256:8f9a1d6d6a59");
  });

  it("gives v2 its own stable fingerprint for every model and effort", () => {
    for (const [model, effort] of [["claude-opus-5-5", "high"], ["claude-sonnet-5-5", "medium"], ["claude-sonnet-4-6", undefined]] as const) {
      const v2 = fitBriefRequestFingerprint(model, effort, "v2");
      expect(v2).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(v2).not.toBe(fitBriefRequestFingerprint(model, effort, "v1"));
      expect(v2).toBe(fitBriefRequestFingerprint(model, effort, "v2"));
    }
    expect(fitBriefRequestFingerprint("claude-opus-5-5", "high", "v2")).not.toBe(fitBriefRequestFingerprint("claude-opus-5-5", "medium", "v2"));
  });

  it("labels versions and recognizes only v1 and v2", () => {
    expect(fitBriefPromptLabel("v2")).toBe("generation/fitBrief.v2");
    expect(isFitBriefPromptVersion("v1")).toBe(true);
    expect(isFitBriefPromptVersion("v2")).toBe(true);
    expect(isFitBriefPromptVersion("V2")).toBe(false);
    expect(isFitBriefPromptVersion("v3")).toBe(false);
  });
});
