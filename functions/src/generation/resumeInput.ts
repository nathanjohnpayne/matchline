/**
 * The real input of the resume generation prompt (#485), as a pure
 * function of what the pipeline loaded. No Firestore, no model.
 *
 * A `today:` line (the run date, `promptDate`) and then three tagged
 * sections, so the boundary between evidence and relevance is in the
 * structure and not only in the instructions. The date is outside the
 * Unit text, so it never changes an evidence version; the prompt uses it
 * only to treat a `date_range` end later than today as no end:
 *
 *   - `<candidate_evidence>`: each eligible Unit through the shared
 *     formatter (`../validation/unitPromptText.ts`), the same text the
 *     validator reads and the evidence version hashes;
 *   - `<target_role>`: the Role's title and every Requirement, with
 *     its id. It says what the employer wants, never what the
 *     candidate did;
 *   - `<approved_links>`: the approved Unit-to-Requirement pairs. A
 *     link says where a Unit is relevant; it adds no facts to it.
 *
 * Every value is JSON-quoted on a labelled line and every id goes
 * through `renderEntityId`, so no input value can start a line and
 * forge a section tag.
 *
 * Deliberately not rendered: match ids, scores and rationales (ids are
 * opaque to the model, and rationales are requirement-worded text that
 * would carry the role's wording back into the evidence), and the Role's
 * company, which is not loaded.
 *
 * `generationSnapshotOf` records what was rendered beyond the
 * Requirement set, so the persist transaction can refuse a resume whose
 * input changed while the model was writing it (`./snapshot.ts`). It
 * leaves out the run date on purpose: a date that moves on before the
 * persist only turns future ends into past ones, so the resume was
 * written under rules at least as strict as the persist-time date gives.
 */

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";
import { unitEvidenceVersion } from "../validation/unitEvidenceVersion.js";
import { formatUnitBlock, quote, renderEntityId } from "../validation/unitPromptText.js";

/** One rendered approved link: `[unit id, requirement id]`. */
export type GenerationLink = readonly [unitId: string, requirementId: string];

export interface ResumeInput {
  /** The run date, `YYYY-MM-DD` (`promptDate`). */
  readonly today: string;
  /** Eligible Units, sorted by id. */
  readonly units: readonly ExperienceUnit[];
  readonly roleTitle: string;
  /** All of the Role's Requirements (unfiltered), sorted by id. */
  readonly requirements: readonly JobRequirementUnit[];
  /** From `renderedLinksOf`. */
  readonly links: readonly GenerationLink[];
}

export interface GenerationSnapshot {
  readonly roleTitle: string;
  /** Every RENDERED Unit id → `unitEvidenceVersion` of the text the model saw. */
  readonly unitVersions: Readonly<Record<string, string>>;
  /** Every RENDERED link, sorted. */
  readonly links: readonly GenerationLink[];
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Live approved matches whose Unit is in `unitIds`, as deduped
 * `[unit, requirement]` pairs sorted by unit id, then requirement id
 * (code-unit order). Callers pass matches already filtered by
 * `liveApprovedMatchesOf`, so a match stranded by a re-parse never
 * reaches the prompt.
 */
export function renderedLinksOf(
  liveApprovedMatches: readonly UnitMatch[],
  unitIds: ReadonlySet<string>,
): readonly GenerationLink[] {
  const seen = new Set<string>();
  const links: GenerationLink[] = [];
  for (const m of liveApprovedMatches) {
    if (!unitIds.has(m.experience_unit_id)) continue;
    const key = `${m.experience_unit_id}\u0000${m.job_requirement_unit_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([m.experience_unit_id, m.job_requirement_unit_id]);
  }
  return links.sort((a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]));
}

/** Sort by id in code-unit order. Returns a new array. */
export function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => byCodeUnit(a.id, b.id));
}

function formatRequirement(r: JobRequirementUnit): string {
  const tag = r.must_have === true ? "MUST-HAVE" : "nice-to-have";
  return `[Requirement ${renderEntityId(r.id)}] [${tag}] ${quote(r.normalized_requirement ?? "")}`;
}

function formatLink([unitId, requirementId]: GenerationLink): string {
  return `[Unit ${renderEntityId(unitId)}] -> [Requirement ${renderEntityId(requirementId)}]`;
}

/** The real input block that follows the prompt's few-shot example. */
export function renderResumeInput(input: ResumeInput): string {
  return [
    "<input>",
    `today: ${quote(input.today)}`,
    "<candidate_evidence>",
    formatUnitBlock(input.units),
    "</candidate_evidence>",
    "<target_role>",
    `title: ${quote(input.roleTitle)}`,
    "requirements:",
    input.requirements.length > 0
      ? input.requirements.map(formatRequirement).join("\n")
      : "(no parsed requirements)",
    "</target_role>",
    "<approved_links>",
    input.links.length > 0 ? input.links.map(formatLink).join("\n") : "(none)",
    "</approved_links>",
    "</input>",
  ].join("\n");
}

/** What the rendered input showed beyond the Requirement set. */
export function generationSnapshotOf(input: ResumeInput): GenerationSnapshot {
  return {
    roleTitle: input.roleTitle,
    unitVersions: Object.fromEntries(input.units.map((u) => [u.id, unitEvidenceVersion(u)])),
    links: input.links,
  };
}
