/**
 * Frozen inputs for the generation and validation-subtask suites (#488).
 *
 * Two fixture kinds, both built only from the public fixtures under
 * `tests/fixtures/`:
 *
 * - **Validation cases** (`tests/fixtures/validation-cases/*.json`): one
 *   generated item, the Units it cites (plus any uncited distractor),
 *   and gold atomic assertions with support and specificity labels.
 * - **Generation snapshots** (`tests/fixtures/generation-snapshots/*.json`):
 *   Units, Requirements and approved matches frozen at the point the
 *   generation pipeline starts, so JD parsing and matching are not
 *   re-run.
 *
 * The loader refuses anything that could make a label wrong without
 * anyone noticing: a `raw_text` that is not verbatim from its resume or
 * JD, a support label citing an uncited Unit, a status inconsistent with
 * its assertions, a gold term the item text does not contain, or an
 * adversarial case that disagrees with the owner-labeled file it
 * derives from. Every error names the file and the JSON path.
 *
 * Loaded objects are deep-frozen.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { GenerationInputs } from "../../../functions/src/generation/pipeline.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../../functions/src/types/capability.ts";
import type { Role } from "../../../functions/src/types/crm.ts";

export const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
export const VALIDATION_CASES_DIR = "validation-cases";
export const GENERATION_SNAPSHOTS_DIR = "generation-snapshots";
export const OWNER_TRACES_DIR = "expected-asset-traces";
export const LABEL_LOCK_FILE = "eval-labels.lock.json";

/** Fixed timestamp stamped on every synthetic document. */
export const FIXED_ISO = "2026-01-01T00:00:00.000Z";

/**
 * The run date every eval prompt shows (`Today:` in traceability and
 * generation), so the inputs stay frozen and replay keys do not change
 * daily (#485 renders the date from the injected clock). Every fixture
 * Unit's `date_range` lies before it; the loader refuses one that does
 * not, so no fixture date reads as a future one. Recorded in each
 * `RunRecord` as `fixedRunDate`; runs with different dates are not
 * comparable.
 */
export const FIXED_RUN_DATE = "2026-01-15T00:00:00.000Z";
export const fixedRunClock = (): Date => new Date(FIXED_RUN_DATE);
export const EVAL_OWNER_UID = "eval-owner";

export const DRAFT_REVIEW_STATUS = "draft-pending-owner-review";
/** The `labeled_by` of every drafted label; never valid on an owner-reviewed file. */
export const DRAFT_LABELER = "claude-draft";
export const REVIEW_STATUSES = [DRAFT_REVIEW_STATUS, "owner-reviewed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Reads a fixture file by its path relative to `tests/fixtures/`. */
export type FixtureReader = (relPath: string) => string;

export const defaultReader: FixtureReader = (relPath) =>
  readFileSync(join(FIXTURES_ROOT, relPath), "utf8");

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

export function whitespaceNormalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Email, phone or URL: contact data never belongs in a Unit's raw_text. */
const CONTACT_DATA = /@|\+?\d[\d\s().-]{7,}\d|https?:\/\//;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// -- Schemas -------------------------------------------------------------------

const MetricSchema = z
  .object({
    claim: z.string().min(1),
    value: z.number().optional(),
    unit: z.string().optional(),
    direction: z.enum(["up", "down"]).optional(),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const FixtureUnitSchema = z
  .object({
    id: z.string().min(1),
    raw_text: z.string().min(1),
    normalized_summary: z.string().min(1),
    unit_type: z.enum(["project", "achievement", "ownership", "skill_demo", "leadership", "technical_decision"]),
    skills: z.array(z.string()),
    tools: z.array(z.string()),
    domains: z.array(z.string()),
    metrics: z.array(MetricSchema),
    seniority_signals: z.array(z.string()).default([]),
    scope_signals: z.array(z.string()).default([]),
    business_outcomes: z.array(z.string()).default([]),
    evidence_type: z.enum(["verified", "inferred", "user_confirmed"]).default("verified"),
    date_range: z.object({ start: IsoDateSchema, end: IsoDateSchema.optional() }).strict().optional(),
  })
  .strict();
export type FixtureUnit = z.infer<typeof FixtureUnitSchema>;

/** A gold term group: one string, or any-of alternatives. All groups must hold (AND). */
const TermGroupSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export type TermGroup = z.infer<typeof TermGroupSchema>;

export const VALIDATION_CATEGORIES = [
  "valid_paraphrase",
  "equivalent_numeric_notation",
  "swapped_employer_project",
  "wrong_metric_magnitude",
  "wrong_direction",
  "percent_vs_percentage_points",
  "unsupported_title",
  "unsupported_skill",
  "missing_cited_evidence",
  "vague_but_traceable",
  "cross_unit_fusion",
  "embedded_prompt_instructions",
  "multi_clause",
  "adversarial_fabrication",
  "date_drift",
] as const;

const LabelMetaShape = {
  review_status: z.enum(REVIEW_STATUSES),
  labeled_by: z.string().min(1),
  labeled_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  label_version: z.number().int().positive(),
};

/**
 * An owner-reviewed file carries the reviewing owner's own `labeled_by`:
 * flipping `review_status` alone on a draft must not drop the DRAFT
 * banner (#488 review).
 */
const ownerReviewedByOwner = (v: { readonly review_status: string; readonly labeled_by: string }): boolean =>
  !(v.review_status === "owner-reviewed" && v.labeled_by === DRAFT_LABELER);
const OWNER_REVIEW_RULE = {
  path: ["labeled_by"],
  message: `an "owner-reviewed" file needs the reviewing owner's labeled_by, not "${DRAFT_LABELER}"`,
};

export const GoldAssertionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    required_terms: z.array(TermGroupSchema).min(1),
    supported: z.boolean(),
    supporting_unit_ids: z.array(z.string()),
    specific: z.boolean().nullable(),
  })
  .strict();
export type GoldAssertion = z.infer<typeof GoldAssertionSchema>;

export const GoldRelationshipSchema = z
  .object({
    id: z.string().min(1),
    assertion_ids: z.array(z.string()).min(2),
    co_terms: z.array(TermGroupSchema).min(2),
  })
  .strict();
export type GoldRelationship = z.infer<typeof GoldRelationshipSchema>;

export const ValidationCaseSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^vc-\d{2}-[a-z0-9-]+$/),
    category: z.enum(VALIDATION_CATEGORIES),
    ...LabelMetaShape,
    source: z
      .object({
        resume_fixture_id: z.string().min(1),
        derived_from: z.string().nullable(),
      })
      .strict(),
    units: z.array(FixtureUnitSchema).min(1),
    item: z
      .object({
        id: z.string().min(1),
        section: z.enum(["summary", "experience", "skills"]),
        text: z.string().min(1),
        source_unit_ids: z.array(z.string()).min(1),
      })
      .strict(),
    gold: z
      .object({
        assertions: z.array(GoldAssertionSchema).min(1),
        relationships: z.array(GoldRelationshipSchema),
        expected_asset_status: z.enum(["passed", "failed"]),
      })
      .strict(),
    notes: z.string(),
  })
  .strict()
  .refine(ownerReviewedByOwner, OWNER_REVIEW_RULE);
export type ValidationCase = z.infer<typeof ValidationCaseSchema>;

const RequirementSchema = z
  .object({
    id: z.string().min(1),
    raw_text: z.string().min(1),
    normalized_requirement: z.string().min(1),
    category: z.enum(["skill", "tool", "domain", "experience_level", "scope", "soft_skill", "credential"]),
    keywords: z.array(z.string()),
    tools: z.array(z.string()),
    domains: z.array(z.string()),
    priority: z.enum(["high", "medium", "low"]),
    must_have: z.boolean(),
    extracted_from: z.enum(["responsibilities", "qualifications", "nice_to_have", "description"]),
  })
  .strict();
export type FixtureRequirement = z.infer<typeof RequirementSchema>;

export const GenerationSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^gs-(rich|sparse)-[a-z0-9-]+$/),
    evidence_density: z.enum(["rich", "sparse"]),
    ...LabelMetaShape,
    source: z
      .object({
        resume_fixture_id: z.string().min(1),
        jd_fixture_id: z.string().min(1),
        expected_matches: z.string().min(1),
        expected_traces: z.string().nullable(),
      })
      .strict(),
    role: z.object({ id: z.string().min(1), title: z.string().min(1), company_id: z.string().min(1) }).strict(),
    units: z.array(FixtureUnitSchema).min(1),
    requirements: z.array(RequirementSchema).min(1),
    approved_matches: z
      .array(
        z
          .object({ experience_unit_id: z.string().min(1), job_requirement_unit_id: z.string().min(1) })
          .strict(),
      )
      .min(1),
    /** 1 summary + 12 bullets + 10 skills + 3 education; dry-run projection only. */
    item_upper_bound: z.number().int().positive().default(26),
    notes: z.string(),
  })
  .strict()
  .refine(ownerReviewedByOwner, OWNER_REVIEW_RULE);
export type GenerationSnapshot = z.infer<typeof GenerationSnapshotSchema>;

// -- Lexical helpers shared with metrics.ts -----------------------------------

/**
 * NFKC, lowercase, unify dashes and curly quotes, collapse whitespace.
 * Used both by the loader (gold terms must be extractable from the item)
 * and by the coverage metrics, so the two can never disagree.
 */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function groupCovered(group: TermGroup, text: string): boolean {
  const alts = typeof group === "string" ? [group] : group;
  const hay = normalize(text);
  return alts.some((alt) => hay.includes(normalize(alt)));
}

// -- Validation ----------------------------------------------------------------

interface Issue {
  readonly path: string;
  readonly message: string;
}

function fail(file: string, issues: readonly Issue[]): never {
  throw new FixtureError(
    issues.map((i) => `${file}: ${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("\n"),
  );
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, file: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    fail(
      file,
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return parsed.data;
}

/** `JSON.parse`, with a parse error reported as a FixtureError naming the file. */
export function parseJsonText(text: string, relPath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new FixtureError(`${relPath}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJson(read: FixtureReader, relPath: string, file: string, path: string): unknown {
  let text: string;
  try {
    text = read(relPath);
  } catch {
    fail(file, [{ path, message: `referenced fixture ${relPath} does not exist` }]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    fail(file, [{ path, message: `referenced fixture ${relPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }]);
  }
}

/**
 * Read a referenced fixture and check its shape: every error names the
 * referencing file, the field that references it, and the JSON path
 * inside the referenced file.
 */
function readJsonAs<T>(schema: z.ZodType<T>, read: FixtureReader, relPath: string, file: string, path: string): T {
  const parsed = schema.safeParse(readJson(read, relPath, file, path));
  if (!parsed.success) {
    fail(
      file,
      parsed.error.issues.map((i) => ({
        path,
        message: `${relPath}: ${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
      })),
    );
  }
  return parsed.data;
}

// Shapes of the files a fixture references. Only the fields the loader
// reads are checked; other fields are allowed.
const ExpectedUnitsFileSchema = z.object({ expected_units: z.array(z.object({ id: z.string().min(1) })).optional() });

export const OwnerAdversarialSchema = z.object({
  adversarial_fabricated_claim: z.string().min(1),
  validator_must_flag: z.object({
    untraceable_claims: z.array(z.string()),
    expected_validation_status: z.enum(["passed", "failed"]),
  }),
});

export const ExpectedMatchesFileSchema = z.object({
  expected_requirements: z.array(z.object({ id: z.string().min(1) })),
  expected_top_matches: z.array(z.string()),
});

export const ExpectedTracesFileSchema = z.object({
  expected_traces: z.array(z.object({ source_unit_ids: z.array(z.string().min(1)) })),
});

function expectedUnitIds(read: FixtureReader, resumeId: string, file: string): Set<string> {
  const raw = readJsonAs(ExpectedUnitsFileSchema, read, `expected-units/${resumeId}.json`, file, "source.resume_fixture_id");
  return new Set((raw.expected_units ?? []).map((u) => u.id));
}

function checkUnits(
  units: readonly FixtureUnit[],
  resumeId: string,
  resumeText: string,
  read: FixtureReader,
  file: string,
  issues: Issue[],
): void {
  const known = expectedUnitIds(read, resumeId, file);
  const haystack = whitespaceNormalize(resumeText);
  const seen = new Set<string>();
  units.forEach((u, i) => {
    const p = `units.${i}`;
    if (seen.has(u.id)) issues.push({ path: `${p}.id`, message: `duplicate Unit id ${u.id}` });
    seen.add(u.id);
    if (!known.has(u.id)) {
      issues.push({ path: `${p}.id`, message: `${u.id} is not in expected-units/${resumeId}.json` });
    }
    if (!haystack.includes(whitespaceNormalize(u.raw_text))) {
      issues.push({ path: `${p}.raw_text`, message: `not a verbatim substring of resumes/${resumeId}.txt` });
    }
    if (CONTACT_DATA.test(u.raw_text)) {
      issues.push({ path: `${p}.raw_text`, message: "contains an email address, phone number or URL" });
    }
    if (u.date_range !== undefined) {
      const runDate = FIXED_RUN_DATE.slice(0, 10);
      const { start, end } = u.date_range;
      for (const [k, d] of [["start", start], ["end", end]] as const) {
        if (d !== undefined && d >= runDate) {
          issues.push({ path: `${p}.date_range.${k}`, message: `${d} is not before the fixed run date ${runDate}` });
        }
      }
      if (end !== undefined && end < start) issues.push({ path: `${p}.date_range`, message: "end is before start" });
    }
  });
}

function checkUnique(ids: readonly string[], path: string, issues: Issue[]): void {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) issues.push({ path: `${path}.${i}.id`, message: `duplicate id ${id}` });
    seen.add(id);
  });
}

/**
 * Validate one case. `raw` is the parsed JSON, `file` its path relative
 * to `tests/fixtures/` (used in every error and to check the id against
 * the filename).
 */
export function parseValidationCase(
  raw: unknown,
  file: string,
  read: FixtureReader = defaultReader,
): ValidationCase {
  const c = parseWith(ValidationCaseSchema, raw, file);
  const issues: Issue[] = [];
  const stem = file.split("/").pop()!.replace(/\.json$/, "");
  if (c.id !== stem) issues.push({ path: "id", message: `id ${c.id} does not match the filename ${stem}` });

  let resumeText: string;
  try {
    resumeText = read(`resumes/${c.source.resume_fixture_id}.txt`);
  } catch {
    fail(file, [{ path: "source.resume_fixture_id", message: `resumes/${c.source.resume_fixture_id}.txt does not exist` }]);
  }
  checkUnits(c.units, c.source.resume_fixture_id, resumeText, read, file, issues);
  checkUnique(c.gold.assertions.map((a) => a.id), "gold.assertions", issues);
  checkUnique(c.gold.relationships.map((r) => r.id), "gold.relationships", issues);

  const unitIds = new Set(c.units.map((u) => u.id));
  const cited = new Set(c.item.source_unit_ids);
  c.item.source_unit_ids.forEach((id, i) => {
    if (!unitIds.has(id)) issues.push({ path: `item.source_unit_ids.${i}`, message: `${id} is not a Unit in this case` });
  });

  c.gold.assertions.forEach((a, i) => {
    const p = `gold.assertions.${i}`;
    if (!a.supported && a.supporting_unit_ids.length > 0) {
      issues.push({ path: `${p}.supporting_unit_ids`, message: "an unsupported assertion has no supporting Units" });
    }
    if (a.supported && a.supporting_unit_ids.length === 0) {
      issues.push({ path: `${p}.supporting_unit_ids`, message: "a supported assertion names its supporting Units" });
    }
    a.supporting_unit_ids.forEach((id, j) => {
      if (!cited.has(id)) {
        issues.push({
          path: `${p}.supporting_unit_ids.${j}`,
          message: `${id} is not cited by the item; support counts only from cited Units`,
        });
      }
    });
    a.required_terms.forEach((g, j) => {
      if (!groupCovered(g, c.item.text)) {
        issues.push({ path: `${p}.required_terms.${j}`, message: `${JSON.stringify(g)} is not in item.text` });
      }
    });
  });

  const assertionIds = new Set(c.gold.assertions.map((a) => a.id));
  c.gold.relationships.forEach((r, i) => {
    const p = `gold.relationships.${i}`;
    r.assertion_ids.forEach((id, j) => {
      if (!assertionIds.has(id)) issues.push({ path: `${p}.assertion_ids.${j}`, message: `no assertion ${id}` });
    });
    r.co_terms.forEach((g, j) => {
      if (!groupCovered(g, c.item.text)) {
        issues.push({ path: `${p}.co_terms.${j}`, message: `${JSON.stringify(g)} is not in item.text` });
      }
    });
  });

  // Mirrors computeStatus in validate.ts: any untraceable or vague claim fails the asset.
  const shouldFail = c.gold.assertions.some((a) => !a.supported || a.specific === false);
  if ((c.gold.expected_asset_status === "failed") !== shouldFail) {
    issues.push({
      path: "gold.expected_asset_status",
      message: `${c.gold.expected_asset_status} is inconsistent with the assertions (expected ${shouldFail ? "failed" : "passed"})`,
    });
  }

  if (c.category === "missing_cited_evidence") {
    const distractors = c.units.filter((u) => !cited.has(u.id));
    const proven = c.gold.assertions.some(
      (a) =>
        !a.supported &&
        distractors.some((u) => a.required_terms.every((g) => groupCovered(g, u.raw_text))),
    );
    if (!proven) {
      issues.push({
        path: "units",
        message:
          "missing_cited_evidence needs an uncited Unit whose raw_text carries every required term of an unsupported assertion",
      });
    }
  }

  if (c.category === "date_drift") {
    const dated = c.units.some((u) => cited.has(u.id) && u.date_range !== undefined);
    if (!dated || !c.gold.assertions.some((a) => !a.supported)) {
      issues.push({
        path: "units",
        message: "date_drift needs a cited Unit with a date_range and an unsupported assertion whose dates contradict it",
      });
    }
  }

  if (c.category === "adversarial_fabrication") {
    const expected = `${OWNER_TRACES_DIR}/adversarial-fabrication.json`;
    if (c.source.derived_from !== expected) {
      issues.push({ path: "source.derived_from", message: `must be ${expected}` });
    } else {
      const owner = readJsonAs(OwnerAdversarialSchema, read, expected, file, "source.derived_from");
      if (c.item.text !== owner.adversarial_fabricated_claim) {
        issues.push({ path: "item.text", message: "must equal the owner file's adversarial_fabricated_claim" });
      }
      if (c.gold.assertions.length !== owner.validator_must_flag.untraceable_claims.length) {
        issues.push({
          path: "gold.assertions",
          message: `the owner file lists ${owner.validator_must_flag.untraceable_claims.length} untraceable claims`,
        });
      }
      if (c.gold.assertions.some((a) => a.supported)) {
        issues.push({ path: "gold.assertions", message: "every owner-labeled fabrication is unsupported" });
      }
      if (c.gold.expected_asset_status !== owner.validator_must_flag.expected_validation_status) {
        issues.push({ path: "gold.expected_asset_status", message: "must equal the owner file's expected_validation_status" });
      }
    }
  }

  if (issues.length > 0) fail(file, issues);
  return c;
}

/** The expected traces a snapshot references, shape-checked. */
export function readExpectedTraces(
  read: FixtureReader,
  relPath: string,
  file: string,
): readonly { readonly source_unit_ids: readonly string[] }[] {
  return readJsonAs(ExpectedTracesFileSchema, read, relPath, file, "source.expected_traces").expected_traces;
}

export function parseGenerationSnapshot(
  raw: unknown,
  file: string,
  read: FixtureReader = defaultReader,
): GenerationSnapshot {
  const s = parseWith(GenerationSnapshotSchema, raw, file);
  const issues: Issue[] = [];
  const stem = file.split("/").pop()!.replace(/\.json$/, "");
  if (s.id !== stem) issues.push({ path: "id", message: `id ${s.id} does not match the filename ${stem}` });
  if (!s.id.startsWith(`gs-${s.evidence_density}-`)) {
    issues.push({ path: "evidence_density", message: `id ${s.id} does not match density ${s.evidence_density}` });
  }

  let resumeText: string;
  let jdText: string;
  try {
    resumeText = read(`resumes/${s.source.resume_fixture_id}.txt`);
    jdText = read(`jds/${s.source.jd_fixture_id}.txt`);
  } catch {
    fail(file, [{ path: "source", message: "resume or JD fixture does not exist" }]);
  }
  checkUnits(s.units, s.source.resume_fixture_id, resumeText, read, file, issues);
  checkUnique(s.requirements.map((r) => r.id), "requirements", issues);

  const em = readJsonAs(ExpectedMatchesFileSchema, read, s.source.expected_matches, file, "source.expected_matches");
  const labeledReqs = new Set(em.expected_requirements.map((r) => r.id));
  const labeledMatches = new Set(em.expected_top_matches);
  const jdHay = whitespaceNormalize(jdText);
  s.requirements.forEach((r, i) => {
    if (!labeledReqs.has(r.id)) {
      issues.push({ path: `requirements.${i}.id`, message: `${r.id} is not in ${s.source.expected_matches}` });
    }
    if (!jdHay.includes(whitespaceNormalize(r.raw_text))) {
      issues.push({ path: `requirements.${i}.raw_text`, message: `not a verbatim substring of jds/${s.source.jd_fixture_id}.txt` });
    }
  });

  const unitIds = new Set(s.units.map((u) => u.id));
  const reqIds = new Set(s.requirements.map((r) => r.id));
  s.approved_matches.forEach((m, i) => {
    const p = `approved_matches.${i}`;
    if (!unitIds.has(m.experience_unit_id)) issues.push({ path: `${p}.experience_unit_id`, message: `no Unit ${m.experience_unit_id}` });
    if (!reqIds.has(m.job_requirement_unit_id)) {
      issues.push({ path: `${p}.job_requirement_unit_id`, message: `no requirement ${m.job_requirement_unit_id}` });
    }
    const key = `${m.experience_unit_id}:${m.job_requirement_unit_id}`;
    if (!labeledMatches.has(key)) {
      issues.push({ path: p, message: `${key} is not in ${s.source.expected_matches} expected_top_matches` });
    }
  });

  if (s.source.expected_traces !== null) {
    const tr = readExpectedTraces(read, s.source.expected_traces, file);
    tr.forEach((t, i) => {
      for (const id of t.source_unit_ids) {
        if (!unitIds.has(id)) {
          issues.push({ path: "units", message: `expected trace ${i} cites ${id}, which is not a Unit in this snapshot` });
        }
      }
    });
  }

  if (issues.length > 0) fail(file, issues);
  return s;
}

// -- Runtime conversion -------------------------------------------------------

/** The runtime ExperienceUnit for a fixture Unit. Runtime id = mnemonic id. */
export function toExperienceUnit(
  f: FixtureUnit,
  resumeText: string,
  index: number,
): ExperienceUnit {
  const unit: ExperienceUnit = {
    id: f.id,
    owner_uid: EVAL_OWNER_UID,
    source_type: "resume",
    source_ref: `resume:${sha256Hex(resumeText)}:${index}`,
    raw_text: f.raw_text,
    normalized_summary: f.normalized_summary,
    unit_type: f.unit_type,
    skills: [...f.skills],
    tools: [...f.tools],
    domains: [...f.domains],
    seniority_signals: [...f.seniority_signals],
    scope_signals: [...f.scope_signals],
    business_outcomes: [...f.business_outcomes],
    metrics: f.metrics.map((m) => ({ ...m })),
    evidence_type: f.evidence_type,
    ...(f.date_range !== undefined && { date_range: { ...f.date_range } }),
    confidence_score: 1,
    user_approved: true,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
  return unit;
}

/**
 * The exact inputs `runGenerationPipeline`'s `loadInputs` returns for a
 * snapshot. If #485 changes `GenerationInputs`, typecheck fails here,
 * which is the intended single point of adaptation.
 */
export function toGenerationInputs(
  snapshot: GenerationSnapshot,
  resumeText: string,
  jdText: string,
): GenerationInputs {
  const role: Role = {
    id: snapshot.role.id,
    owner_uid: EVAL_OWNER_UID,
    company_id: snapshot.role.company_id,
    title: snapshot.role.title,
    jd_raw: jdText,
    discovered_at: FIXED_ISO,
  };
  const requirements: JobRequirementUnit[] = snapshot.requirements.map((r) => ({
    id: r.id,
    owner_uid: EVAL_OWNER_UID,
    role_id: role.id,
    raw_text: r.raw_text,
    normalized_requirement: r.normalized_requirement,
    category: r.category,
    keywords: [...r.keywords],
    tools: [...r.tools],
    domains: [...r.domains],
    priority: r.priority,
    must_have: r.must_have,
    extracted_from: r.extracted_from,
  }));
  const approvedMatches: UnitMatch[] = snapshot.approved_matches.map((m) => ({
    id: `m_${m.experience_unit_id}__${m.job_requirement_unit_id}`,
    owner_uid: EVAL_OWNER_UID,
    experience_unit_id: m.experience_unit_id,
    job_requirement_unit_id: m.job_requirement_unit_id,
    role_id: role.id,
    semantic_score: 0.8,
    rule_score: 0.8,
    final_score: 0.8,
    rationale: "",
    surface_evidence: "",
    approved_for_use: true,
    user_rejected: false,
    created_at: FIXED_ISO,
  }));
  return {
    units: snapshot.units.map((u, i) => toExperienceUnit(u, resumeText, i)),
    role,
    requirements,
    approvedMatches,
  };
}

// -- Loading --------------------------------------------------------------------

export interface FixtureFileInfo {
  readonly path: string;
  readonly sha256: string;
  readonly label_version: number;
  readonly review_status: string;
  readonly labeled_by: string;
}

export interface LoadedCase {
  readonly case: ValidationCase;
  readonly file: FixtureFileInfo;
  readonly resumeText: string;
  readonly units: readonly ExperienceUnit[];
}

export interface LoadedSnapshot {
  readonly snapshot: GenerationSnapshot;
  readonly file: FixtureFileInfo;
  readonly resumeText: string;
  readonly jdText: string;
  /** The referenced expected traces, parsed at load (before any request); null when the snapshot has none. */
  readonly expectedTraces: readonly { readonly source_unit_ids: readonly string[] }[] | null;
}

export interface LoadedSuiteFixtures<T> {
  readonly items: readonly T[];
  /** Every fixture file the suite reads, sorted by path, for hashes and the lock. */
  readonly files: readonly FixtureFileInfo[];
  readonly fixtureSetHash: string;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function listJson(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => `${dir}/${f}`);
}

function infoFor(relPath: string, text: string): FixtureFileInfo {
  const raw = parseJsonText(text, relPath) as Record<string, unknown>;
  return {
    path: relPath,
    sha256: sha256Hex(text),
    label_version: typeof raw.label_version === "number" ? raw.label_version : 1,
    review_status:
      typeof raw.review_status === "string"
        ? raw.review_status
        : raw.labeled_by === "nathanjohnpayne"
          ? "owner-reviewed"
          : "unreviewed",
    labeled_by: typeof raw.labeled_by === "string" ? raw.labeled_by : "unknown",
  };
}

/**
 * `sha256` of the sorted `"<path>\t<sha256>\n"` lines: two runs are
 * comparable only when this matches (a relabel changes it).
 */
export function fixtureSetHash(files: readonly FixtureFileInfo[]): string {
  const lines = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}\t${f.sha256}\n`)
    .join("");
  return `sha256:${sha256Hex(lines)}`;
}

function collectFiles(root: string, paths: Iterable<string>): FixtureFileInfo[] {
  const out = new Map<string, FixtureFileInfo>();
  for (const p of paths) {
    if (out.has(p)) continue;
    out.set(p, infoFor(p, readFileSync(join(root, p), "utf8")));
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function loadValidationCases(
  opts: { readonly root?: string; readonly ids?: readonly string[] } = {},
): LoadedSuiteFixtures<LoadedCase> {
  const root = opts.root ?? FIXTURES_ROOT;
  const read: FixtureReader = (p) => readFileSync(join(root, p), "utf8");
  const items: LoadedCase[] = [];
  const read_: string[] = [];
  for (const rel of listJson(root, VALIDATION_CASES_DIR)) {
    const text = read(rel);
    const c = parseValidationCase(parseJsonText(text, rel), rel, read);
    if (opts.ids !== undefined && !opts.ids.includes(c.id)) continue;
    const resumeText = read(`resumes/${c.source.resume_fixture_id}.txt`);
    read_.push(rel);
    if (c.source.derived_from !== null) read_.push(c.source.derived_from);
    items.push(
      deepFreeze({
        case: c,
        file: infoFor(rel, text),
        resumeText,
        units: c.units.map((u, i) => toExperienceUnit(u, resumeText, i)),
      }),
    );
  }
  assertIdsKnown(opts.ids, items.map((i) => i.case.id));
  const files = collectFiles(root, read_);
  return deepFreeze({ items, files, fixtureSetHash: fixtureSetHash(files) });
}

export function loadGenerationSnapshots(
  opts: { readonly root?: string; readonly ids?: readonly string[] } = {},
): LoadedSuiteFixtures<LoadedSnapshot> {
  const root = opts.root ?? FIXTURES_ROOT;
  const read: FixtureReader = (p) => readFileSync(join(root, p), "utf8");
  const items: LoadedSnapshot[] = [];
  const read_: string[] = [];
  for (const rel of listJson(root, GENERATION_SNAPSHOTS_DIR)) {
    const text = read(rel);
    const s = parseGenerationSnapshot(parseJsonText(text, rel), rel, read);
    if (opts.ids !== undefined && !opts.ids.includes(s.id)) continue;
    read_.push(rel, s.source.expected_matches);
    if (s.source.expected_traces !== null) read_.push(s.source.expected_traces);
    items.push(
      deepFreeze({
        snapshot: s,
        file: infoFor(rel, text),
        resumeText: read(`resumes/${s.source.resume_fixture_id}.txt`),
        jdText: read(`jds/${s.source.jd_fixture_id}.txt`),
        expectedTraces: s.source.expected_traces === null ? null : readExpectedTraces(read, s.source.expected_traces, rel),
      }),
    );
  }
  assertIdsKnown(opts.ids, items.map((i) => i.snapshot.id));
  const files = collectFiles(root, read_);
  return deepFreeze({ items, files, fixtureSetHash: fixtureSetHash(files) });
}

function assertIdsKnown(requested: readonly string[] | undefined, found: readonly string[]): void {
  if (requested === undefined) return;
  const unknown = requested.filter((id) => !found.includes(id));
  if (unknown.length > 0) throw new FixtureError(`unknown --case id(s): ${unknown.join(", ")}`);
}

// -- Label lock -----------------------------------------------------------------

export const LOCKED_DIRS = [VALIDATION_CASES_DIR, GENERATION_SNAPSHOTS_DIR, OWNER_TRACES_DIR] as const;

const LabelLockSchema = z
  .object({
    lock_version: z.literal(1),
    files: z.record(
      z.string(),
      z
        .object({
          review_status: z.string().min(1),
          history: z
            .array(z.object({ label_version: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict())
            .min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type LabelLock = z.infer<typeof LabelLockSchema>;

export const RELABEL_PROCEDURE =
  "Relabel procedure: edit the file and bump its label_version; append { label_version, sha256 } " +
  "to its history in tests/fixtures/eval-labels.lock.json; land it as a separately reviewed PR. " +
  "Runs with a different fixtureSetHash are not comparable.";

export function loadLabelLock(root: string = FIXTURES_ROOT): LabelLock {
  const text = readFileSync(join(root, LABEL_LOCK_FILE), "utf8");
  return parseWith(LabelLockSchema, parseJsonText(text, LABEL_LOCK_FILE), LABEL_LOCK_FILE);
}

/** Every file under the locked directories, with its label metadata. */
export function lockedFiles(root: string = FIXTURES_ROOT): FixtureFileInfo[] {
  return collectFiles(root, LOCKED_DIRS.flatMap((d) => listJson(root, d)));
}

/**
 * Problems between the lock and the files on disk; empty when they
 * agree. A label change without a lock entry, a lock entry without a
 * file, or a history that does not strictly increase is a problem.
 */
export function checkLabelLock(lock: LabelLock, files: readonly FixtureFileInfo[]): string[] {
  const problems: string[] = [];
  const onDisk = new Map(files.map((f) => [f.path, f]));
  for (const path of Object.keys(lock.files)) {
    if (!onDisk.has(path)) problems.push(`${path}: in the lock but not on disk`);
  }
  for (const f of files) {
    const entry = lock.files[f.path];
    if (entry === undefined) {
      problems.push(`${f.path}: not in the lock (sha256 ${f.sha256}). ${RELABEL_PROCEDURE}`);
      continue;
    }
    const last = entry.history[entry.history.length - 1]!;
    if (last.sha256 !== f.sha256) {
      problems.push(`${f.path}: content changed (now sha256 ${f.sha256}, lock ${last.sha256}). ${RELABEL_PROCEDURE}`);
    }
    if (last.label_version !== f.label_version) {
      problems.push(`${f.path}: label_version ${f.label_version} but the lock's latest is ${last.label_version}. ${RELABEL_PROCEDURE}`);
    }
    if (entry.review_status !== f.review_status) {
      problems.push(`${f.path}: review_status ${f.review_status} but the lock says ${entry.review_status}. ${RELABEL_PROCEDURE}`);
    }
    const versions = entry.history.map((h) => h.label_version);
    if (versions.some((v, i) => i > 0 && v <= versions[i - 1]!)) {
      problems.push(`${f.path}: history label_version must strictly increase`);
    }
    const shas = entry.history.map((h) => h.sha256);
    if (new Set(shas).size !== shas.length) problems.push(`${f.path}: history repeats a sha256`);
  }
  return problems;
}
