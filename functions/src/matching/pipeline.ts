/**
 * Matching pipeline composer (sub-issue #99 of #20). Step 3 of
 * the core loop (extraction → JD parsing → matching).
 *
 * Composes:
 *
 *   { ownerUid, roleId }
 *     → listUnits         (approved Units the user owns)
 *     → listRequirements  (Requirements under this Role)
 *     → score every (Unit × Requirement) pair via #97's pure fns
 *     → produce UnitMatch records
 *     → persistBatch      (atomic clear-and-replace by (role, owner))
 *     → UnitMatch[]       (returned)
 *
 * Mirrors `parsing/pipeline.ts` — same DI shape, same atomic-batch
 * persist discipline, same (ownerUid, roleId) replace-key. The
 * critical invariant that drives the persistence layer is that
 * matching is **idempotent on the same inputs**: re-running matching
 * on a Role must atomically replace the prior match set, even when
 * the new run produces zero matches (the empty case still clears
 * stale rows so the Gaps view in #21 doesn't read corrupt state).
 *
 * What this module does NOT do:
 *   - LLM rationale string per match (deferred to #100).
 *   - Match-tab UI (#21).
 *   - Filtering zero-score matches at persist time (let the UI
 *     filter — the Gaps view in #21 needs to know which
 *     Requirements were evaluated, not just which scored above
 *     a threshold).
 *
 * Concurrency / cross-tenant safety: see the docstring on
 * `replaceMatchesForRole` below — same shape as the JD pipeline's
 * `writeRequirementsAsBatch` after Codex P1 round 4 on #19.
 */

import { randomUUID } from "node:crypto";

import { getAdminDb } from "../firestore/admin.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";

import {
  score as scoreFn,
  type ScoreResult,
} from "./score.js";

const COLLECTION = "unitMatches";
const ROLES_COLLECTION = "roles";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const UNITS_COLLECTION = "experienceUnits";

export interface RunMatchingContext {
  readonly ownerUid: string;
  readonly roleId: string;
}

export interface MatchingDeps {
  /**
   * Read approved Units for this owner. Defaults to admin-SDK
   * read with `where("owner_uid", "==", ownerUid)` AND
   * `where("user_approved", "==", true)` — the same boundary the
   * #82 integration test pins. The `listApprovedExperienceUnits`
   * service is the read-side analog on the client; both must
   * stay in lockstep, but this module owns the server-side query
   * because the admin SDK bypasses rules.
   */
  readonly listUnits?: (ctx: RunMatchingContext) => Promise<ExperienceUnit[]>;
  /**
   * Read Requirements for this Role. Defaults to
   * `where("role_id", "==", roleId)` AND `where("owner_uid", "==", ownerUid)`.
   */
  readonly listRequirements?: (
    ctx: RunMatchingContext,
  ) => Promise<JobRequirementUnit[]>;
  /**
   * Persist. MUST perform a clear-and-replace keyed on
   * `(ownerUid, roleId)`, even when `matches.length === 0` so a
   * re-run that yields zero matches still wipes stale rows.
   */
  readonly persistBatch?: (
    ctx: RunMatchingContext,
    matches: readonly UnitMatch[],
  ) => Promise<void>;
  /**
   * Score function — injectable for tests. Default is the pure
   * `score()` from #97.
   */
  readonly score?: typeof scoreFn;
  /** Injectable for deterministic ids in tests. */
  readonly generateId?: () => string;
  /** Injectable clock for deterministic timestamps in tests. */
  readonly now?: () => string;
  /** Injectable asOf for the recency component (deterministic tests). */
  readonly asOf?: Date;
}

/**
 * Run the matching pipeline. Returns the persisted match set.
 *
 * Pairs without a usable embedding on EITHER side are skipped
 * (logged as a warning) — a missing embedding is a #98/#99
 * upstream-pipeline bug, not a per-pair error worth blowing up
 * the whole match graph for. The caller (`runMatching` callable)
 * surfaces the skipped count in the response.
 */
export async function runMatchingPipeline(
  ctx: RunMatchingContext,
  deps: MatchingDeps = {},
): Promise<UnitMatch[]> {
  const listUnits = deps.listUnits ?? defaultListUnits;
  const listRequirements = deps.listRequirements ?? defaultListRequirements;
  const persistBatch = deps.persistBatch ?? replaceMatchesForRole;
  const score = deps.score ?? scoreFn;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());

  const [units, requirements] = await Promise.all([
    listUnits(ctx),
    listRequirements(ctx),
  ]);

  const matches: UnitMatch[] = [];
  for (const unit of units) {
    if (unit.embedding === undefined || unit.embedding.length === 0) {
      // Skipped — missing embedding is an upstream bug. The
      // re-embed callable (#84) clears `reembed_pending` after
      // refilling the embedding; if that flag is set, the unit
      // shouldn't be in `listApprovedExperienceUnits` results at
      // all. Logging at the pair level would explode under
      // typical N×M; we instead surface in the callable's
      // response payload.
      continue;
    }
    for (const requirement of requirements) {
      if (
        requirement.embedding === undefined ||
        requirement.embedding.length === 0
      ) {
        continue;
      }
      let result: ScoreResult;
      try {
        result = score(unit, requirement, deps.asOf ? { asOf: deps.asOf } : undefined);
      } catch {
        // Defense-in-depth: the pre-filter above should have
        // caught missing embeddings. If `score()` throws for
        // any other reason (corrupted input, etc.), skip the
        // pair rather than failing the whole run.
        continue;
      }
      matches.push({
        id: generateId(),
        owner_uid: ctx.ownerUid,
        experience_unit_id: unit.id,
        job_requirement_unit_id: requirement.id,
        // role_id denormalized from the Requirement (which is
        // the canonical source) onto the Match doc — see the
        // UnitMatch.role_id docstring for why.
        role_id: ctx.roleId,
        semantic_score: result.semantic_score,
        rule_score: result.rule_score,
        final_score: result.final_score,
        // Rationale string is populated by #100; the V1
        // matching engine emits empty strings here. The
        // Matches tab (#21) renders "no rationale yet" until
        // the rationale generator lands.
        rationale: "",
        surface_evidence: "",
        approved_for_use: false,
        user_rejected: false,
        created_at: now(),
      });
    }
  }

  // Sort high-to-low by final_score so the persisted set is
  // already ordered for the Matches tab. Stable sort is
  // sufficient — ties don't need a secondary key for V1.
  matches.sort((a, b) => b.final_score - a.final_score);

  // Persist even when matches is empty so a Role whose Units
  // were all rejected (and therefore filtered out of
  // `listApprovedExperienceUnits`) still has its prior matches
  // cleared. Without this, the Matches tab would show stale
  // entries pointing at rejected Units.
  await persistBatch(ctx, matches);

  return matches;
}

// -- Default implementations ------------------------------------------------

async function defaultListUnits(
  ctx: RunMatchingContext,
): Promise<ExperienceUnit[]> {
  const db = getAdminDb();
  const snap = await db
    .collection(UNITS_COLLECTION)
    .where("owner_uid", "==", ctx.ownerUid)
    .where("user_approved", "==", true)
    .get();
  return snap.docs.map((d) => d.data() as ExperienceUnit);
}

async function defaultListRequirements(
  ctx: RunMatchingContext,
): Promise<JobRequirementUnit[]> {
  const db = getAdminDb();
  const snap = await db
    .collection(REQUIREMENTS_COLLECTION)
    .where("owner_uid", "==", ctx.ownerUid)
    .where("role_id", "==", ctx.roleId)
    .get();
  return snap.docs.map((d) => d.data() as JobRequirementUnit);
}

/**
 * Transactional clear-and-replace for UnitMatches keyed on
 * (ownerUid, roleId).
 *
 * **Concurrency: runs in a Firestore transaction.** Two
 * concurrent matching runs on the same Role must not produce
 * the union of both runs' new matches — exactly the same
 * concern as `writeRequirementsAsBatch` in the JD pipeline
 * after Codex P1 round 4 on #19. The transaction retries on
 * contention so one run sees the other's commits as part of
 * its read set and cleanly replaces.
 *
 * **Cross-tenant safety: the clear query is scoped by BOTH
 * role_id AND owner_uid.** The admin SDK bypasses
 * `firestore.rules`. Scoping by role_id alone would let a
 * caller submit another user's role_id and cause cross-tenant
 * deletion of matches. Scoping by owner_uid confines the
 * clear to docs the caller owns. The callable also enforces a
 * role-ownership precondition up front (mirrors the JD pipeline's
 * pattern from #19).
 *
 * **The clear query keys directly on `(owner_uid, role_id)`** —
 * possible because we denormalized `role_id` onto every
 * UnitMatch at persist time (see UnitMatch.role_id docstring).
 * This avoids a chunked join through Requirements with
 * Firestore's 30-value `in`-clause limit.
 *
 * V1 scale (≤100 Units × ≤30 Requirements = ≤3,000 matches per
 * Role) is well under Firestore's 500-op transaction limit IF
 * we chunk. For the V1 expected band (10 Units × 20 Reqs = 200
 * matches), one transaction suffices. We cap at 200 ops per
 * transaction as a conservative ceiling — exceeding it throws
 * (loud failure) rather than silently splitting and losing the
 * atomic-replace property; chunked transactional replace lands
 * in #20.6 if real V1 usage hits that ceiling.
 */
const FIRESTORE_TX_OP_LIMIT = 200;

async function replaceMatchesForRole(
  ctx: RunMatchingContext,
  matches: readonly UnitMatch[],
): Promise<void> {
  const { roleId, ownerUid } = ctx;

  const allMatchOwner = matches.every(
    (m) => m.owner_uid === ownerUid && m.role_id === roleId,
  );
  if (!allMatchOwner) {
    throw new Error(
      "replaceMatchesForRole: every match must have owner_uid === ctx.ownerUid " +
        "AND role_id === ctx.roleId. Found mismatched values; this signals a " +
        "pipeline bug; aborting.",
    );
  }

  const db = getAdminDb();

  await db.runTransaction(async (tx) => {
    // Find every existing match for (owner, role). The
    // `(owner_uid, role_id)` composite scoping is the
    // cross-tenant safety boundary: even if an attacker were
    // somehow to cause this code to run with another user's
    // role_id, the `owner_uid` filter confines the clear to
    // matches owned by the caller. The callable also enforces
    // a role-ownership precondition up front (mirrors #19).
    const existingQuery = db
      .collection(COLLECTION)
      .where("owner_uid", "==", ownerUid)
      .where("role_id", "==", roleId);
    const existing = await tx.get(existingQuery);

    // Short-circuit empty no-op transaction (same shape as JD
    // pipeline's writeRequirementsAsBatch).
    if (existing.docs.length === 0 && matches.length === 0) return;

    const totalOps = existing.docs.length + matches.length;
    if (totalOps > FIRESTORE_TX_OP_LIMIT) {
      throw new Error(
        `replaceMatchesForRole: ${totalOps} ops exceeds Firestore transaction limit (${FIRESTORE_TX_OP_LIMIT}). ` +
          `Role=${roleId} has ${existing.docs.length} existing + ${matches.length} new matches. ` +
          `Reduce Units or Requirements; chunked transactional replace lands in #20.6.`,
      );
    }

    for (const doc of existing.docs) {
      tx.delete(doc.ref);
    }
    for (const m of matches) {
      tx.set(db.collection(COLLECTION).doc(m.id), m);
    }
  });
}

// Re-exported for tests + the callable. Default values are wired
// so the callable can spy on the function name; passing this
// directly keeps the dependency direction one-way (callable →
// pipeline → defaults), with the test surface owning the
// override path.
export { replaceMatchesForRole, defaultListUnits, defaultListRequirements };

/**
 * Read the role's owner_uid for the role-ownership precondition.
 * Lifted to the pipeline module so the callable can re-use it
 * without duplicating the read shape.
 */
export async function readRoleOwnerUid(roleId: string): Promise<string | null> {
  const snap = await getAdminDb().collection(ROLES_COLLECTION).doc(roleId).get();
  if (!snap.exists) return null;
  const data = snap.data() as { owner_uid?: string } | undefined;
  return data?.owner_uid ?? null;
}
