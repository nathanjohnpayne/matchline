/**
 * Snapshot drift: has anything the generation prompt rendered stopped
 * being true while the model was writing (#485)?
 *
 * The persist transaction already re-checks the Requirement set
 * (`requirementSetToken`) and that every cited Unit still has a live
 * approved match (`findStaleGroundingId`). This covers the rest of the
 * rendered input, re-read inside the same transaction:
 *
 *   - the Role's title;
 *   - every rendered Unit: still loaded by the approved-Units query
 *     (owned, approved), still in `approved_unit_ids`, and at the same
 *     evidence version, i.e. the model read text that still exists;
 *   - every rendered approved link: still live and approved.
 *
 * Additions never count: a newly approved match, a newly eligible Unit
 * or a new `approved_unit_ids` entry cannot make anything the model read
 * untrue, and refusing them would discard sound, paid work. Edits to
 * fields the model never saw (`business_outcomes`, timestamps) leave the
 * evidence version unchanged, so they do not count either.
 *
 * Pure, so the rules are unit-tested without Firestore.
 */

import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";
import { unitEvidenceVersion } from "../validation/unitEvidenceVersion.js";

import { liveApprovedMatchesOf } from "./pipeline.js";
import { renderedLinksOf, type GenerationSnapshot } from "./resumeInput.js";

export interface LiveGenerationState {
  /** Live role title; `undefined` when the Role doc is missing or owned by someone else. */
  readonly roleTitle: string | undefined;
  /** The Application's live `approved_unit_ids`. */
  readonly approvedUnitIds: readonly string[] | undefined;
  /** `approvedUnitsQuery` results for the snapshot's Unit ids. */
  readonly units: readonly ExperienceUnit[];
  readonly requirements: readonly JobRequirementUnit[];
  readonly approvedMatches: readonly UnitMatch[];
}

export type SnapshotDrift =
  | { readonly kind: "role_changed" }
  | { readonly kind: "role_title_changed" }
  | { readonly kind: "unit_withdrawn"; readonly unitId: string }
  | { readonly kind: "unit_edited"; readonly unitId: string }
  | {
      readonly kind: "link_withdrawn";
      readonly unitId: string;
      readonly requirementId: string;
    };

/** The first drift found (role, then Units by id, then links in order), or `null`. */
export function findSnapshotDrift(
  snapshot: GenerationSnapshot,
  live: LiveGenerationState,
): SnapshotDrift | null {
  if (live.roleTitle === undefined) return { kind: "role_changed" };
  if (live.roleTitle !== snapshot.roleTitle) return { kind: "role_title_changed" };

  const listed = new Set(live.approvedUnitIds ?? []);
  const renderedIds = Object.keys(snapshot.unitVersions).sort();
  for (const id of renderedIds) {
    const liveUnit = live.units.find((u) => u.id === id);
    if (liveUnit === undefined || !listed.has(id)) {
      return { kind: "unit_withdrawn", unitId: id };
    }
    if (unitEvidenceVersion(liveUnit) !== snapshot.unitVersions[id]) {
      return { kind: "unit_edited", unitId: id };
    }
  }

  const liveLinks = new Set(
    renderedLinksOf(
      liveApprovedMatchesOf(live.approvedMatches, live.requirements),
      new Set(renderedIds),
    ).map(([u, r]) => `${u}\u0000${r}`),
  );
  for (const [unitId, requirementId] of snapshot.links) {
    if (!liveLinks.has(`${unitId}\u0000${requirementId}`)) {
      return { kind: "link_withdrawn", unitId, requirementId };
    }
  }
  return null;
}
