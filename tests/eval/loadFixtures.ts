/**
 * Typed fixture loaders for the eval harness (#136).
 *
 * The fixture JSONs in `tests/fixtures/` carry the labeler's
 * curation: expected ExperienceUnits per resume, expected
 * Requirements + top-K matches per (resume, JD) pair, and
 * expected asset traces for the validator. This module
 * provides the load + validate boundary so a malformed
 * fixture fails the harness LOUDLY at startup rather than
 * producing mysterious scoring errors mid-run.
 *
 * Validation is intentionally minimal — Zod-style
 * schema-by-shape with throw-on-missing for required
 * fields. The eval harness ships before #137's corpus
 * expansion, so we'd rather fail-loud on a bad fixture
 * than tolerate it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ExpectedUnit {
  /**
   * Stable mnemonic ID assigned by the labeler. Used for
   * cross-file references in `expected-matches/` and
   * `expected-asset-traces/`. The runtime extraction
   * assigns random UUIDs; the harness's mapping module
   * (#136 `mapping.ts`) maps runtime UUIDs to these
   * mnemonics by content.
   */
  readonly id: string;
  readonly normalized_summary: string;
  readonly skills: readonly string[];
  readonly tools?: readonly string[];
  readonly domains?: readonly string[];
}

export interface ExpectedUnitFile {
  readonly fixture_id: string;
  readonly expected_units: readonly ExpectedUnit[];
}

export interface ExpectedRequirement {
  readonly id: string;
  readonly text: string;
  readonly must_have: boolean;
  readonly category: string;
}

export interface ExpectedMatchesFile {
  readonly resume_fixture_id: string;
  readonly jd_fixture_id: string;
  readonly k: number;
  readonly expected_top_matches: readonly string[];
  readonly expected_requirements?: readonly ExpectedRequirement[];
}

export interface FixturePaths {
  readonly fixturesDir: string;
}

const DEFAULT_FIXTURES_DIR = (): string =>
  join(process.cwd(), "tests", "fixtures");

/**
 * Read a resume fixture as plain text. Throws if the file
 * doesn't exist OR is empty.
 */
export function loadResumeText(
  fixtureId: string,
  paths: FixturePaths = { fixturesDir: DEFAULT_FIXTURES_DIR() },
): string {
  const filePath = join(paths.fixturesDir, "resumes", `${fixtureId}.txt`);
  const text = readFileSync(filePath, "utf8");
  if (text.trim().length === 0) {
    throw new Error(
      `loadResumeText: ${filePath} is empty. Resume fixtures must have content.`,
    );
  }
  return text;
}

/**
 * Read a JD fixture as plain text. Throws if missing or empty.
 */
export function loadJdText(
  fixtureId: string,
  paths: FixturePaths = { fixturesDir: DEFAULT_FIXTURES_DIR() },
): string {
  const filePath = join(paths.fixturesDir, "jds", `${fixtureId}.txt`);
  const text = readFileSync(filePath, "utf8");
  if (text.trim().length === 0) {
    throw new Error(
      `loadJdText: ${filePath} is empty. JD fixtures must have content.`,
    );
  }
  return text;
}

/**
 * Read + parse the expected ExperienceUnit labels for a
 * resume. Validates the schema shape; throws on missing
 * fields.
 */
export function loadExpectedUnits(
  fixtureId: string,
  paths: FixturePaths = { fixturesDir: DEFAULT_FIXTURES_DIR() },
): ExpectedUnitFile {
  const filePath = join(
    paths.fixturesDir,
    "expected-units",
    `${fixtureId}.json`,
  );
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateExpectedUnitFile(raw, filePath);
}

/**
 * Read + parse the expected matches for a (resume, JD) pair.
 * Validates schema; enforces `k >= expected_top_matches.length`
 * (cursor #138 r1's mathematical-impossibility catch).
 */
export function loadExpectedMatches(
  resumeFixtureId: string,
  jdFixtureId: string,
  paths: FixturePaths = { fixturesDir: DEFAULT_FIXTURES_DIR() },
): ExpectedMatchesFile {
  const filePath = join(
    paths.fixturesDir,
    "expected-matches",
    `${resumeFixtureId}__${jdFixtureId}.json`,
  );
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  return validateExpectedMatchesFile(raw, filePath);
}

// -- Validators -------------------------------------------------------------

function validateExpectedUnitFile(
  raw: unknown,
  filePath: string,
): ExpectedUnitFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath}: not a JSON object.`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.fixture_id !== "string") {
    throw new Error(`${filePath}: missing string "fixture_id".`);
  }
  if (!Array.isArray(r.expected_units)) {
    throw new Error(`${filePath}: missing array "expected_units".`);
  }
  const units = r.expected_units.map(
    (entry, idx): ExpectedUnit => validateExpectedUnit(entry, filePath, idx),
  );
  return {
    fixture_id: r.fixture_id,
    expected_units: units,
  };
}

function validateExpectedUnit(
  raw: unknown,
  filePath: string,
  idx: number,
): ExpectedUnit {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath}.expected_units[${idx}]: not an object.`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of ["id", "normalized_summary"] as const) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
      throw new Error(
        `${filePath}.expected_units[${idx}]: missing non-empty string "${k}".`,
      );
    }
  }
  if (!Array.isArray(r.skills)) {
    throw new Error(`${filePath}.expected_units[${idx}]: missing array "skills".`);
  }
  return {
    id: r.id as string,
    normalized_summary: r.normalized_summary as string,
    skills: r.skills as readonly string[],
    tools: Array.isArray(r.tools) ? (r.tools as readonly string[]) : undefined,
    domains: Array.isArray(r.domains)
      ? (r.domains as readonly string[])
      : undefined,
  };
}

function validateExpectedMatchesFile(
  raw: unknown,
  filePath: string,
): ExpectedMatchesFile {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${filePath}: not a JSON object.`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of ["resume_fixture_id", "jd_fixture_id"] as const) {
    if (typeof r[k] !== "string") {
      throw new Error(`${filePath}: missing string "${k}".`);
    }
  }
  if (typeof r.k !== "number" || r.k < 1) {
    throw new Error(`${filePath}: missing positive integer "k".`);
  }
  if (!Array.isArray(r.expected_top_matches)) {
    throw new Error(`${filePath}: missing array "expected_top_matches".`);
  }
  const expected_top_matches = r.expected_top_matches.map(
    (entry, idx): string => {
      if (typeof entry !== "string" || !entry.includes(":")) {
        throw new Error(
          `${filePath}.expected_top_matches[${idx}]: must be a "<unit_id>:<requirement_id>" string.`,
        );
      }
      return entry;
    },
  );
  // cursor #138 r1's catch — k must allow the gate to be
  // mathematically achievable.
  if (r.k < expected_top_matches.length) {
    throw new Error(
      `${filePath}: k=${r.k} < expected_top_matches.length=${expected_top_matches.length}. ` +
        `topKOverlap caps at k/expected — set k >= expected.length so the 0.80 gate is achievable. ` +
        `See tests/fixtures/expected-matches/README.md § Choosing k.`,
    );
  }
  return {
    resume_fixture_id: r.resume_fixture_id as string,
    jd_fixture_id: r.jd_fixture_id as string,
    k: r.k,
    expected_top_matches,
    expected_requirements: Array.isArray(r.expected_requirements)
      ? validateExpectedRequirements(r.expected_requirements, filePath)
      : undefined,
  };
}

function validateExpectedRequirements(
  raw: readonly unknown[],
  filePath: string,
): readonly ExpectedRequirement[] {
  return raw.map((entry, idx): ExpectedRequirement => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `${filePath}.expected_requirements[${idx}]: not an object.`,
      );
    }
    const r = entry as Record<string, unknown>;
    for (const k of ["id", "text", "category"] as const) {
      if (typeof r[k] !== "string") {
        throw new Error(
          `${filePath}.expected_requirements[${idx}]: missing string "${k}".`,
        );
      }
    }
    if (typeof r.must_have !== "boolean") {
      throw new Error(
        `${filePath}.expected_requirements[${idx}]: missing boolean "must_have".`,
      );
    }
    return {
      id: r.id as string,
      text: r.text as string,
      must_have: r.must_have,
      category: r.category as string,
    };
  });
}
