import { describe, expect, it } from "vitest";

import { FitBriefResponseV1Schema } from "./fitBrief.v1.schema.ts";

const KNOWN_GOOD = {
  bottom_line: "Strong platform fit; the years minimum is the risk.",
  strengths: [
    {
      jd_clause: "platform products other teams build on",
      evidence: ["Owned the checkout API used by four storefront teams."],
      argument: "Internal teams were the customers.",
    },
  ],
  exposures: [
    { jd_clause: "6+ years of PM", gap: "Titled PM years are fewer.", handling: "Argue scope." },
  ],
  positioning: "Lead with the API.",
  homework: ["Draft an intake plan."],
  questions_to_ask: ["Who arbitrates conflicts?"],
  does_not_claim: ["Twelve-team scale."],
  verdict: "referral_needed",
};

describe("FitBriefResponseV1Schema", () => {
  it("accepts a well-formed brief, with or without level_strategy", () => {
    expect(FitBriefResponseV1Schema.safeParse(KNOWN_GOOD).success).toBe(true);
    expect(
      FitBriefResponseV1Schema.safeParse({ ...KNOWN_GOOD, level_strategy: "Senior as posted." }).success,
    ).toBe(true);
  });

  it("rejects a strength with no evidence: without a quote it is an argument, not a strength", () => {
    const bad = { ...KNOWN_GOOD, strengths: [{ ...KNOWN_GOOD.strengths[0], evidence: [] }] };
    expect(FitBriefResponseV1Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a brief with no strengths", () => {
    expect(FitBriefResponseV1Schema.safeParse({ ...KNOWN_GOOD, strengths: [] }).success).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(FitBriefResponseV1Schema.safeParse({ ...KNOWN_GOOD, verdict: "maybe" }).success).toBe(false);
  });

  it("rejects fields outside the contract", () => {
    expect(FitBriefResponseV1Schema.safeParse({ ...KNOWN_GOOD, score: 0.9 }).success).toBe(false);
  });

  it("rejects blank strings", () => {
    expect(FitBriefResponseV1Schema.safeParse({ ...KNOWN_GOOD, bottom_line: "   " }).success).toBe(false);
  });
});
