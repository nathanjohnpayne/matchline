import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { auditProblem, claimRuleChecks, renderClaimRuleChecks } from "../../generation/fitBrief.ts";
import { PROMPT_CONFIG } from "../config.ts";
import { parsePromptSections } from "../loader.ts";

import { FitBriefResponseV2Schema } from "./fitBrief.v2.schema.ts";

/**
 * Rendering test for `fitBrief.v2.md` (#655). The few-shot input is
 * pinned to the code that renders a real v2 request, so the example the
 * model sees has exactly the layout of the rules and checks it receives.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
const v1 = parsePromptSections(read("fitBrief.v1.md"), "fitBrief.v1.md");
const v2 = parsePromptSections(read("fitBrief.v2.md"), "fitBrief.v2.md");

/** The numbered hard rules of a system prompt, keyed by number. */
function hardRules(system: string): Map<number, string> {
  return new Map(
    [...system.matchAll(/^(\d+)\. (\*\*[\s\S]*?)(?=\n\n|(?![\s\S]))/gm)].map((m) => [Number(m[1]), m[2]!] as const),
  );
}

const EXAMPLE_JD =
  "Senior Product Manager, Payments Platform. Own the roadmap for the internal payments platform used by twelve product teams. Requirements: 6+ years of product management; experience with platform products other teams build on; PCI or financial-compliance experience; strong written communication.";
const EXAMPLE_RESUME = [
  "Jordan Lee — Product Manager, 2021–2025, Brightcart",
  "- Owned the checkout API used by four storefront teams; cut integration time from six weeks to two.",
  "- Led the migration of card storage to a tokenization vendor ahead of a PCI DSS audit.",
  "Associate Product Manager, 2019–2021, Brightcart",
  "- Shipped the returns flow for the mobile app.",
].join("\n");
const EXAMPLE_RULES = [
  "- Never describe the PCI migration as a certification or as an audit the candidate passed.",
  '- Say "four storefront teams" for the checkout API\'s reach, never "multiple teams" or "many teams".',
].join("\n");

function exampleOutput(): unknown {
  const marker = "Example output (tool call):";
  return JSON.parse(v2.userFewShot.slice(v2.userFewShot.indexOf(marker) + marker.length));
}

describe("fitBrief.v2.md", () => {
  it("keeps v1's hard rules 1, 3, 4, 6, 7 and 8 verbatim and changes only 2 and 5", () => {
    const before = hardRules(v1.system);
    const after = hardRules(v2.system);
    expect([...after.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const n of [1, 3, 4, 6, 7, 8]) expect(after.get(n), `rule ${n}`).toBe(before.get(n));
    for (const n of [2, 5]) expect(after.get(n), `rule ${n}`).not.toBe(before.get(n));
  });

  it("requires a cited span before each point and makes every claim rule a numbered check", () => {
    const rules = hardRules(v2.system);
    expect(rules.get(2)).toMatch(/Cite the span first[\s\S]*before you write the `argument` or the `gap`/);
    expect(rules.get(5)).toMatch(/Each claim rule is a numbered check[\s\S]*never reword/);
  });

  it("ends with the self-audit, which drops points into dropped_points and records rule_audit", () => {
    const audit = v2.system.slice(v2.system.indexOf("Self-audit."));
    expect(audit.length).toBeGreaterThan(0);
    // Nothing follows the audit: it is the last section of the system prompt.
    expect(v2.system.indexOf("Self-audit.")).toBeGreaterThan(v2.system.indexOf("8. **Choose a verdict.**"));
    for (const term of ["dropped_points", "rule_audit", "span_does_not_support", "no_span", "claim_rule"]) {
      expect(audit).toContain(term);
    }
  });

  it("shows the example rules exactly as a v2 request renders them: as written, then the numbered checks", () => {
    const rendered = [
      `Job description:\n\n${EXAMPLE_JD}`,
      `Résumé:\n\n${EXAMPLE_RESUME}`,
      `Claim rules (obey every one):\n\n${EXAMPLE_RULES}`,
      renderClaimRuleChecks(claimRuleChecks(EXAMPLE_RULES)),
    ].join("\n\n---\n\n");
    expect(v2.userFewShot).toContain(rendered);
  });

  it("has an example output that parses, passes the audit check, and cites only verbatim résumé spans", () => {
    const parsed = FitBriefResponseV2Schema.parse(exampleOutput());
    expect(auditProblem(parsed, claimRuleChecks(EXAMPLE_RULES).length)).toBeUndefined();
    const spans = [
      ...parsed.strengths.flatMap((s) => s.evidence),
      ...parsed.exposures.flatMap((e) => e.evidence),
      ...parsed.dropped_points.flatMap((d) => d.evidence),
    ];
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) expect(EXAMPLE_RESUME, span).toContain(span);
    // The example shows both an absence exposure and a dropped point.
    expect(parsed.exposures.some((e) => e.evidence.length === 0)).toBe(true);
    expect(parsed.dropped_points).toHaveLength(1);
  });

  it("keeps development history out of model-visible text", () => {
    // The same pattern promptExamples.test.ts applies to the other v2 prompts.
    expect(`${v2.system}\n${v2.userFewShot}`).not.toMatch(
      /#\d{2,}|\bPR\b|Phase \d|Codex|CodeRabbit|cursor|prior version|validator will|pipeline \(/,
    );
  });

  it("is not the configured default: the generator is eval-only and v1 stays the default", () => {
    expect(PROMPT_CONFIG.generation.fitBrief).toBe("v1");
  });
});
