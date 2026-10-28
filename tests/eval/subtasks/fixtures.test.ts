import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { liveApprovedMatchesOf } from "../../../functions/src/generation/pipeline.ts";

import {
  DRAFT_REVIEW_STATUS,
  FixtureError,
  FIXED_RUN_DATE,
  FIXTURES_ROOT,
  OWNER_TRACES_DIR,
  loadGenerationSnapshots,
  loadValidationCases,
  parseGenerationSnapshot,
  parseValidationCase,
  toGenerationInputs,
  VALIDATION_CATEGORIES,
  whitespaceNormalize,
} from "./fixtures.ts";

const cases = loadValidationCases();
const snaps = loadGenerationSnapshots();

function rawCase(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, "validation-cases", `${id}.json`), "utf8")) as Record<string, unknown>;
}
function rawSnap(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, "generation-snapshots", `${id}.json`), "utf8")) as Record<string, unknown>;
}

/**
 * Parsed fixture JSON, mutated into shapes the schema must reject; the
 * loader's job is exactly to refuse what the static type would forbid.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mutable = any;

/** Parse a mutated copy of a case and return the error message. */
function caseError(id: string, mutate: (c: Mutable) => void): string {
  const c = rawCase(id);
  mutate(c);
  try {
    parseValidationCase(c, `validation-cases/${id}.json`);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the mutated case to be rejected");
}
function snapError(id: string, mutate: (s: Mutable) => void): string {
  const s = rawSnap(id);
  mutate(s);
  try {
    parseGenerationSnapshot(s, `generation-snapshots/${id}.json`);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the mutated snapshot to be rejected");
}

describe("draft fixtures", () => {
  it("loads at least 12 cases and one rich and one sparse snapshot", () => {
    expect(cases.items.length).toBeGreaterThanOrEqual(12);
    expect(snaps.items.map((s) => s.snapshot.evidence_density).sort()).toEqual(["rich", "sparse"]);
  });

  it("marks every new file as a draft pending owner review", () => {
    for (const c of cases.items) {
      expect(c.case.review_status, c.case.id).toBe(DRAFT_REVIEW_STATUS);
      expect(c.case.labeled_by, c.case.id).toBe("claude-draft");
    }
    for (const s of snaps.items) {
      expect(s.snapshot.review_status).toBe(DRAFT_REVIEW_STATUS);
      expect(s.snapshot.labeled_by).toBe("claude-draft");
    }
  });

  it("covers every #488 category, multi-clause and the adversarial fabrication", () => {
    const seen = new Set(cases.items.map((c) => c.case.category));
    for (const cat of VALIDATION_CATEGORIES) expect(seen.has(cat), cat).toBe(true);
  });

  it("takes every raw_text verbatim from its public fixture and carries no contact data", () => {
    for (const c of cases.items) {
      for (const u of c.case.units) {
        expect(whitespaceNormalize(c.resumeText).includes(whitespaceNormalize(u.raw_text)), `${c.case.id}/${u.id}`).toBe(true);
        expect(u.raw_text).not.toMatch(/@|https?:\/\/|\+?\d[\d\s().-]{7,}\d/);
      }
    }
    for (const s of snaps.items) {
      for (const r of s.snapshot.requirements) {
        expect(whitespaceNormalize(s.jdText).includes(whitespaceNormalize(r.raw_text)), r.id).toBe(true);
      }
    }
  });

  it("derives vc-14 from the owner-labeled adversarial file", () => {
    const owner = JSON.parse(readFileSync(join(FIXTURES_ROOT, "expected-asset-traces", "adversarial-fabrication.json"), "utf8"));
    const c = cases.items.find((x) => x.case.id === "vc-14-adversarial-fabrication")!.case;
    expect(c.item.text).toBe(owner.adversarial_fabricated_claim);
    expect(c.gold.assertions).toHaveLength(4);
    expect(c.gold.assertions.every((a) => !a.supported)).toBe(true);
    expect(c.gold.expected_asset_status).toBe("failed");
  });

  it("scores vc-15's date drift: the drifted start unsupported, the Unit's own end supported, both dates before the fixed run date", () => {
    const lc = cases.items.find((x) => x.case.id === "vc-15-date-drift")!;
    expect(lc.case.category).toBe("date_drift");
    expect(lc.case.review_status).toBe(DRAFT_REVIEW_STATUS);
    expect(lc.case.labeled_by).toBe("claude-draft");
    expect(lc.units[0]!.date_range).toEqual({ start: "2018-01-01", end: "2022-12-31" });
    const byId = Object.fromEntries(lc.case.gold.assertions.map((a) => [a.id, a.supported]));
    expect(byId).toEqual({ a1: false, a2: true, a3: true });
    for (const u of cases.items.flatMap((x) => x.units)) {
      if (u.date_range === undefined) continue;
      expect(u.date_range.start < FIXED_RUN_DATE.slice(0, 10)).toBe(true);
      if (u.date_range.end !== undefined) expect(u.date_range.end < FIXED_RUN_DATE.slice(0, 10)).toBe(true);
    }
    // A Unit with no date_range carries none at runtime (its evidence text is unchanged).
    expect("date_range" in cases.items.find((x) => x.case.id === "vc-07-unsupported-title")!.units[0]!).toBe(false);
  });

  it("keeps every expected status consistent with its assertions", () => {
    for (const c of cases.items) {
      const fails = c.case.gold.assertions.some((a) => !a.supported || a.specific === false);
      expect(c.case.gold.expected_asset_status, c.case.id).toBe(fails ? "failed" : "passed");
    }
  });

  it("builds complete runtime ExperienceUnits with mnemonic ids", () => {
    const u = cases.items[0]!.units[0]!;
    expect(u.id).toBe(cases.items[0]!.case.units[0]!.id);
    expect(u.owner_uid).toBe("eval-owner");
    expect(u.source_ref).toMatch(/^resume:[0-9a-f]{64}:0$/);
    expect(u.user_approved).toBe(true);
    expect(u.evidence_type).toBe("verified");
  });

  it("deep-freezes what it loads", () => {
    "use strict";
    const c = cases.items[0]!.case;
    expect(() => {
      (c.item as { text: string }).text = "changed";
    }).toThrow(TypeError);
    expect(() => {
      (c.gold.assertions as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe("toGenerationInputs", () => {
  const sparse = snaps.items.find((s) => s.snapshot.id === "gs-sparse-sofia-openai")!;
  const inputs = toGenerationInputs(sparse.snapshot, sparse.resumeText, sparse.jdText);

  it("keeps every approved match live and makes exactly the matched Units eligible", () => {
    const live = liveApprovedMatchesOf(inputs.approvedMatches, inputs.requirements);
    expect(live).toHaveLength(sparse.snapshot.approved_matches.length);
    const eligible = new Set(live.map((m) => m.experience_unit_id));
    expect([...eligible].sort()).toEqual(["u_b2b_pivot", "u_threadline_mvp", "u_threadline_schema"]);
    expect(inputs.role.jd_raw).toBe(sparse.jdText);
  });

  it("leaves two must-haves present but unmatched in the sparse snapshot", () => {
    const matched = new Set(inputs.approvedMatches.map((m) => m.job_requirement_unit_id));
    for (const id of ["r_9yr_eng", "r_reliability_safety_perf"]) {
      expect(inputs.requirements.some((r) => r.id === id && r.must_have)).toBe(true);
      expect(matched.has(id)).toBe(false);
    }
  });
});

describe("loader rejections (file and path named)", () => {
  const ID = "vc-02-equivalent-numeric-notation";

  it("rejects a raw_text that is not verbatim", () => {
    expect(caseError(ID, (c) => (c.units[0].raw_text = "Built Threadline's MVP with a team of twelve."))).toMatch(
      /validation-cases\/vc-02-equivalent-numeric-notation\.json: units\.0\.raw_text: not a verbatim substring/,
    );
  });

  it("rejects a dangling cited Unit", () => {
    expect(caseError(ID, (c) => c.item.source_unit_ids.push("u_nope"))).toMatch(/item\.source_unit_ids\.1: u_nope is not a Unit/);
  });

  it("rejects an unsupported assertion with supporting Units", () => {
    expect(caseError(ID, (c) => (c.gold.assertions[0].supported = false))).toMatch(/gold\.assertions\.0\.supporting_unit_ids/);
  });

  it("rejects support from an uncited Unit", () => {
    expect(
      caseError("vc-09-missing-cited-evidence", (c) => (c.gold.assertions[1] = { ...c.gold.assertions[1], supported: true, supporting_unit_ids: ["u_soc2"] })),
    ).toMatch(/u_soc2 is not cited by the item/);
  });

  it("rejects a required term the item does not contain", () => {
    expect(caseError(ID, (c) => c.gold.assertions[0].required_terms.push("Kubernetes"))).toMatch(
      /gold\.assertions\.0\.required_terms\.3: "Kubernetes" is not in item\.text/,
    );
  });

  it("rejects a relationship naming a missing assertion", () => {
    expect(caseError(ID, (c) => (c.gold.relationships[0].assertion_ids = ["a1", "a9"]))).toMatch(/assertion_ids\.1: no assertion a9/);
  });

  it("rejects a status inconsistent with the assertions", () => {
    expect(caseError(ID, (c) => (c.gold.expected_asset_status = "failed"))).toMatch(/gold\.expected_asset_status: failed is inconsistent/);
  });

  it("rejects a missing-cited-evidence case with no distractor", () => {
    expect(
      caseError("vc-09-missing-cited-evidence", (c) => {
        c.units = c.units.filter((u: { id: string }) => u.id !== "u_soc2");
      }),
    ).toMatch(/missing_cited_evidence needs an uncited Unit/);
  });

  it("rejects an adversarial case whose text differs from the owner file", () => {
    expect(caseError("vc-14-adversarial-fabrication", (c) => (c.item.text = c.item.text.replace("$400M", "$40M")))).toMatch(
      /item\.text: must equal the owner file/,
    );
  });

  it("rejects owner-reviewed with labeled_by claude-draft, so one flipped field cannot drop the DRAFT banner", () => {
    expect(caseError(ID, (c) => (c.review_status = "owner-reviewed"))).toMatch(
      /labeled_by: an "owner-reviewed" file needs the reviewing owner's labeled_by, not "claude-draft"/,
    );
    expect(snapError("gs-sparse-sofia-openai", (s) => (s.review_status = "owner-reviewed"))).toMatch(/labeled_by: an "owner-reviewed" file/);
    // With the owner's own labeled_by, the schema accepts it.
    const c = rawCase(ID);
    c.review_status = "owner-reviewed";
    c.labeled_by = "nathanjohnpayne";
    expect(parseValidationCase(c, `validation-cases/${ID}.json`).review_status).toBe("owner-reviewed");
  });

  it("rejects a date_drift case whose cited Unit has no date_range", () => {
    expect(caseError("vc-15-date-drift", (c) => delete c.units[0].date_range)).toMatch(/date_drift needs a cited Unit with a date_range/);
  });

  it("rejects a Unit date on or after the fixed run date, and an end before its start", () => {
    expect(caseError("vc-15-date-drift", (c) => (c.units[0].date_range.end = "2026-01-15"))).toMatch(
      /units\.0\.date_range\.end: 2026-01-15 is not before the fixed run date 2026-01-15/,
    );
    expect(caseError("vc-15-date-drift", (c) => (c.units[0].date_range.end = "2017-01-01"))).toMatch(/units\.0\.date_range: end is before start/);
  });

  it("rejects an unknown review status", () => {
    expect(caseError(ID, (c) => (c.review_status = "approved"))).toMatch(/review_status/);
  });

  it("rejects an id that differs from the filename", () => {
    expect(caseError(ID, (c) => (c.id = "vc-02-something-else"))).toMatch(/id: id vc-02-something-else does not match the filename/);
  });

  it("rejects a snapshot match that is not a labeled match", () => {
    expect(
      snapError("gs-sparse-sofia-openai", (s) => s.approved_matches.push({ experience_unit_id: "u_b2b_pivot", job_requirement_unit_id: "r_ts_react_web" })),
    ).toMatch(/approved_matches\.5: u_b2b_pivot:r_ts_react_web is not in .*expected_top_matches/);
  });

  it("rejects a requirement that is not verbatim in the JD", () => {
    expect(snapError("gs-sparse-sofia-openai", (s) => (s.requirements[0].raw_text = "Expert in Elm"))).toMatch(
      /requirements\.0\.raw_text: not a verbatim substring of jds\/openai-sse-fullstack-b2b-2026\.txt/,
    );
  });
});

describe("referenced fixture files (shape-checked, file and path named)", () => {
  const real = (p: string): string => readFileSync(join(FIXTURES_ROOT, p), "utf8");
  const replacing = (path: string, text: string) => (p: string): string => (p === path ? text : real(p));
  const ownerPath = `${OWNER_TRACES_DIR}/adversarial-fabrication.json`;
  const caseFile = "validation-cases/vc-14-adversarial-fabrication.json";

  function errorOf(run: () => unknown): Error {
    try {
      run();
    } catch (err) {
      return err as Error;
    }
    throw new Error("expected a rejection");
  }

  it("names the referencing file and field when the owner file is not JSON", () => {
    const e = errorOf(() => parseValidationCase(rawCase("vc-14-adversarial-fabrication"), caseFile, replacing(ownerPath, "{ not json")));
    expect(e).toBeInstanceOf(FixtureError);
    expect(e.message).toMatch(new RegExp(`^${caseFile}: source\\.derived_from: referenced fixture ${ownerPath} is not valid JSON`));
  });

  it("rejects an owner file missing validator_must_flag as a FixtureError, not a TypeError", () => {
    const owner = JSON.parse(real(ownerPath)) as Record<string, unknown>;
    delete owner.validator_must_flag;
    const e = errorOf(() => parseValidationCase(rawCase("vc-14-adversarial-fabrication"), caseFile, replacing(ownerPath, JSON.stringify(owner))));
    expect(e).toBeInstanceOf(FixtureError);
    expect(e.message).toContain(`${caseFile}: source.derived_from: ${ownerPath}: validator_must_flag:`);
  });

  it("rejects an expected-matches file missing expected_requirements, and expected traces of the wrong shape", () => {
    const id = "gs-rich-nathan-google";
    const s = rawSnap(id) as { source: { expected_matches: string; expected_traces: string } };
    const file = `generation-snapshots/${id}.json`;
    const em = JSON.parse(real(s.source.expected_matches)) as Record<string, unknown>;
    delete em.expected_requirements;
    const e1 = errorOf(() => parseGenerationSnapshot(s, file, replacing(s.source.expected_matches, JSON.stringify(em))));
    expect(e1).toBeInstanceOf(FixtureError);
    expect(e1.message).toContain(`source.expected_matches: ${s.source.expected_matches}: expected_requirements:`);
    const e2 = errorOf(() => parseGenerationSnapshot(s, file, replacing(s.source.expected_traces, JSON.stringify({ expected_traces: [{}] }))));
    expect(e2).toBeInstanceOf(FixtureError);
    expect(e2.message).toContain(`source.expected_traces: ${s.source.expected_traces}: expected_traces.0.source_unit_ids:`);
  });

  it("parses the expected traces at load, so the run never re-reads them after the paid calls", () => {
    const rich = snaps.items.find((i) => i.snapshot.id === "gs-rich-nathan-google")!;
    const sparse = snaps.items.find((i) => i.snapshot.id === "gs-sparse-sofia-openai")!;
    expect(rich.expectedTraces!.length).toBeGreaterThan(0);
    expect(sparse.expectedTraces).toBeNull();
  });
});

describe("--case filtering", () => {
  it("loads only the named cases and refuses an unknown id", () => {
    expect(loadValidationCases({ ids: ["vc-04-wrong-metric-magnitude"] }).items).toHaveLength(1);
    expect(() => loadValidationCases({ ids: ["vc-99-nope"] })).toThrow(/unknown --case id/);
  });
});
