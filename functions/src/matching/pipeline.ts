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
 *     → persistBatch      (replace by (role, owner): overwrite each
 *                          pair's deterministic doc, delete orphans)
 *     → UnitMatch[]       (returned)
 *
 * Mirrors `parsing/pipeline.ts` — same DI shape, same (ownerUid,
 * roleId) replace-key. The critical invariant that drives the
 * persistence layer is that matching is **idempotent on the same
 * inputs**: re-running matching on a Role must replace the prior
 * match set — never union with it — even when the new run produces
 * zero matches (the empty case still clears stale rows so the Gaps
 * view in #21 doesn't read corrupt state).
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

import { createHash } from "node:crypto";

import type { DocumentReference } from "firebase-admin/firestore";

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

/**
 * Version stamped on every UnitMatch this pipeline writes (#444).
 *
 * Bump when a change alters what a reader may conclude from a
 * persisted row — not for every schema addition. Version 1 means:
 * `components` and `component_applicability` are present, and the
 * `rationale` was generated under #435's axis-gating, so it may be
 * shown to the user as a claim.
 *
 * `src/routes/RoleDetail/matchProvenance.ts` holds the reader's
 * copy of this number; `tests/match-schema-version.test.ts` is the
 * only tsconfig project spanning both packages and pins them
 * together. Same arrangement as the callable timeout tables.
 */
export const MATCH_SCHEMA_VERSION = 1;

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
  const now = deps.now ?? (() => new Date().toISOString());

  const [units, requirements] = await Promise.all([
    listUnits(ctx),
    listRequirements(ctx),
  ]);

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
        // Deterministic per (owner, Role, Unit, Requirement): a rerun
        // overwrites this pair's doc in place. See `matchDocId`.
        id: matchDocId(ctx.ownerUid, ctx.roleId, unit.id, requirement.id),
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
        // Declares what a reader may conclude from this row —
        // notably that `rationale` was generated under the
        // axis-gated rule and can be presented as a claim (#444).
        // Deliberately not carried forward: a rerun re-derives
        // everything, so it must stamp the current version.
        schema_version: MATCH_SCHEMA_VERSION,
        // Rationale + surface_evidence populated by #100's
        // deterministic generator. Cached on the doc so the
        // Matches tab (#21) doesn't re-render compute.
        rationale: rationaleResult.rationale,
        surface_evidence: rationaleResult.surface_evidence,
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
  // Filter out units with `reembed_pending: true` — their stored
  // embedding is invalid (set by an edit or manual insert; cleared
  // by the reembed callable at #84 after the embedding is
  // regenerated). Including them would feed a stale vector into
  // semanticSimilarity. CodeRabbit Major #2 on PR #104.
  //
  // Done as an in-memory filter rather than a Firestore
  // .where("reembed_pending", "==", false) for two reasons:
  //   1. The field is OPTIONAL — a unit that's never been
  //      re-embedded won't have it set, and Firestore's `==`
  //      doesn't match missing fields, so a query filter would
  //      drop fully-valid units. The negation (`!=`) requires a
  //      separate index AND still has the missing-field problem.
  //   2. V1 single-user data volume is small — the in-memory
  //      filter cost is negligible vs. the additional index
  //      complexity.
  return snap.docs
    .map((d) => d.data() as ExperienceUnit)
    .filter((unit) => unit.reembed_pending !== true);
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
 * Namespace for `matchDocId`'s name-based UUIDs. An arbitrary fixed
 * value: changing it re-keys every match on the next run (harmless —
 * the orphan pass deletes the old ids and flags carry forward by
 * pair — but pointless churn).
 */
const MATCH_ID_NAMESPACE = "3b0c9d6e-5f2a-4e7b-9c1d-8a4f6e2b7d53";

/**
 * Deterministic document id for the match of one (Unit, Requirement)
 * pair under one (owner, Role): an RFC 4122 version-5 (SHA-1,
 * name-based) UUID.
 *
 * **Why deterministic.** A rerun must overwrite the pair's existing
 * doc rather than delete it and write a new one. With random ids,
 * every rerun cost one delete per prior match plus one write per new
 * match — ~2N operations — which is what pushed a realistic Role
 * (≈22 Units × ≈15 Requirements ≈ 330 matches, so ≈660 ops) past the
 * single-transaction ceiling this module used to enforce. With stable
 * ids a steady-state rerun is N writes and deletes only true orphans.
 * It also keeps a match's id stable across reruns, so a client that
 * is approving a match while matching reruns addresses the same doc.
 *
 * **Why a UUID rather than `${unitId}__${reqId}`.** The data model
 * specifies UUID primary keys (`specs/matchline.md` § Data model),
 * and hashing the owner and Role into the name makes a collision with
 * another tenant's match impossible by construction rather than by
 * the argument that Unit and Requirement ids happen to be unique.
 * The name is a JSON array so no choice of separator can make two
 * different tuples encode the same string.
 */
export function matchDocId(
  ownerUid: string,
  roleId: string,
  unitId: string,
  requirementId: string,
): string {
  const ns = Buffer.from(MATCH_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const name = Buffer.from(
    JSON.stringify([ownerUid, roleId, unitId, requirementId]),
    "utf8",
  );
  const bytes = createHash("sha1").update(ns).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Upper bound on writes per commit (transaction or batch). Firestore
 * historically capped a commit at 500 writes; 400 keeps headroom
 * under that and under the request-size limit for match docs, which
 * carry rationale prose. Exported so tests can size fixtures past it.
 */
export const MATCH_WRITES_PER_COMMIT = 400;

function pairKey(unitId: string, requirementId: string): string {
  return `${unitId}::${requirementId}`;
}

type ApprovalFlags = { approved_for_use: boolean; user_rejected: boolean };

/**
 * Fold one stored match's review flags into an accumulator by
 * precedence `rejected` > `approved` > `none`, canonicalizing so a
 * rejection always forces `approved_for_use: false`.
 *
 * **Canonicalize with rejection winning.** The unified
 * `setMatchApprovalState` setter (cursor #133 r1) makes `(true, true)`
 * unrepresentable on the client write side, but a stale record or a
 * manual Firestore write could leave the contradictory shape in
 * storage. Without canonicalization it would survive carry-forward and
 * readers would disagree: the UI's `approvalStateOf` calls it
 * "rejected" while generation gates only on `approved_for_use === true`
 * and would CONSUME it (cursor CHANGES_REQUESTED round 3 on #133).
 *
 * **Fold, don't overwrite.** More than one stored doc can describe
 * the same pair — the pre-deterministic-id doc and the new one during
 * the first rerun after this change, or duplicates from an older
 * bug. Last-write-wins would let iteration order silently drop a
 * stored rejection, the exact invariant carry-forward exists for.
 */
function foldFlags(
  prev: ApprovalFlags | undefined,
  m: Pick<UnitMatch, "approved_for_use" | "user_rejected">,
): ApprovalFlags {
  const rejected = (prev?.user_rejected ?? false) || m.user_rejected === true;
  return {
    approved_for_use: rejected
      ? false
      : (prev?.approved_for_use ?? false) || m.approved_for_use === true,
    user_rejected: rejected,
  };
}

/**
 * Replace the persisted UnitMatch set for `(ownerUid, roleId)` with
 * `matches`, carrying the user's per-pair review decisions forward.
 *
 * **Shape.** Each match is written to its deterministic id
 * (`matchDocId`), so a rerun overwrites in place. Then every stored
 * match for `(owner, role)` whose id is not in the new set — a pair
 * that no longer exists, a match against a Requirement a re-parse
 * replaced, or a legacy random-id doc — is deleted. Writes and
 * deletes are chunked at `MATCH_WRITES_PER_COMMIT`, so the size of a
 * Role no longer has a ceiling. The previous version did the whole
 * delete-all-then-write-all in one transaction and threw above 450
 * ops, which a realistic Role reached on its second run.
 *
 * **Carry-forward is transactional per chunk.** Each write chunk runs
 * in a transaction that first reads every stored doc for the chunk's
 * pairs — the deterministic-id doc and any legacy doc for the same
 * pair — and folds their flags (`foldFlags`) into the new match. A
 * user approving or rejecting a match mid-run conflicts with that
 * transaction, which retries and picks the decision up, rather than
 * being silently overwritten with the value read at the start of the
 * run (cursor #133 r2 is why flags carry forward at all).
 *
 * **What is no longer atomic, and why that is acceptable.** Across
 * chunks, a reader can briefly observe some pairs rescored and others
 * not yet, and orphans are removed after the writes rather than in
 * the same commit. It can never observe a UNION of old and new
 * matches for the same pair — the failure the old single transaction
 * existed to prevent — because a pair has exactly one doc. The orphan
 * pass re-queries after the writes, so two overlapping runs converge
 * on the set of whichever run finishes last.
 *
 * **Empty input** still clears: no writes, and every stored match for
 * `(owner, role)` is an orphan. A Role whose Units were all rejected
 * must not keep showing matches against them.
 *
 * **Cross-tenant safety.** The admin SDK bypasses `firestore.rules`.
 * Every query is scoped by BOTH `owner_uid` and `role_id` (role_id is
 * denormalized onto each match for exactly this), so a caller can
 * never clear another owner's matches under a shared role id; the
 * callable also enforces role ownership up front (mirrors #19). Match
 * ids include the owner and Role in their hash, and a write chunk
 * refuses to overwrite a doc stamped with a different owner or Role.
 */
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

  // Key every incoming match by its deterministic id. The pipeline
  // already stamps it; re-deriving here keeps this function correct for
  // any caller and makes a duplicate pair a loud error instead of a
  // silent last-write-wins.
  const keyed = matches.map((m) => ({
    ...m,
    id: matchDocId(ownerUid, roleId, m.experience_unit_id, m.job_requirement_unit_id),
  }));
  const newIds = new Set(keyed.map((m) => m.id));
  if (newIds.size !== keyed.length) {
    throw new Error(
      "replaceMatchesForRole: the match set contains the same (Unit, Requirement) " +
        "pair more than once; this signals a pipeline bug; aborting.",
    );
  }

  const db = getAdminDb();
  const collection = db.collection(COLLECTION);
  const scopedQuery = collection
    .where("owner_uid", "==", ownerUid)
    .where("role_id", "==", roleId);

  // Legacy docs: stored matches for a pair whose id is NOT the pair's
  // deterministic id (random-id docs written before this change, or
  // duplicates). Their flags must carry forward, and they are deleted
  // by the orphan pass. Indexed by pair so each write chunk can re-read
  // exactly the ones it needs inside its transaction.
  const initial = await scopedQuery.get();
  const legacyRefsByPair = new Map<string, DocumentReference[]>();
  for (const doc of initial.docs) {
    const m = doc.data() as UnitMatch;
    const key = pairKey(m.experience_unit_id, m.job_requirement_unit_id);
    const expectedId = matchDocId(ownerUid, roleId, m.experience_unit_id, m.job_requirement_unit_id);
    if (doc.id === expectedId) continue;
    const refs = legacyRefsByPair.get(key) ?? [];
    refs.push(doc.ref);
    legacyRefsByPair.set(key, refs);
  }

  const merged: UnitMatch[] = [];
  for (let i = 0; i < keyed.length; i += MATCH_WRITES_PER_COMMIT) {
    const chunk = keyed.slice(i, i + MATCH_WRITES_PER_COMMIT);
    const chunkMerged = await db.runTransaction(async (tx) => {
      const readRefs: DocumentReference[] = [];
      for (const m of chunk) {
        readRefs.push(collection.doc(m.id));
        const legacy = legacyRefsByPair.get(
          pairKey(m.experience_unit_id, m.job_requirement_unit_id),
        );
        if (legacy !== undefined) readRefs.push(...legacy);
      }
      const snaps = await tx.getAll(...readRefs);

      const flagsByPair = new Map<string, ApprovalFlags>();
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const stored = snap.data() as UnitMatch;
        if (stored.owner_uid !== ownerUid || stored.role_id !== roleId) {
          // Only reachable via a deterministic-id collision with a doc
          // outside this (owner, role), which the owner- and
          // Role-namespaced hash rules out. Refuse rather than
          // overwrite another tenant's row.
          throw new Error(
            `replaceMatchesForRole: doc ${snap.id} is not scoped to this owner and Role; aborting.`,
          );
        }
        if (stored.approved_for_use || stored.user_rejected) {
          const key = pairKey(stored.experience_unit_id, stored.job_requirement_unit_id);
          flagsByPair.set(key, foldFlags(flagsByPair.get(key), stored));
        }
      }

      const out: UnitMatch[] = chunk.map((m) => {
        const prior = flagsByPair.get(
          pairKey(m.experience_unit_id, m.job_requirement_unit_id),
        );
        return prior !== undefined ? { ...m, ...prior } : m;
      });
      for (const m of out) {
        tx.set(collection.doc(m.id), m);
      }
      return out;
    });
    merged.push(...chunkMerged);
  }

  // Orphan pass. Re-query AFTER the writes so the deletion reflects the
  // store as this run leaves it, not as it found it.
  const after = await scopedQuery.get();
  const orphans = after.docs.filter((d) => !newIds.has(d.id));
  for (let i = 0; i < orphans.length; i += MATCH_WRITES_PER_COMMIT) {
    const batch = db.batch();
    for (const d of orphans.slice(i, i + MATCH_WRITES_PER_COMMIT)) {
      batch.delete(d.ref);
    }
    await batch.commit();
  }

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
