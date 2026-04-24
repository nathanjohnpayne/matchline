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
  readonly persistBatch?: (units: readonly JobRequirementUnit[]) => Promise<void>;
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
  if (units.length === 0) return [];

  const embeddings = await embed(
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

  await persistBatch(stamped);

  return stamped;
}

/**
 * Atomic replace-by-(role_id, owner_uid) write. Re-parsing the same
 * Role (user edits the JD and re-submits) must not leave stale
 * Requirement Units from the prior parse. Without the delete pass,
 * `listRequirementsForRole(role_id)` would return old+new mixed,
 * corrupting match scoring and gap detection.
 *
 * **Security: the delete query is scoped by BOTH role_id AND
 * owner_uid.** The admin SDK bypasses `firestore.rules`, so
 * scoping by role_id alone would let a caller submit another user's
 * role_id and cause cross-tenant deletion of their Requirements
 * before the new batch writes. Scoping by owner_uid means the delete
 * only finds docs the caller actually owns; an attacker-submitted
 * role_id that points at someone else's Role produces zero matches
 * and the replace becomes a no-op on the victim's data. (A separate
 * guard at the callable level verifies role ownership up-front —
 * see #19's follow-on hardening.)
 *
 * All operations land in one `WriteBatch.commit()` so the replace is
 * atomic: observers see either the old set or the new set, never a
 * mid-transition mix. V1 scale (tens of Requirements per Role) is
 * well under Firestore's 500-op batch limit; post-V1 we'll chunk
 * when we approach it.
 *
 * Caller contract: all `units` must share the same `role_id` AND
 * `owner_uid` — the pipeline guarantees this because it stamps both
 * from `ctx` on every Unit. We sanity-check here as a
 * belt-and-suspenders guard.
 */
async function writeRequirementsAsBatch(
  units: readonly JobRequirementUnit[],
): Promise<void> {
  if (units.length === 0) return;

  const { role_id: roleId, owner_uid: ownerUid } = units[0]!;
  const allMatch = units.every(
    (u) => u.role_id === roleId && u.owner_uid === ownerUid,
  );
  if (!allMatch) {
    throw new Error(
      "writeRequirementsAsBatch: all units must share the same role_id " +
        "AND owner_uid — found mismatched values in the batch. This signals " +
        "a pipeline bug; aborting.",
    );
  }

  const db = getAdminDb();
  const existing = await db
    .collection(COLLECTION)
    .where("role_id", "==", roleId)
    .where("owner_uid", "==", ownerUid)
    .get();

  const batch = db.batch();
  for (const doc of existing.docs) {
    batch.delete(doc.ref);
  }
  for (const u of units) {
    batch.set(db.collection(COLLECTION).doc(u.id), u);
  }
  await batch.commit();
}
