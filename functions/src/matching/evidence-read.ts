/**
 * The Firestore read side of the evidence derivation (#441).
 *
 * Split from `evidence.ts` so that module stays pure — it is the
 * shared decision, imported by both the matcher's write path and
 * this read path, and keeping it free of `getAdminDb` is what
 * makes the rule unit-testable without an emulator. This module
 * is the mirror of that: reads only, no decision of its own.
 *
 * Same layering as `runMatching.ts` → `pipeline.ts`: the callable
 * is a thin auth wrapper over a function that can be driven
 * directly from an emulator test.
 *
 * **Every query is owner-scoped.** The callable establishes that
 * the caller owns the Role before getting here, but the admin
 * SDK bypasses `firestore.rules` and these queries must not be
 * the weak link — same discipline as `replaceMatchesForRole`'s
 * clear query.
 *
 * **Nothing here writes.** That is the entire design difference
 * from #438, which re-ran the matcher on Role open and drew
 * eleven review findings, nine of them consequences of the
 * write alone.
 */

import { getAdminDb } from "../firestore/admin.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";
import type { MatchEvidence } from "../types/evidence.js";

import { deriveEvidenceForMatches } from "./evidence.js";

const UNITS_COLLECTION = "experienceUnits";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const MATCHES_COLLECTION = "unitMatches";

export interface ReadEvidenceContext {
  readonly ownerUid: string;
  readonly roleId: string;
}

/**
 * Read the Role's matches plus the Units and Requirements they
 * point at, and resolve every match to a verdict.
 *
 * Units are read **unfiltered**, unlike the matching pipeline's
 * `defaultListUnits`. The pipeline drops unapproved and
 * `reembed_pending` Units because it cannot score them; the
 * derivation needs to see them, because "the Unit exists but the
 * pipeline currently declines to score it" is the `unverifiable`
 * case and it must not be confused with "the Unit is gone".
 */
export async function readAndDeriveEvidence(
  ctx: ReadEvidenceContext,
): Promise<ReadonlyMap<string, MatchEvidence>> {
  const db = getAdminDb();
  const [unitSnap, requirementSnap, matchSnap] = await Promise.all([
    db.collection(UNITS_COLLECTION).where("owner_uid", "==", ctx.ownerUid).get(),
    db
      .collection(REQUIREMENTS_COLLECTION)
      .where("owner_uid", "==", ctx.ownerUid)
      .where("role_id", "==", ctx.roleId)
      .get(),
    db
      .collection(MATCHES_COLLECTION)
      .where("owner_uid", "==", ctx.ownerUid)
      .where("role_id", "==", ctx.roleId)
      .get(),
  ]);

  // `id` comes from the document id, not from the stored fields.
  //
  // `src/services/firestore.ts`'s converter strips `id` in
  // `toFirestore` — the document id is canonical — and puts it back
  // in `fromFirestore`. The admin SDK uses no converter, so
  // `d.data()` on anything written through a client service has no
  // `id` at all. Without this hydration the verdict map is keyed
  // `"undefined"`, the browser can never match it to a row, and the
  // whole derivation degrades silently to the permissive fallback:
  // a no-op that looks exactly like success. Codex P2 on PR #446.
  //
  // The emulator test could not have caught it, because its seeds
  // wrote `id` into the data like the server-side pipeline does.
  // `seedsWithoutId` in that suite now covers the client shape.
  return deriveEvidenceForMatches({
    units: unitSnap.docs.map(
      (d) => ({ ...(d.data() as ExperienceUnit), id: d.id }),
    ),
    requirements: requirementSnap.docs.map(
      (d) => ({ ...(d.data() as JobRequirementUnit), id: d.id }),
    ),
    matches: matchSnap.docs.map(
      (d) => ({ ...(d.data() as UnitMatch), id: d.id }),
    ),
  });
}
