/**
 * JD parsing pipeline. Composes:
 *
 *   paste + roleId
 *     → parseJobRequirements — LLM parse + retry + cost
 *     → embedMany             — OpenAI embeddings + cost
 *     → stamp embedding
 *     → atomic batch write   — Firestore WriteBatch (all-or-none)
 *     → JobRequirementUnit[]  (returned)
 *
 * Mirrors `extraction/pipeline.ts` — same atomic-batch persist
 * discipline so a mid-batch Firestore failure can't leave partial
 * Requirements under a Role (which would corrupt the matcher's
 * view of that Role's ask set).
 */

import { embedMany } from "../llm/embeddings.js";
import type { JobRequirementUnit } from "../types/capability.js";

import { getAdminDb } from "../firestore/admin.js";
import { parseJobRequirements, type JdParsingContext } from "./jd.js";

const COLLECTION = "jobRequirementUnits";

export interface JdPipelineDeps {
  readonly parse?: typeof parseJobRequirements;
  readonly embed?: typeof embedMany;
  /**
   * Persist. MUST perform a clear-and-replace keyed on
   * `(ownerUid, roleId)` — even when `units.length === 0`, stale
   * Requirements from a prior parse must be cleared so re-parsing
   * a Role that now yields zero Requirements doesn't leave stale
   * rows driving downstream matching.
   */
  readonly persistBatch?: (
    ctx: JdParsingContext,
    units: readonly JobRequirementUnit[],
  ) => Promise<void>;
}

export async function runJdParsingPipeline(
  text: string,
  ctx: JdParsingContext,
  deps: JdPipelineDeps = {},
): Promise<JobRequirementUnit[]> {
  const parse = deps.parse ?? parseJobRequirements;
  const embed = deps.embed ?? embedMany;
  const persistBatch = deps.persistBatch ?? writeRequirementsAsBatch;

  const units = await parse(text, ctx);

  // Do NOT short-circuit on `units.length === 0`. Re-parsing a Role
  // whose JD has been edited down to zero Requirements must still
  // clear the Role's previously-stored Requirements — otherwise
  // matching and gap detection operate on stale data. persistBatch
  // handles the empty case (it performs the clear without any new
  // writes).
  const embeddings =
    units.length === 0
      ? []
      : await embed(
          units.map((u) => u.normalized_requirement),
          { ownerUid: ctx.ownerUid },
        );

  if (embeddings.length !== units.length) {
    throw new Error(
      `Embedding count mismatch: ${embeddings.length} embeddings for ${units.length} requirements.`,
    );
  }

  const stamped: JobRequirementUnit[] = units.map((u, i) => ({
    ...u,
    embedding: embeddings[i],
  }));

  await persistBatch(ctx, stamped);

  return stamped;
}

/**
 * Atomic clear-and-replace keyed on (ownerUid, roleId). Re-parsing
 * the same Role (user edits the JD and re-submits) must not leave
 * stale Requirement Units from the prior parse — including the
 * case where the new parse yields zero Requirements. The clear pass
 * runs regardless of `units.length`.
 *
 * **Security: the clear query is scoped by BOTH role_id AND
 * owner_uid.** The admin SDK bypasses `firestore.rules`, so
 * scoping by role_id alone would let a caller submit another user's
 * role_id and cause cross-tenant deletion. Scoping by owner_uid
 * confines the clear to docs the caller owns; an attacker-submitted
 * role_id that points at someone else's Role produces zero matches
 * and the operation is a no-op on the victim's data. (See #74 for
 * the callable-level ownership precondition that also rejects the
 * attack up-front.)
 *
 * All operations land in one `WriteBatch.commit()` so the replace is
 * atomic: observers see either the old set or the new set, never a
 * mid-transition mix. V1 scale (tens of Requirements per Role) is
 * well under Firestore's 500-op batch limit; post-V1 we'll chunk.
 *
 * Caller contract: every `unit` must have `role_id === ctx.roleId`
 * AND `owner_uid === ctx.ownerUid`. The pipeline guarantees this
 * because it stamps both from `ctx` on every Unit. We sanity-check
 * as a belt-and-suspenders guard.
 */
async function writeRequirementsAsBatch(
  ctx: JdParsingContext,
  units: readonly JobRequirementUnit[],
): Promise<void> {
  const { roleId, ownerUid } = ctx;

  const allMatch = units.every(
    (u) => u.role_id === roleId && u.owner_uid === ownerUid,
  );
  if (!allMatch) {
    throw new Error(
      "writeRequirementsAsBatch: every unit must have role_id === " +
        "ctx.roleId and owner_uid === ctx.ownerUid. Found mismatched " +
        "values; this signals a pipeline bug; aborting.",
    );
  }

  const db = getAdminDb();
  const existing = await db
    .collection(COLLECTION)
    .where("role_id", "==", roleId)
    .where("owner_uid", "==", ownerUid)
    .get();

  // Nothing to do — skip the batch commit() round-trip.
  if (existing.docs.length === 0 && units.length === 0) return;

  const batch = db.batch();
  for (const doc of existing.docs) {
    batch.delete(doc.ref);
  }
  for (const u of units) {
    batch.set(db.collection(COLLECTION).doc(u.id), u);
  }
  await batch.commit();
}
