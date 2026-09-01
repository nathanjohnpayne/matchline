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

import { generateRationale as generateRationaleFn } from "./rationale.js";
import {
  score as scoreFn,
  type ScoreResult,
} from "./score.js";

const COLLECTION = "unitMatches";
const ROLES_COLLECTION = "roles";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const UNITS_COLLECTION = "experienceUnits";

/**
 * Refusal: an approved Unit is awaiting re-embedding, so a
 * replace would destroy review state.
 *
 * `defaultListUnits` excludes `reembed_pending` Units because
 * their stored vector is stale. But persistence is a wholesale
 * replace — every match for the Role is deleted and only this
 * run's are written — so running anyway deletes the excluded
 * Unit's matches with no replacements, and the carry-forward
 * that preserves `approved_for_use` / `user_rejected` has
 * nothing to carry them onto. The decisions are unrecoverable.
 *
 * **This check has to live here, not on the client.** The Role
 * Detail container also defers, but a client-side snapshot
 * check is a time-of-check/time-of-use race: another tab can
 * set `reembed_pending` between the check and this function's
 * read. The client guard is a UX fast path; this is the
 * correctness boundary. Codex P1 on PR #438.
 */
export class PendingReembedError extends Error {
  constructor(count: number) {
    super(
      `runMatchingPipeline: ${count} approved Unit(s) are awaiting re-embedding. ` +
        "Refusing to run, because the replace would delete their matches — and the " +
        "user's approve/reject decisions on those pairs — with no replacements to " +
        "carry the flags onto. Re-run once re-embedding completes.",
    );
    this.name = "PendingReembedError";
  }
}

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
   *
   * MAY return the AS-PERSISTED matches — for the default
   * impl this is `matches` with prior user-action flags
   * carried forward (see `replaceMatchesForRole`'s
   * carry-forward block, cursor #133 r2). The orchestrator
   * surfaces this as its return value so callers see the
   * persisted shape, not the pre-merge candidate shape.
   *
   * If a test mock returns `void`, the orchestrator falls
   * back to the input `matches` array. This keeps existing
   * test mocks (`vi.fn(async () => {})`) working without
   * a forced refactor — they exercise the
   * pre-carry-forward shape, which is fine for testing
   * the orchestrator's pre-persist contract.
   */
  readonly persistBatch?: (
    ctx: RunMatchingContext,
    matches: readonly UnitMatch[],
  ) => Promise<readonly UnitMatch[] | void>;
  /**
   * Score function — injectable for tests. Default is the pure
   * `score()` from #97.
   */
  readonly score?: typeof scoreFn;
  /**
   * Rationale generator — injectable for tests. Default is the
   * deterministic template-driven generator from #100. A future
   * LLM-driven follow-up swaps this dep without changing the
   * pipeline shape.
   */
  readonly generateRationale?: typeof generateRationaleFn;
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
): Promise<readonly UnitMatch[]> {
  const listUnits = deps.listUnits ?? defaultListUnits;
  const listRequirements = deps.listRequirements ?? defaultListRequirements;
  const persistBatch = deps.persistBatch ?? replaceMatchesForRole;
  const score = deps.score ?? scoreFn;
  const generateRationale = deps.generateRationale ?? generateRationaleFn;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());

  const [units, requirements] = await Promise.all([
    listUnits(ctx),
    listRequirements(ctx),
  ]);

  // Refuse BEFORE scoring, so a run that cannot safely persist
  // doesn't burn the work first. See PendingReembedError.
  //
  // Detected from the SAME read that produces the scorable set
  // rather than a second query, so the refusal and the exclusion
  // can't disagree about which Units are pending.
  const pendingReembed = units.filter(
    (u) => u.reembed_pending === true,
  ).length;
  if (pendingReembed > 0) throw new PendingReembedError(pendingReembed);

  // One id per run, stamped on every row it writes, so a client
  // can tell ITS replacement snapshot from a concurrent run's.
  // Codex P2 on #438.
  const runId = generateId();

  const matches: UnitMatch[] = [];
  // Track candidate-pair scoring outcomes so a wholesale-failure
  // run (e.g. a bad deploy where score() throws on every pair)
  // doesn't silently commit `[]` and wipe valid prior matches.
  // CodeRabbit Critical #1 on PR #104.
  let candidatePairs = 0;
  let scoreFailures = 0;
  for (const unit of units) {
    if (unit.embedding === undefined || unit.embedding.length === 0) {
      // Skipped — missing embedding is an upstream bug. The
      // re-embed callable (#84) clears `reembed_pending` after
      // refilling the embedding; if that flag is set, the unit
      // shouldn't be in `listApprovedExperienceUnits` results at
      // all (the default read filters reembed_pending units;
      // CodeRabbit Major #2 on PR #104). Logging at the pair
      // level would explode under typical N×M.
      continue;
    }
    for (const requirement of requirements) {
      if (
        requirement.embedding === undefined ||
        requirement.embedding.length === 0
      ) {
        continue;
      }
      candidatePairs += 1;
      let result: ScoreResult;
      let rationaleResult: ReturnType<typeof generateRationaleFn>;
      try {
        result = score(unit, requirement, deps.asOf ? { asOf: deps.asOf } : undefined);
        // Rationale generation is inside the same try/catch as
        // scoring: a bad Unit/Requirement payload or an
        // injected-dep failure in generateRationale must NOT
        // tear down the entire matching run for the role.
        // Treated identically to a score() failure — one bad
        // pair surfaces in the Gaps view (#21) instead of
        // wiping the match graph. Codex P1 + CodeRabbit Major
        // on PR #105.
        rationaleResult = generateRationale({
          components: result.components,
          unit,
          requirement,
        });
      } catch {
        // Defense-in-depth: the pre-filter above should have
        // caught missing embeddings. If score() OR
        // generateRationale throws for any other reason
        // (corrupted input, etc.), skip the pair rather than
        // failing the whole run.
        scoreFailures += 1;
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
        // Persist the 7 sub-components so the Matches tab's
        // sub-score breakdown tooltip (#21 / sub-issue #131)
        // can render without re-computing. Spread keeps the
        // type contract aligned with `ScoreComponents`'s
        // canonical shape in `../types/capability.ts`.
        components: { ...result.components },
        // Whether the Requirement constrained any axis the
        // engine could evaluate. Consumed by `computeGaps`
        // so a must-have with no evaluable signal can't be
        // reported as covered off neutral credit alone
        // (Codex P1 round 1 on PR #435).
        structural_evidence: result.structural_evidence,
        // Per-axis applicability, so the breakdown tooltip can
        // render an unevaluated axis as unavailable instead of
        // presenting its neutral as a measured score.
        component_applicability: { ...result.component_applicability },
        // Rationale + surface_evidence populated by #100's
        // deterministic generator. Cached on the doc so the
        // Matches tab (#21) doesn't re-render compute.
        rationale: rationaleResult.rationale,
        surface_evidence: rationaleResult.surface_evidence,
        approved_for_use: false,
        user_rejected: false,
        run_id: runId,
        created_at: now(),
      });
    }
  }

  // Sort high-to-low by final_score so the persisted set is
  // already ordered for the Matches tab. Stable sort is
  // sufficient — ties don't need a secondary key for V1.
  matches.sort((a, b) => b.final_score - a.final_score);

  // Wholesale-failure guard: if every candidate pair was
  // attempted and every one threw, the empty match set isn't
  // a real "no matches" — it's a scoring bug. Aborting before
  // persistBatch protects prior valid matches from being
  // wiped by a bad deploy. The "all-rejected" case (which
  // legitimately produces zero candidate pairs because there
  // are no units in `listApprovedExperienceUnits` results)
  // is unaffected: candidatePairs === 0, so this guard is a
  // no-op. CodeRabbit Critical #1 on PR #104.
  if (
    candidatePairs > 0 &&
    matches.length === 0 &&
    scoreFailures === candidatePairs
  ) {
    throw new Error(
      `runMatchingPipeline: scoring or rationale generation threw on every candidate pair ` +
        `(${scoreFailures}/${candidatePairs}); aborting persistBatch to avoid clearing ` +
        "prior valid matches. This is a scoring/rationale-code bug, not a normal-result-of-input.",
    );
  }

  // Persist even when matches is empty so a Role whose Units
  // were all rejected (and therefore filtered out of
  // `listApprovedExperienceUnits`) still has its prior matches
  // cleared. Without this, the Matches tab would show stale
  // entries pointing at rejected Units.
  // The default `replaceMatchesForRole` returns the
  // carry-forward-merged matches; test mocks may return
  // void, in which case fall back to the input shape (no
  // merge to surface).
  const persisted = await persistBatch(ctx, matches);
  return persisted ?? matches;
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
  // Returns `reembed_pending` Units too, deliberately.
  //
  // #104 filtered them here, because their stored vector is
  // stale and scoring against it would be wrong. But silently
  // dropping them let the run proceed and REPLACE the Role's
  // match set without them — deleting their matches, and the
  // user's approve/reject decisions on those pairs, with nothing
  // to carry the flags onto (Codex P1 on PR #438).
  //
  // The orchestrator now refuses the whole run when any are
  // present, which subsumes the filter: a pending Unit is never
  // scored, because nothing is scored. Surfacing them here is
  // what lets it see them.
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
 * V1 expected band: 10 Units × 20 Requirements = 200 matches
 * per Role. The replace flow does N deletes + N writes, so the
 * second-and-subsequent runs need 2× the per-run match count in
 * ops. Firestore's actual transaction op limit is 500; we cap
 * at 450 to leave headroom for the read query. Codex P1 on PR
 * #104 caught a prior 200-op cap that would have made the
 * second run on a 200-match Role fail (200 deletes + 200 writes
 * = 400 ops) — exactly the path users hit when they edit a Unit
 * and re-run matching.
 *
 * Exceeding 450 throws (loud failure) rather than silently
 * splitting and losing the atomic-replace property; chunked
 * transactional replace lands in #20.6 if real V1 usage hits
 * that ceiling.
 */
const FIRESTORE_TX_OP_LIMIT = 450;

async function replaceMatchesForRole(
  ctx: RunMatchingContext,
  matches: readonly UnitMatch[],
): Promise<readonly UnitMatch[]> {
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
  // Closure variable so the merged shape escapes the
  // transaction's scope and we can return it to the caller.
  let merged: readonly UnitMatch[] = matches;

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

    // Build a map of prior user-action flags by (Unit,
    // Requirement) pair so we can carry them forward across
    // the clear-and-replace. Without this, a user who
    // approves or rejects a specific match would see their
    // decision wiped on every rerun — a real bug cursor
    // CHANGES_REQUESTED round 2 on PR #133 caught after my
    // round-1 reply incorrectly cited the rejected-Unit
    // exclusion test (#82) as covering rejected Matches
    // (it doesn't).
    //
    // Carry forward BOTH flags symmetrically: if the user
    // approved a (Unit, Requirement) pair before, the new
    // match for the same pair stays approved; if they
    // rejected it, the new match stays rejected.
    //
    // **Canonicalize on carry-forward with rejection winning.**
    // The unified `setMatchApprovalState` setter (cursor #133
    // r1) makes `(true, true)` unrepresentable on the WRITE
    // side, but a stale pre-unified-setter record OR a manual
    // Firestore write could leave the contradictory shape in
    // storage. cursor CHANGES_REQUESTED round 3 caught the
    // remaining gap: without canonicalization, the persisted
    // (true, true) survives carry-forward and downstream
    // readers disagree — UI's `approvalStateOf` calls it
    // "rejected" (conservative default; computeGaps filters
    // it out) while generation gates only on
    // `approved_for_use === true` and would CONSUME it. The
    // canonical-on-carry-forward fix makes rejection durably
    // win at the storage layer, so the rerun heals any drift.
    //
    // Edge: if a previously rejected pair has NO new match
    // (e.g. embeddings changed and the pair didn't surface),
    // the pair simply disappears — the rejection is moot.
    const priorFlagsByPair = new Map<
      string,
      { approved_for_use: boolean; user_rejected: boolean }
    >();
    for (const doc of existing.docs) {
      const m = doc.data() as UnitMatch;
      // Only carry forward if at least one flag is non-default.
      // Defaults `false/false` means the user never touched the
      // match; no signal to preserve.
      if (m.approved_for_use || m.user_rejected) {
        const key = `${m.experience_unit_id}::${m.job_requirement_unit_id}`;
        // Canonicalize: if user_rejected is true, force
        // approved_for_use to false. Same conservative
        // interpretation as the read-side `approvalStateOf`
        // (cursor #133 r1) — once the user has rejected a
        // pair, that decision wins until they un-reject via
        // the unified setter.
        //
        // Fold duplicates by precedence (`rejected` > `approved`
        // > `none`) rather than last-write-wins. If Firestore
        // ever returns more than one doc for the same pair, a
        // blind `.set()` would let iteration order decide, which
        // could silently drop a stored rejection during a
        // rerun-triggered carry-forward — the exact invariant
        // this loop exists to preserve.
        const prev = priorFlagsByPair.get(key);
        priorFlagsByPair.set(key, {
          approved_for_use:
            prev?.user_rejected || m.user_rejected
              ? false
              : (prev?.approved_for_use ?? false) || m.approved_for_use,
          user_rejected: (prev?.user_rejected ?? false) || m.user_rejected,
        });
      }
    }

    // Apply prior flags onto the incoming matches BEFORE the
    // tx writes go out. Pure spread; doesn't mutate the
    // input array. Capture in the outer closure so we can
    // return the merged shape to the orchestrator (cursor
    // #133 r2: callers expect the returned matches to
    // reflect the persisted state, including flag
    // carry-forward).
    const matchesWithFlags: UnitMatch[] = matches.map((m) => {
      const key = `${m.experience_unit_id}::${m.job_requirement_unit_id}`;
      const prior = priorFlagsByPair.get(key);
      return prior !== undefined ? { ...m, ...prior } : m;
    });
    merged = matchesWithFlags;

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
    for (const m of matchesWithFlags) {
      tx.set(db.collection(COLLECTION).doc(m.id), m);
    }
  });

  return merged;
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
