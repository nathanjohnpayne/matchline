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
 * Transactional clear-and-replace keyed on (ownerUid, roleId).
 * Re-parsing the same Role (user edits the JD and re-submits) must
 * not leave stale Requirement Units from the prior parse — even
 * under concurrent re-parse calls on the same Role, and even when
 * the new parse yields zero Requirements.
 *
 * **Concurrency: runs in a Firestore transaction.** A plain
 * read-then-WriteBatch is NOT safe under concurrent parses of the
 * same Role: two callers can each read the same pre-state, then
 * both delete it and write their own set, leaving a union of both
 * runs' new docs (Codex P1 round 4 on #19). The transaction
 * retries on contention so one run sees the other's commits as
 * part of its read set and cleanly replaces.
 *
 * **Security: the clear query is scoped by BOTH role_id AND
 * owner_uid.** The admin SDK bypasses `firestore.rules`, so
 * scoping by role_id alone would let a caller submit another user's
 * role_id and cause cross-tenant deletion. Scoping by owner_uid
 * confines the clear to docs the caller owns; an attacker-submitted
 * role_id that points at someone else's Role produces zero matches
 * and the operation is a no-op on the victim's data. (The callable
 * also enforces a role-ownership precondition up-front — see #19
 * PR commit ee4cb73.)
 *
 * V1 scale (tens of Requirements per Role) is well under
 * Firestore's 500-op transaction limit; post-V1 we'll chunk.
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
  await db.runTransaction(async (tx) => {
    const existingQuery = db
      .collection(COLLECTION)
      .where("role_id", "==", roleId)
      .where("owner_uid", "==", ownerUid);
    const existing = await tx.get(existingQuery);

    // Skip empty no-op transaction to avoid a pointless commit
    // round-trip. Firestore transactions still have to commit even
    // if they performed no writes; short-circuiting saves that.
    if (existing.docs.length === 0 && units.length === 0) return;

    for (const doc of existing.docs) {
      tx.delete(doc.ref);
    }
    for (const u of units) {
      tx.set(db.collection(COLLECTION).doc(u.id), u);
    }
  });
}
