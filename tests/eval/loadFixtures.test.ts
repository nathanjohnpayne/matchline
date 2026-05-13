/**
 * Loader-validation tests (#139 r1). The eval harness's
 * fixture readers are the trust boundary — a malformed
 * fixture should fail loudly with a descriptive message
 * rather than producing mysterious scoring errors mid-run.
 *
 * Critical pin: `expected_requirements` is REQUIRED and
 * non-empty. Without it, `mapRequirementIds` returns
 * all-unmapped and `topKOverlap` produces a false zero
 * even on a perfectly-working pipeline. cursor #139 r1
 * caught the prior optional-with-default-empty shape.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadExpectedMatches,
  loadExpectedUnits,
  loadJdText,
  loadResumeText,
} from "./loadFixtures.ts";

let fixturesDir: string;

beforeEach(() => {
  fixturesDir = mkdtempSync(join(tmpdir(), "matchline-eval-"));
  mkdirSync(join(fixturesDir, "resumes"), { recursive: true });
  mkdirSync(join(fixturesDir, "jds"), { recursive: true });
  mkdirSync(join(fixturesDir, "expected-units"), { recursive: true });
  mkdirSync(join(fixturesDir, "expected-matches"), { recursive: true });
});

afterEach(() => {
  rmSync(fixturesDir, { recursive: true, force: true });
});

function writeJson(path: string, content: unknown): void {
  writeFileSync(path, JSON.stringify(content), "utf8");
}

const validUnits = {
  fixture_id: "x",
  expected_units: [
    { id: "u_a", normalized_summary: "summary", skills: [] },
  ],
};

const validRequirement = {
  id: "r_a",
  text: "8 years of experience",
  must_have: true,
  category: "experience_level",
};

// -- Resume / JD text loaders ---------------------------------------------

describe("loadResumeText / loadJdText", () => {
  it("returns text when fixture exists", () => {
    writeFileSync(
      join(fixturesDir, "resumes", "alice.txt"),
      "real content",
      "utf8",
    );
    expect(loadResumeText("alice", { fixturesDir })).toBe("real content");
  });

  it("throws when resume fixture is empty (whitespace-only)", () => {
    writeFileSync(join(fixturesDir, "resumes", "blank.txt"), "   \n  ", "utf8");
    expect(() => loadResumeText("blank", { fixturesDir })).toThrow(/empty/);
  });

  it("throws when JD fixture is empty", () => {
    writeFileSync(join(fixturesDir, "jds", "blank.txt"), "", "utf8");
    expect(() => loadJdText("blank", { fixturesDir })).toThrow(/empty/);
  });
});

// -- Units loader ---------------------------------------------------------

describe("loadExpectedUnits", () => {
  it("loads a valid fixture", () => {
    writeJson(
      join(fixturesDir, "expected-units", "alice.json"),
      validUnits,
    );
    const file = loadExpectedUnits("alice", { fixturesDir });
    expect(file.fixture_id).toBe("x");
    expect(file.expected_units).toHaveLength(1);
  });

  it("throws on missing fixture_id", () => {
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      expected_units: [],
    });
    expect(() => loadExpectedUnits("alice", { fixturesDir })).toThrow(
      /fixture_id/,
    );
  });

  it("throws on missing required Unit fields", () => {
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      fixture_id: "x",
      expected_units: [{ id: "u_a" /* missing normalized_summary */ }],
    });
    expect(() => loadExpectedUnits("alice", { fixturesDir })).toThrow(
      /normalized_summary/,
    );
  });

  // -- cursor #139 r2 + CR Major: element-level typing --

  it("THROWS on non-string element in `skills` (cursor #139 r2)", () => {
    // Without element-level typing, a fixture like
    // `skills: [42]` would slip through and crash later
    // in `scoreUnitPair`'s `.toLowerCase()` call.
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      fixture_id: "x",
      expected_units: [
        {
          id: "u_a",
          normalized_summary: "summary",
          skills: ["valid", 42, "also-valid"],
        },
      ],
    });
    expect(() => loadExpectedUnits("alice", { fixturesDir })).toThrow(
      /skills\[1\].*must be a string/,
    );
  });

  it("THROWS on non-string element in `tools`", () => {
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      fixture_id: "x",
      expected_units: [
        {
          id: "u_a",
          normalized_summary: "summary",
          skills: [],
          tools: [null],
        },
      ],
    });
    expect(() => loadExpectedUnits("alice", { fixturesDir })).toThrow(
      /tools\[0\].*must be a string/,
    );
  });

  it("THROWS on non-string element in `domains`", () => {
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      fixture_id: "x",
      expected_units: [
        {
          id: "u_a",
          normalized_summary: "summary",
          skills: [],
          domains: [{ name: "object-not-string" }],
        },
      ],
    });
    expect(() => loadExpectedUnits("alice", { fixturesDir })).toThrow(
      /domains\[0\].*must be a string/,
    );
  });

  it("ACCEPTS optional `tools` / `domains` when undefined (back-compat)", () => {
    writeJson(join(fixturesDir, "expected-units", "alice.json"), {
      fixture_id: "x",
      expected_units: [
        { id: "u_a", normalized_summary: "summary", skills: [] },
      ],
    });
    const file = loadExpectedUnits("alice", { fixturesDir });
    expect(file.expected_units[0]!.tools).toBeUndefined();
    expect(file.expected_units[0]!.domains).toBeUndefined();
  });
});

// -- Matches loader -------------------------------------------------------

describe("loadExpectedMatches — k integer-and-positive validation (cursor #139 r2 + CR Major)", () => {
  it("ACCEPTS positive integer k", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    const file = loadExpectedMatches("alice", "role", { fixturesDir });
    expect(file.k).toBe(1);
  });

  it("THROWS on fractional k (the prior `typeof k === number` check let 1.5 through)", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1.5,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/positive integer/);
  });

  it("THROWS on NaN k (the prior `r.k < 1` check let NaN through because NaN < 1 is false)", () => {
    // We can't write NaN via JSON, but can simulate by
    // writing a non-numeric string that the loader treats
    // as the wrong type. NaN would only realistically appear
    // from a hand-mutated runtime object — Number.isInteger
    // pinned the type defensively.
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: "not-a-number",
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/positive integer/);
  });

  it("THROWS on zero / negative k", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 0,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/positive integer/);
  });
});

describe("loadExpectedMatches — composite ID format (CR Major)", () => {
  it("ACCEPTS valid '<u>:<r>' format", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_kepler:r_3yr_zero_to_one"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).not.toThrow();
  });

  it("THROWS on bare colon ':' (prior `entry.includes(':')` check let it through)", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: [":"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/exactly one colon/);
  });

  it("THROWS on missing right side 'u:'", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/exactly one colon/);
  });

  it("THROWS on multiple colons 'u:r:extra'", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a:oops"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/exactly one colon/);
  });
});

describe("loadExpectedMatches — k vs. expected_top_matches.length (cursor #138 r1)", () => {
  it("loads when k >= expected_top_matches.length", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 2,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    const file = loadExpectedMatches("alice", "role", { fixturesDir });
    expect(file.k).toBe(2);
  });

  it("THROWS when k < expected_top_matches.length (false-zero protection)", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a", "u_b:r_b"],
        expected_requirements: [validRequirement],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/k=1.*expected_top_matches.length=2/);
  });
});

describe("loadExpectedMatches — expected_requirements (cursor #139 r1)", () => {
  it("loads when expected_requirements is present + non-empty", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [validRequirement],
      },
    );
    const file = loadExpectedMatches("alice", "role", { fixturesDir });
    expect(file.expected_requirements).toHaveLength(1);
    expect(file.expected_requirements[0]!.id).toBe("r_a");
  });

  it("THROWS when expected_requirements is missing entirely (false-zero match-accuracy protection)", () => {
    // Without this guard, mapRequirementIds([], actualReqs)
    // returns every actual as `unmapped_<id>` and the
    // composite-string scorer returns 0 even if the
    // matching engine worked perfectly. Pin the loader's
    // fail-loud behavior.
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a"],
        // expected_requirements: missing
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/expected_requirements/);
  });

  it("THROWS when expected_requirements is empty array", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/non-empty/);
  });

  it("THROWS when an entry is missing required fields", () => {
    writeJson(
      join(fixturesDir, "expected-matches", "alice__role.json"),
      {
        resume_fixture_id: "alice",
        jd_fixture_id: "role",
        k: 1,
        expected_top_matches: ["u_a:r_a"],
        expected_requirements: [
          { id: "r_a" /* missing text/category/must_have */ },
        ],
      },
    );
    expect(() =>
      loadExpectedMatches("alice", "role", { fixturesDir }),
    ).toThrow(/text/);
  });

  // CodeRabbit Nitpick on PR #139: pin rejection of empty-string
  // values for the required fields. Without this, a fixture like
  // `{ id: "", text: "...", category: "..." }` would slip past the
  // typeof check and break ID resolution downstream in
  // `check_fixture_match_ids` and `mapping.ts`.
  for (const field of ["id", "text", "category"] as const) {
    it(`THROWS when an entry's "${field}" is the empty string`, () => {
      const requirement: Record<string, unknown> = { ...validRequirement };
      requirement[field] = "";
      writeJson(
        join(fixturesDir, "expected-matches", "alice__role.json"),
        {
          resume_fixture_id: "alice",
          jd_fixture_id: "role",
          k: 1,
          expected_top_matches: ["u_a:r_a"],
          expected_requirements: [requirement],
        },
      );
      expect(() =>
        loadExpectedMatches("alice", "role", { fixturesDir }),
      ).toThrow(new RegExp(`non-empty string "${field}"`));
    });
  }
});
