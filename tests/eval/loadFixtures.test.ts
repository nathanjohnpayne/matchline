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
});

// -- Matches loader -------------------------------------------------------

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
});
