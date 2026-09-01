/**
 * Tests for the re-derivation trigger (#441, hardened after
 * Codex P2 on PR #446).
 *
 * Two directions, and both matter. Missing an input the
 * derivation reads leaves a stale verdict driving `computeGaps`
 * until the route remounts. Including one it ignores fires a
 * callable on every unrelated edit in the user's graph.
 */

import { describe, expect, it } from "vitest";

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";

import { legacyEvidenceKey } from "./evidenceKey.ts";

function unit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  return {
    id: "unit-1",
    owner_uid: "u",
    source_type: "resume",
    source_ref: "ref",
    raw_text: "raw",
    normalized_summary: "summary",
    unit_type: "project",
    skills: ["Product Strategy"],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    embedding: [1, 0],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function requirement(
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  return {
    id: "req-1",
    owner_uid: "u",
    role_id: "role-1",
    raw_text: "raw",
    normalized_requirement: "norm",
    category: "skill",
    keywords: ["product strategy"],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
    embedding: [1, 0],
    ...overrides,
  };
}

function match(overrides: Partial<UnitMatch> = {}): UnitMatch {
  return {
    id: "match-1",
    owner_uid: "u",
    experience_unit_id: "unit-1",
    job_requirement_unit_id: "req-1",
    role_id: "role-1",
    semantic_score: 0.5,
    rule_score: 0.5,
    final_score: 0.5,
    rationale: "r",
    surface_evidence: "e",
    approved_for_use: false,
    user_rejected: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const KEY = (
  m: readonly UnitMatch[],
  u: readonly ExperienceUnit[] = [unit()],
  r: readonly JobRequirementUnit[] = [requirement()],
): string => legacyEvidenceKey(m, u, r);

describe("legacyEvidenceKey: when no call should be made", () => {
  it("is empty with no matches", () => {
    expect(KEY([])).toBe("");
  });

  it("is empty when every match already carries structural_evidence", () => {
    // A Role matched under #435 or later must cost zero
    // round-trips.
    expect(
      KEY([
        match({ id: "m1", structural_evidence: true }),
        match({ id: "m2", structural_evidence: false }),
      ]),
    ).toBe("");
  });

  it("is non-empty as soon as one legacy row is present", () => {
    expect(
      KEY([match({ id: "m1", structural_evidence: true }), match({ id: "m2" })]),
    ).not.toBe("");
  });
});

describe("legacyEvidenceKey: changes that MUST re-derive", () => {
  const base = KEY([match()]);

  it("changes when the Unit's reembed_pending is cleared", () => {
    // The case Codex named: the reembed callable clears the flag
    // asynchronously, flipping the verdict from `unverifiable` to
    // a real answer, with no change to any match.
    const pending = KEY([match()], [unit({ reembed_pending: true })]);
    expect(pending).not.toBe(base);
  });

  it("changes for every Unit vocabulary the structural axes read", () => {
    // Signed directly rather than via `updated_at`. The timestamp
    // was a proxy for these, on the premise that every write path
    // bumps it — true of `updateFields`, `setApproval` and
    // `markReembedPending`, and false of the exported
    // `upsertExperienceUnit`, which `setDoc`s the caller's object
    // verbatim. Codex P2 on PR #446.
    const variants = [
      unit({ skills: ["Machine Learning"] }),
      unit({ tools: ["Figma"] }),
      unit({ domains: ["Fintech"] }),
      unit({ seniority_signals: ["Staff"] }),
      unit({ scope_signals: ["org-wide"] }),
    ];
    for (const u of variants) {
      expect(KEY([match()], [u])).not.toBe(base);
    }
  });

  it("changes when a Unit is edited through a path that keeps updated_at", () => {
    // The concrete hole the timestamp proxy left: changed skills
    // under an unchanged timestamp.
    expect(
      KEY([match()], [unit({ skills: ["Machine Learning"] })]),
    ).not.toBe(base);
  });

  it("changes when the Unit's approval is withdrawn", () => {
    expect(KEY([match()], [unit({ user_approved: false })])).not.toBe(base);
  });

  it("changes when the Unit's embedding disappears", () => {
    expect(KEY([match()], [unit({ embedding: [] })])).not.toBe(base);
    expect(KEY([match()], [unit({ embedding: undefined })])).not.toBe(base);
  });

  it("changes when the Unit is deleted outright", () => {
    expect(KEY([match()], [])).not.toBe(base);
  });

  it("changes when a Requirement is re-parsed under the same id", () => {
    // Same id, different constraints: the id set is identical and
    // the verdict is not.
    expect(
      KEY([match()], [unit()], [requirement({ keywords: ["machine learning"] })]),
    ).not.toBe(base);
  });

  it("changes for every Requirement field the axes read", () => {
    const variants = [
      requirement({ category: "scope" }),
      requirement({ seniority_level: "senior" }),
      requirement({ tools: ["figma"] }),
      requirement({ domains: ["fintech"] }),
      requirement({ embedding: [] }),
    ];
    for (const r of variants) {
      expect(KEY([match()], [unit()], [r])).not.toBe(base);
    }
  });

  it("changes when the Requirement is gone", () => {
    expect(KEY([match()], [unit()], [])).not.toBe(base);
  });

  it("changes when a match is repointed at a different pair that signs the same", () => {
    // `upsertMatch` can change both linked ids while keeping
    // `match.id`. Two Units identical in every field the
    // signature covers would otherwise leave the key unchanged,
    // and the container would keep the old pair's verdict for the
    // new pair. CodeRabbit on PR #446.
    const twin = unit({ id: "unit-2" });
    const repointed = match({ experience_unit_id: "unit-2" });
    expect(KEY([repointed], [unit(), twin])).not.toBe(
      KEY([match()], [unit(), twin]),
    );
  });

  it("changes when a match is repointed at an identical-signing Requirement", () => {
    const twinReq = requirement({ id: "req-2" });
    expect(
      KEY(
        [match({ job_requirement_unit_id: "req-2" })],
        [unit()],
        [requirement(), twinReq],
      ),
    ).not.toBe(KEY([match()], [unit()], [requirement(), twinReq]));
  });

  it("changes when a new legacy match appears", () => {
    expect(KEY([match(), match({ id: "match-2" })])).not.toBe(base);
  });
});

describe("legacyEvidenceKey: changes that must NOT re-derive", () => {
  const base = KEY([match()]);

  it("is unchanged by approving or rejecting a match", () => {
    // The reason this is not keyed on `matches`: every click
    // rewrites the array, and a callable per click is the cost.
    expect(KEY([match({ approved_for_use: true })])).toBe(base);
    expect(KEY([match({ user_rejected: true })])).toBe(base);
  });

  it("is unchanged by an unrelated Unit elsewhere in the graph", () => {
    expect(
      KEY([match()], [unit(), unit({ id: "unit-99", skills: ["Baking"] })]),
    ).toBe(base);
  });

  it("is unchanged by an unrelated Requirement on the Role", () => {
    expect(
      KEY([match()], [unit()], [requirement(), requirement({ id: "req-99" })]),
    ).toBe(base);
  });

  it("is unchanged by Unit fields the derivation never reads", () => {
    expect(
      KEY([match()], [unit({ confidence_score: 0.1, raw_text: "different" })]),
    ).toBe(base);
  });

  it("is unchanged by updated_at on its own", () => {
    // Now that the vocabularies are signed directly, a bare
    // timestamp bump cannot alter a verdict and must not cost a
    // round trip.
    expect(
      KEY([match()], [unit({ updated_at: "2026-06-01T00:00:00.000Z" })]),
    ).toBe(base);
  });

  it("is unchanged by date_range, which only feeds the recency axis", () => {
    // `recency` is not in STRUCTURAL_AXES, so it cannot decide a
    // verdict — including it here would re-derive for nothing.
    expect(
      KEY([match()], [unit({ date_range: { start: "2020-01-01" } })]),
    ).toBe(base);
  });

  it("is stable under input reordering", () => {
    const a = KEY([match({ id: "m-a" }), match({ id: "m-b" })]);
    const b = KEY([match({ id: "m-b" }), match({ id: "m-a" })]);
    expect(a).toBe(b);
  });
});

describe("legacyEvidenceKey: the encoding is lossless (#446)", () => {
  it("distinguishes arrays that a delimiter join would collapse", () => {
    // `["product strategy", "x"].join("|")` and
    // `["product strategy|x"].join("|")` are the same string, and
    // the two Requirements are not the same: the normalizer can
    // recognize the first as a constrained skill axis and reject
    // the second as unrecognized vocabulary. Codex P2 on PR #446.
    const split = KEY(
      [match()],
      [unit()],
      [requirement({ keywords: ["product strategy", "x"] })],
    );
    const joined = KEY(
      [match()],
      [unit()],
      [requirement({ keywords: ["product strategy|x"] })],
    );
    expect(split).not.toBe(joined);
  });

  it("distinguishes the same collision on the Unit side", () => {
    expect(KEY([match()], [unit({ skills: ["a", "b"] })])).not.toBe(
      KEY([match()], [unit({ skills: ["a|b"] })]),
    );
  });

  it("distinguishes a value moving between adjacent fields", () => {
    // A separator between FIELDS collides too: `tools: ["x"]` with
    // empty domains versus empty tools with `domains: ["x"]`.
    expect(
      KEY([match()], [unit()], [requirement({ tools: ["x"], domains: [] })]),
    ).not.toBe(
      KEY([match()], [unit()], [requirement({ tools: [], domains: ["x"] })]),
    );
  });

  it("distinguishes ids that a delimiter would let bleed together", () => {
    expect(
      KEY([match({ id: "a", experience_unit_id: "b~c" })], [], []),
    ).not.toBe(KEY([match({ id: "a~b", experience_unit_id: "c" })], [], []));
  });
});
