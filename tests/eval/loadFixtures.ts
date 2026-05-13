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
  /**
   * Required since cursor #139 r1. Without it,
   * `mapRequirementIds([], actualReqs)` returns every
   * actual as `unmapped_<id>`, the composite-string
   * comparison falls through, and `topKOverlap` returns
   * 0 — a false zero that would make every fixture
   * trip the 80% match-accuracy gate even when the
   * matching engine worked perfectly. The loader now
   * fails loudly if the field is missing or empty.
   */
  readonly expected_requirements: readonly ExpectedRequirement[];
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
  // Array-AND-element typing per cursor #139 r2 + CR Major.
  // Without this, `skills: [42]` would slip through the
  // loader and crash later in `scoreUnitPair`'s
  // `tokenJaccard(... .toLowerCase()...)`. The loader is
  // the fail-loud boundary; element-level validation closes
  // the silent-crash window.
  const skills = validateStringArray(
    r.skills,
    `${filePath}.expected_units[${idx}].skills`,
  );
  const tools = r.tools === undefined
    ? undefined
    : validateStringArray(
        r.tools,
        `${filePath}.expected_units[${idx}].tools`,
      );
  const domains = r.domains === undefined
    ? undefined
    : validateStringArray(
        r.domains,
        `${filePath}.expected_units[${idx}].domains`,
      );
  return {
    id: r.id as string,
    normalized_summary: r.normalized_summary as string,
    skills,
    tools,
    domains,
  };
}

/**
 * Validate that `raw` is an array AND every element is a
 * string. Throws a descriptive error citing the first
 * non-string element's index. cursor #139 r2 + CR Major:
 * the loader is the fail-loud boundary; element-level
 * typing closes the silent-crash window in scoring code
 * that calls `.toLowerCase()` on the members.
 */
function validateStringArray(
  raw: unknown,
  pathDescription: string,
): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${pathDescription}: must be an array.`);
  }
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string") {
      throw new Error(
        `${pathDescription}[${i}]: must be a string, got ${typeof raw[i]}.`,
      );
    }
  }
  return raw as readonly string[];
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
  // cursor #139 r2 + CR Major: `Number.isInteger` rules
  // out NaN, Infinity, AND fractional values. The prior
  // `typeof r.k !== "number" || r.k < 1` accepted NaN
  // (NaN < 1 is false) and 1.5 (passes both checks)
  // despite the contract being positive integer.
  if (!Number.isInteger(r.k) || (r.k as number) < 1) {
    throw new Error(
      `${filePath}: "k" must be a positive integer (got ${JSON.stringify(r.k)}).`,
    );
  }
  // After the guard above, `r.k` is a positive integer.
  // Hoist to a typed local so callers (and the return
  // statement below) don't need to re-cast through `unknown`.
  const k: number = r.k as number;
  if (!Array.isArray(r.expected_top_matches)) {
    throw new Error(`${filePath}: missing array "expected_top_matches".`);
  }
  // CR Major: `entry.includes(":")` was too permissive —
  // `":"`, `"u:"`, and `"u:r:extra"` all passed and would
  // silently tank topKOverlap accuracy. Tighten to exactly
  // one colon with non-empty parts on both sides.
  const COMPOSITE_ID_PATTERN = /^[^:\s]+:[^:\s]+$/;
  const expected_top_matches = r.expected_top_matches.map(
    (entry, idx): string => {
      if (typeof entry !== "string" || !COMPOSITE_ID_PATTERN.test(entry)) {
        throw new Error(
          `${filePath}.expected_top_matches[${idx}]: must be a "<unit_id>:<requirement_id>" string ` +
            `with exactly one colon and non-empty, non-whitespace parts on both sides ` +
            `(got ${JSON.stringify(entry)}).`,
        );
      }
      return entry;
    },
  );
  // cursor #138 r1's catch — k must allow the gate to be
  // mathematically achievable.
  if (k < expected_top_matches.length) {
    throw new Error(
      `${filePath}: k=${k} < expected_top_matches.length=${expected_top_matches.length}. ` +
        `topKOverlap caps at k/expected — set k >= expected.length so the 0.80 gate is achievable. ` +
        `See tests/fixtures/expected-matches/README.md § Choosing k.`,
    );
  }
  // cursor #139 r1: `expected_requirements` is required.
  // Without it, the requirement-mapping step returns
  // all-unmapped and produces false-zero match accuracy
  // even on a perfectly-working pipeline. Better to fail
  // loud here than silently produce noise.
  if (!Array.isArray(r.expected_requirements)) {
    throw new Error(
      `${filePath}: missing array "expected_requirements". ` +
        `The harness needs labeled Requirements with stable IDs to map runtime UUIDs ` +
        `against; without them mapRequirementIds returns all-unmapped and topKOverlap ` +
        `produces a false zero. See tests/fixtures/expected-matches/README.md.`,
    );
  }
  if (r.expected_requirements.length === 0) {
    throw new Error(
      `${filePath}: "expected_requirements" must be non-empty. An empty list ` +
        `would map every runtime Requirement to "unmapped_<id>" and produce ` +
        `false-zero match accuracy.`,
    );
  }
  const expected_requirements = validateExpectedRequirements(
    r.expected_requirements,
    filePath,
  );

  return {
    resume_fixture_id: r.resume_fixture_id as string,
    jd_fixture_id: r.jd_fixture_id as string,
    k,
    expected_top_matches,
    expected_requirements,
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
      // CodeRabbit Nitpick on PR #139: reject empty strings too,
      // not just non-string types. An entry like `{ id: "" }` would
      // silently slip through the typeof check and break ID
      // resolution in `check_fixture_match_ids` and `mapping.ts`
      // (the loader is the fail-loud boundary; element-level rules
      // close the silent-crash window).
      if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
        throw new Error(
          `${filePath}.expected_requirements[${idx}]: missing non-empty string "${k}".`,
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
