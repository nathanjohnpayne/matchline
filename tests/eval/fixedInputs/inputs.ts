/**
 * Input sets for `eval:fixed-inputs` (#648): the saved (record) Units and
 * Requirements of a flow, the labels used as inputs (gold), and the 2×2
 * of conditions built from them.
 *
 * ## Gold inputs
 *
 * "Gold" means the public labels themselves are fed to the matcher as
 * its input:
 *
 * - A gold Unit is an `expected_units` entry: its `id`, its
 *   `normalized_summary` (also used as `raw_text`), `skills`, `tools`
 *   and `domains`. The fields a label does not carry are constants that
 *   shift every gold Unit identically: confidence 1, no seniority or
 *   scope signals, no business outcomes or metrics, no date range.
 * - A gold Requirement is an `expected_requirements` entry: its `id`,
 *   its `text` (as both `raw_text` and `normalized_requirement`),
 *   `category` and `must_have` (priority `high` for a must-have, else
 *   `medium`). Labels carry no structure, so a gold Requirement has no
 *   keywords, tools, domains or seniority level: every structural axis
 *   of the scorer is unsignalled (neutral) on it.
 *
 * Gold sides map to label ids by identity; record and corrected sides
 * map through `mapUnitIds` / `mapRequirementIds` at the default 0.10
 * floor, exactly as `runForFixture` does.
 *
 * Pure: no I/O.
 */

import type { ExperienceUnit, JobRequirementUnit } from "../../../functions/src/types/capability.ts";

import type { FlowRecord } from "../flowRecord.ts";
import type { ExpectedMatchesFile, ExpectedRequirement, ExpectedUnit } from "../loadFixtures.ts";
import { mapRequirementIds, mapUnitIds } from "../mapping.ts";

export const GOLD_OWNER_UID = "eval-user";
export const GOLD_ROLE_ID = "eval-role";

/** The input a side of the 2×2 uses. `corrected` is an owner-corrected set (corrections.ts). */
export type SideKind = "record" | "gold" | "corrected";

export interface InputSet {
  readonly kind: SideKind;
  readonly units?: readonly ExperienceUnit[];
  readonly requirements?: readonly JobRequirementUnit[];
}

/** One matcher input: Units and Requirements without embeddings, plus their label maps. */
export interface Condition {
  /** `<units side>/<requirements side>`, e.g. `record/record`, `gold/gold`. */
  readonly name: string;
  readonly unitSide: SideKind;
  readonly requirementSide: SideKind;
  readonly units: readonly ExperienceUnit[];
  readonly requirements: readonly JobRequirementUnit[];
  readonly unitMap: ReadonlyMap<string, string>;
  readonly requirementMap: ReadonlyMap<string, string>;
}

export function goldUnits(expected: readonly ExpectedUnit[]): ExperienceUnit[] {
  return expected.map((u) => ({
    id: u.id,
    owner_uid: GOLD_OWNER_UID,
    source_type: "resume",
    source_ref: "gold",
    raw_text: u.normalized_summary,
    normalized_summary: u.normalized_summary,
    unit_type: "achievement",
    skills: [...u.skills],
    tools: [...(u.tools ?? [])],
    domains: [...(u.domains ?? [])],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: true,
    created_at: "",
    updated_at: "",
  })) as ExperienceUnit[];
}

export function goldRequirements(expected: readonly ExpectedRequirement[]): JobRequirementUnit[] {
  return expected.map((q) => ({
    id: q.id,
    owner_uid: GOLD_OWNER_UID,
    role_id: GOLD_ROLE_ID,
    raw_text: q.text,
    normalized_requirement: q.text,
    category: q.category,
    keywords: [],
    tools: [],
    domains: [],
    priority: q.must_have ? "high" : "medium",
    must_have: q.must_have,
    // Not a RequirementSource: marks the item as a label, never a parse.
    extracted_from: "gold",
  })) as unknown as JobRequirementUnit[];
}

function requireString(item: Record<string, unknown>, field: string, where: string): void {
  if (typeof item[field] !== "string" || item[field] === "") {
    throw new Error(`${where}: saved item has no ${field}`);
  }
}

/** The flow's saved Units, unchanged (records store them without `embedding`). */
export function recordUnits(flow: FlowRecord): ExperienceUnit[] {
  if (flow.units === null) throw new Error(`${flow.cell}#${flow.sampleIndex}: the flow saved no Units`);
  return flow.units.map((u, i) => {
    requireString(u, "id", `${flow.cell}#${flow.sampleIndex} unit ${i}`);
    requireString(u, "normalized_summary", `${flow.cell}#${flow.sampleIndex} unit ${i}`);
    return { ...u } as unknown as ExperienceUnit;
  });
}

/** The flow's saved Requirements, unchanged. */
export function recordRequirements(flow: FlowRecord): JobRequirementUnit[] {
  if (flow.requirements === null) {
    throw new Error(`${flow.cell}#${flow.sampleIndex}: the flow saved no Requirements`);
  }
  return flow.requirements.map((q, i) => {
    requireString(q, "id", `${flow.cell}#${flow.sampleIndex} requirement ${i}`);
    requireString(q, "normalized_requirement", `${flow.cell}#${flow.sampleIndex} requirement ${i}`);
    return { ...q } as unknown as JobRequirementUnit;
  });
}

export function identityMap(items: readonly { readonly id: string }[]): ReadonlyMap<string, string> {
  return new Map(items.map((x) => [x.id, x.id]));
}

/**
 * The conditions for one flow: {record, alternative Units} ×
 * {record, alternative Requirements}, with duplicates collapsed when an
 * alternative is `record`. Order: record/record first, then Units
 * varied, then Requirements varied, then both.
 */
export function buildConditions(
  record: { readonly units: readonly ExperienceUnit[]; readonly requirements: readonly JobRequirementUnit[] },
  alternatives: { readonly units: InputSet; readonly requirements: InputSet },
  labels: { readonly expectedUnits: readonly ExpectedUnit[]; readonly expectedMatches: ExpectedMatchesFile },
): Condition[] {
  const unitSides: InputSet[] = [{ kind: "record", units: record.units }];
  if (alternatives.units.kind !== "record") unitSides.push(alternatives.units);
  const reqSides: InputSet[] = [{ kind: "record", requirements: record.requirements }];
  if (alternatives.requirements.kind !== "record") reqSides.push(alternatives.requirements);

  const unitsFor = (side: InputSet): { units: readonly ExperienceUnit[]; map: ReadonlyMap<string, string> } => {
    if (side.kind === "gold") {
      const units = goldUnits(labels.expectedUnits);
      return { units, map: identityMap(units) };
    }
    const units = side.units;
    if (units === undefined) throw new Error(`${side.kind} Units side has no Units`);
    return { units, map: mapUnitIds(labels.expectedUnits, units) };
  };
  const requirementsFor = (
    side: InputSet,
  ): { requirements: readonly JobRequirementUnit[]; map: ReadonlyMap<string, string> } => {
    if (side.kind === "gold") {
      const requirements = goldRequirements(labels.expectedMatches.expected_requirements);
      return { requirements, map: identityMap(requirements) };
    }
    const requirements = side.requirements;
    if (requirements === undefined) throw new Error(`${side.kind} Requirements side has no Requirements`);
    return { requirements, map: mapRequirementIds(labels.expectedMatches.expected_requirements, requirements) };
  };

  const out: Condition[] = [];
  // Order: (record, record), (alt, record), (record, alt), (alt, alt).
  const order: Array<[InputSet, InputSet]> = [];
  for (const r of reqSides) for (const u of unitSides) order.push([u, r]);
  for (const [u, r] of order) {
    const us = unitsFor(u);
    const rs = requirementsFor(r);
    out.push({
      name: `${u.kind}/${r.kind}`,
      unitSide: u.kind,
      requirementSide: r.kind,
      units: us.units,
      requirements: rs.requirements,
      unitMap: us.map,
      requirementMap: rs.map,
    });
  }
  return out;
}

/** The texts the matcher embeds: each Unit's `normalized_summary`, each Requirement's `normalized_requirement`. */
export function textsToEmbed(conditions: readonly Condition[]): string[] {
  const out: string[] = [];
  for (const c of conditions) {
    for (const u of c.units) out.push(u.normalized_summary);
    for (const q of c.requirements) out.push(q.normalized_requirement);
  }
  return out;
}
