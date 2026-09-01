/**
 * The re-derivation trigger for legacy match evidence (#441),
 * extracted from the Role Detail container so it can be tested
 * without a React harness. Same pattern as `autoTriggerGate.ts`.
 *
 * ## What it is
 *
 * A stable string over **exactly** the inputs
 * `resolveMatchEvidence` reads. The container's effect keys on
 * it, so the derivation re-runs when — and only when — an answer
 * could actually have changed.
 *
 * ## Why not the obvious things
 *
 * **Not the raw arrays.** Approving or rejecting a match rewrites
 * `matches`'s identity on every click, and `units` changes on any
 * edit anywhere in the user's graph. Keying on those fires a
 * callable per keystroke.
 *
 * **Not the legacy match ids alone**, which is what this first
 * shipped as. A verdict depends on the linked Unit and
 * Requirement, not only on the match. When the reembed callable
 * clears a Unit's `reembed_pending`, or the user edits its
 * skills, or a Requirement is re-parsed under the same id, the
 * right answer changes while the id set does not — and the stale
 * verdict kept driving `computeGaps` until the route was
 * remounted. Codex P2 on PR #446.
 *
 * ## The rule for changing this
 *
 * A field belongs here if and only if `resolveMatchEvidence`
 * reads it. Adding one it ignores makes the panel re-derive for
 * changes that cannot alter a verdict; omitting one it reads
 * reintroduces the staleness above. `evidenceKey.test.ts` pins
 * both directions.
 *
 * `updated_at` stands in for the Unit's own scoring fields —
 * skills, tools, domains, seniority signals, date range — because
 * `services/experienceUnits.ts` bumps it on every write and the
 * caller is never allowed to set it. Requirements carry no such
 * field, so their constraining fields are listed explicitly.
 */

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";

function unitSignature(unit: ExperienceUnit | undefined): string {
  if (unit === undefined) return "-";
  return [
    unit.updated_at,
    unit.user_approved ? "a" : "",
    unit.reembed_pending === true ? "p" : "",
    // The LENGTH, not just presence: an in-place embedding
    // replacement at a different dimension makes the pair
    // unverifiable (`cosine()` throws), and collapsing every
    // non-empty vector to one token hid that. Codex P2 on PR #446.
    `e${unit.embedding?.length ?? 0}`,
  ].join("/");
}

function requirementSignature(
  requirement: JobRequirementUnit | undefined,
): string {
  if (requirement === undefined) return "-";
  return [
    requirement.category,
    requirement.seniority_level ?? "",
    requirement.keywords.join("|"),
    requirement.tools.join("|"),
    requirement.domains.join("|"),
    `e${requirement.embedding?.length ?? 0}`,
  ].join("/");
}

/**
 * Empty string when no match needs deriving — the container
 * treats that as "make no call at all", so a Role matched under
 * #435 or later costs nothing.
 */
export function legacyEvidenceKey(
  matches: readonly UnitMatch[],
  units: readonly ExperienceUnit[],
  requirements: readonly JobRequirementUnit[],
): string {
  const legacy = matches.filter((m) => m.structural_evidence === undefined);
  if (legacy.length === 0) return "";
  const unitById = new Map(units.map((u) => [u.id, u]));
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  return legacy
    .map(
      (m) =>
        // The two linked ids are part of the signature, not just
        // the documents they resolve to. `upsertMatch` can
        // repoint a match at a different Unit or Requirement
        // while keeping `match.id`, and if the replacement pair
        // happened to sign identically the container would skip
        // re-derivation and keep the old pair's verdict.
        // CodeRabbit on PR #446.
        `${m.id}>${m.experience_unit_id}>${m.job_requirement_unit_id}` +
        `~${unitSignature(unitById.get(m.experience_unit_id))}` +
        `~${requirementSignature(reqById.get(m.job_requirement_unit_id))}`,
    )
    .sort()
    .join(";");
}
