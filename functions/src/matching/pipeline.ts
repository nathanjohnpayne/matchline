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

import { createHash, randomUUID } from "node:crypto";

import type { DocumentReference, Transaction } from "firebase-admin/firestore";

import { getAdminDb } from "../firestore/admin.js";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";

import { generateRationale as generateRationaleFn } from "./rationale.js";
import type { MatchingRunMarker } from "./runMarker.js";
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
  // With the default persist, claim the (owner, Role) run marker
  // BEFORE reading any input, so the run that was INVOKED last is the
  // one allowed to commit. Claiming at persist time instead let a slow
  // run that read pre-edit Units finish after, and overwrite, a faster
  // run that read the edit (Codex P1 on #501). An injected persist
  // (tests, the eval harness) manages its own concurrency.
  if (deps.persistBatch !== undefined) {
    return runMatchingWith(ctx, deps, deps.persistBatch);
  }
  const runId = await claimMatchingRun(ctx);
  try {
    return await runMatchingWith(ctx, deps, (c, m) =>
      replaceMatchesForRole(c, m, { runId }),
    );
  } catch (err) {
    // A failure before persist (scoring threw on every pair, an input
    // read failed) writes nothing, but the marker must still stop
    // saying "running" so the editor can tell a dead run from a live
    // one (#504).
    if (!(err instanceof MatchingRunSuperseded)) await markMatchingRunFailed(ctx, runId);
    throw err;
  }
}

async function runMatchingWith(
  ctx: RunMatchingContext,
  deps: MatchingDeps,
  persistBatch: NonNullable<MatchingDeps["persistBatch"]>,
): Promise<readonly UnitMatch[]> {
  const listUnits = deps.listUnits ?? defaultListUnits;
  const listRequirements = deps.listRequirements ?? defaultListRequirements;
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
  return nameUuid([ownerUid, roleId, unitId, requirementId]);
}

/**
 * RFC 4122 version-5 UUID of `parts` under `MATCH_ID_NAMESPACE`. The
 * name is the JSON encoding of the array, so no choice of separator
 * can make two different tuples collide.
 */
function nameUuid(parts: readonly string[]): string {
  const ns = Buffer.from(MATCH_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const name = Buffer.from(JSON.stringify(parts), "utf8");
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
 * Server-written collection holding one "latest matching run" marker
 * per (owner, Role). See `replaceMatchesForRole` § Overlapping runs,
 * and `./runMarker.ts` for its fields.
 *
 * Clients must not be able to write it: a client that rewrote or
 * deleted its marker mid-run would make the legitimate run look
 * superseded. `firestore.rules` lets the owner read it (so the editor
 * can report a run that died part-way, #504) and allows no write.
 */
export const MATCHING_RUNS_COLLECTION = "matchingRuns";

/** Doc id of the (owner, Role) run marker. */
export function matchingRunDocId(ownerUid: string, roleId: string): string {
  return nameUuid(["matching-run", ownerUid, roleId]);
}

/**
 * Thrown inside a commit when a newer run for the same (owner, Role)
 * has started. Caught by `replaceMatchesForRole`, which stops writing
 * and leaves the newer run to define the persisted set.
 */
export class MatchingRunSuperseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchingRunSuperseded";
  }
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
 * Every match is written to its pair's deterministic id
 * (`matchDocId`), so a rerun overwrites in place; stored matches whose
 * id is not in the new set — a pair that no longer exists, a match
 * against a Requirement a re-parse replaced, or a legacy random-id doc
 * — are orphans and are deleted. Empty input therefore clears the
 * Role: a Role whose Units were all rejected must not keep showing
 * matches against them.
 *
 * **One atomic transaction whenever it fits.** If the writes plus the
 * orphan deletes fit in `MATCH_WRITES_PER_COMMIT`, the whole
 * replacement — carry-forward read, writes, orphan deletes — is one
 * transaction, exactly as before this change: no reader ever sees a
 * partial set, a failure publishes nothing, and a concurrent
 * approve/reject conflicts and retries rather than being overwritten.
 * Deterministic ids are what make this cover realistic Roles: a rerun
 * of ~22 Units × ~15 Requirements is ~330 writes and no deletes,
 * where the old delete-all-then-write-all shape needed ~660 ops and
 * threw above 450 on every rerun.
 *
 * **Chunked only above that size** (a very large Role, or the first
 * rerun of a large Role after this change, when every legacy
 * random-id doc is an orphan). Each write chunk is a transaction that
 * re-reads the pair's current doc and any legacy doc for the same
 * pair, folds their flags forward (`foldFlags`), writes the new
 * match, and deletes the legacy doc in the same commit — so a
 * decision recorded on a legacy doc mid-run is either read by that
 * commit or conflicts with it, never silently deleted. Orphans are
 * then deleted in further transactions. What this path gives up is
 * cross-chunk atomicity: while it runs, and if it fails part-way, a
 * reader can see some pairs rescored and others not yet. It can never
 * see a union of old and new matches for one pair, because a pair has
 * exactly one doc, and the next successful run converges the set.
 * Each chunked commit marks the run marker `partial` and only a
 * completed run clears it, so the editor can tell the user a dead run
 * left the Role mixed and offer a re-run (#504, `./runMarker.ts`).
 *
 * **Overlapping runs.** Each run stamps a fresh `run_id` on the
 * (owner, Role) marker in `matchingRuns` — `runMatchingPipeline` does
 * so before reading its inputs, so invocation order decides — and
 * every commit — the
 * single transaction, each chunk, each orphan delete — re-reads that
 * marker and aborts with `MatchingRunSuperseded` if a newer run has
 * started since. A superseded run stops writing and returns; the
 * newest run's orphan pass removes whatever the older one had
 * written. Without this, two overlapping chunked runs could each
 * delete the other's writes as orphans and leave the intersection of
 * their sets.
 *
 * **Cross-tenant safety.** The admin SDK bypasses `firestore.rules`.
 * Every query is scoped by BOTH `owner_uid` and `role_id` (role_id is
 * denormalized onto each match for exactly this), so a caller can
 * never clear another owner's matches under a shared role id; the
 * callable also enforces role ownership up front (mirrors #19). Match
 * ids hash the owner and Role, and a chunk refuses to overwrite a doc
 * stamped with a different owner or Role.
 */
/** Options for `replaceMatchesForRole`. */
export interface ReplaceMatchesHooks {
  /**
   * The run marker this replacement commits under, claimed by
   * `runMatchingPipeline` before it read its inputs. Omitted by direct
   * callers, in which case the replacement claims a fresh one itself.
   */
  readonly runId?: string;
  /**
   * Test seam: lets an emulator test start a second run at the one
   * point where overlap matters (after a chunked run's writes, before
   * its orphan pass). Production never passes it.
   */
  readonly afterChunkedWrites?: () => Promise<void>;
}

function matchingRunRef(ctx: RunMatchingContext): DocumentReference {
  return getAdminDb()
    .collection(MATCHING_RUNS_COLLECTION)
    .doc(matchingRunDocId(ctx.ownerUid, ctx.roleId));
}

/**
 * Stamp a fresh `run_id` on the (owner, Role) marker and return it.
 * Last writer wins, which is the point: the most recently started run
 * is the one that may commit.
 *
 * `partial` carries forward from a run that did not complete: if an
 * earlier chunked run died part-way, the store still mixes runs until
 * some run completes, whatever this one goes on to do (#504). Read
 * and written in one transaction so a completion that lands between
 * the read and the write is not undone.
 */
export async function claimMatchingRun(ctx: RunMatchingContext): Promise<string> {
  const runId = randomUUID();
  const ref = matchingRunRef(ctx);
  await getAdminDb().runTransaction(async (tx) => {
    const prior = (await tx.get(ref)).data() as MatchingRunMarker | undefined;
    const marker: MatchingRunMarker = {
      owner_uid: ctx.ownerUid,
      role_id: ctx.roleId,
      run_id: runId,
      started_at: new Date().toISOString(),
      state: "running",
      partial: prior?.partial === true && (prior.state ?? "complete") !== "complete",
    };
    tx.set(ref, marker);
  });
  return runId;
}

/**
 * Record that run `runId` stopped without completing, if it is still
 * the current run. Best effort: the caller is already failing, and a
 * marker left at `running` reads as dead once the callable's timeout
 * has passed, so a failure here only delays the editor's notice.
 */
async function markMatchingRunFailed(ctx: RunMatchingContext, runId: string): Promise<void> {
  const ref = matchingRunRef(ctx);
  try {
    await getAdminDb().runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as MatchingRunMarker | undefined;
      if (current?.run_id !== runId) return;
      tx.update(ref, { state: "failed", failed_at: new Date().toISOString() });
    });
  } catch (err) {
    console.warn(`markMatchingRunFailed: could not mark run ${runId} failed`, err);
  }
}

async function replaceMatchesForRole(
  ctx: RunMatchingContext,
  matches: readonly UnitMatch[],
  hooks: ReplaceMatchesHooks = {},
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
  const keyed: UnitMatch[] = matches.map((m) => ({
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

  const runRef = matchingRunRef(ctx);
  const runId = hooks.runId ?? (await claimMatchingRun(ctx));
  // Every commit that publishes this run's result in pieces marks the
  // Role partial in the same commit, and the commit that finishes the
  // run clears it, so the marker can never claim a complete set the
  // store does not hold (#504).
  const markPartial = (tx: Transaction): void => {
    tx.update(runRef, { partial: true });
  };
  const markComplete = (tx: Transaction): void => {
    tx.update(runRef, {
      state: "complete",
      partial: false,
      completed_at: new Date().toISOString(),
    });
  };
  const assertCurrentRun = async (tx: Transaction): Promise<void> => {
    const snap = await tx.get(runRef);
    if ((snap.data() as { run_id?: string } | undefined)?.run_id !== runId) {
      throw new MatchingRunSuperseded(
        `replaceMatchesForRole: a newer matching run for role ${roleId} started; ` +
          "stopping this one.",
      );
    }
  };

  try {
    // -- Single atomic transaction, when it fits --------------------------
    const atomic = await db.runTransaction(async (tx) => {
      await assertCurrentRun(tx);
      const existing = await tx.get(scopedQuery);
      const orphans = existing.docs.filter((d) => !newIds.has(d.id));
      if (keyed.length + orphans.length > MATCH_WRITES_PER_COMMIT) return null;
      if (keyed.length === 0 && orphans.length === 0) {
        markComplete(tx);
        return [];
      }

      const flagsByPair = new Map<string, ApprovalFlags>();
      for (const doc of existing.docs) {
        const stored = doc.data() as UnitMatch;
        if (stored.approved_for_use || stored.user_rejected) {
          const key = pairKey(stored.experience_unit_id, stored.job_requirement_unit_id);
          flagsByPair.set(key, foldFlags(flagsByPair.get(key), stored));
        }
      }
      const out = keyed.map((m) => withPriorFlags(m, flagsByPair));
      for (const m of out) tx.set(collection.doc(m.id), m);
      for (const d of orphans) tx.delete(d.ref);
      markComplete(tx);
      return out;
    });
    if (atomic !== null) return atomic;

    // -- Chunked, above the single-commit size ----------------------------

    // Legacy docs: stored matches for a pair whose id is NOT the pair's
    // deterministic id. Indexed by pair so each chunk can re-read, fold
    // and delete exactly the ones for its own pairs.
    const initial = await scopedQuery.get();
    const legacyRefsByPair = new Map<string, DocumentReference[]>();
    for (const doc of initial.docs) {
      const m = doc.data() as UnitMatch;
      const expectedId = matchDocId(ownerUid, roleId, m.experience_unit_id, m.job_requirement_unit_id);
      if (doc.id === expectedId) continue;
      const key = pairKey(m.experience_unit_id, m.job_requirement_unit_id);
      const refs = legacyRefsByPair.get(key) ?? [];
      refs.push(doc.ref);
      legacyRefsByPair.set(key, refs);
    }

    // Pack chunks by commit size: one write per match plus one delete
    // per legacy doc for its pair.
    const chunks: UnitMatch[][] = [];
    let current: UnitMatch[] = [];
    let currentOps = 0;
    for (const m of keyed) {
      const legacy = legacyRefsByPair.get(pairKey(m.experience_unit_id, m.job_requirement_unit_id));
      const ops = 1 + (legacy?.length ?? 0);
      if (current.length > 0 && currentOps + ops > MATCH_WRITES_PER_COMMIT) {
        chunks.push(current);
        current = [];
        currentOps = 0;
      }
      current.push(m);
      currentOps += ops;
    }
    if (current.length > 0) chunks.push(current);

    const merged: UnitMatch[] = [];
    for (const chunk of chunks) {
      const out = await db.runTransaction(async (tx) => {
        await assertCurrentRun(tx);
        const legacyRefs: DocumentReference[] = [];
        for (const m of chunk) {
          legacyRefs.push(
            ...(legacyRefsByPair.get(pairKey(m.experience_unit_id, m.job_requirement_unit_id)) ?? []),
          );
        }
        const snaps = await tx.getAll(
          ...chunk.map((m) => collection.doc(m.id)),
          ...legacyRefs,
        );

        const flagsByPair = new Map<string, ApprovalFlags>();
        const liveLegacy: DocumentReference[] = [];
        for (const snap of snaps) {
          if (!snap.exists) continue;
          const stored = snap.data() as UnitMatch;
          if (stored.owner_uid !== ownerUid || stored.role_id !== roleId) {
            // Only reachable via a deterministic-id collision with a doc
            // outside this (owner, Role), which the owner- and
            // Role-namespaced hash rules out. Refuse rather than
            // overwrite another tenant's row.
            throw new Error(
              `replaceMatchesForRole: doc ${snap.id} is not scoped to this owner and Role; aborting.`,
            );
          }
          if (!newIds.has(snap.id)) liveLegacy.push(snap.ref);
          if (stored.approved_for_use || stored.user_rejected) {
            const key = pairKey(stored.experience_unit_id, stored.job_requirement_unit_id);
            flagsByPair.set(key, foldFlags(flagsByPair.get(key), stored));
          }
        }

        const chunkOut = chunk.map((m) => withPriorFlags(m, flagsByPair));
        for (const m of chunkOut) tx.set(collection.doc(m.id), m);
        // The legacy doc goes in the same commit whose flags it fed.
        for (const ref of liveLegacy) tx.delete(ref);
        markPartial(tx);
        return chunkOut;
      });
      merged.push(...out);
    }

    await hooks.afterChunkedWrites?.();

    // Orphan pass. Re-query AFTER the writes so the deletion reflects
    // the store as this run leaves it; each commit re-checks that this
    // is still the newest run.
    const after = await scopedQuery.get();
    const orphans = after.docs.filter((d) => !newIds.has(d.id));
    for (let i = 0; i < orphans.length; i += MATCH_WRITES_PER_COMMIT) {
      const slice = orphans.slice(i, i + MATCH_WRITES_PER_COMMIT);
      await db.runTransaction(async (tx) => {
        await assertCurrentRun(tx);
        for (const d of slice) tx.delete(d.ref);
        markPartial(tx);
      });
    }

    await db.runTransaction(async (tx) => {
      await assertCurrentRun(tx);
      markComplete(tx);
    });

    return merged;
  } catch (err) {
    if (err instanceof MatchingRunSuperseded) {
      // Do NOT report success. A superseded run may already have
      // committed some chunks, and the newer run that owns the result
      // can still fail before it publishes a complete generation, in
      // which case nothing converges the store (#501 review). Surface
      // the supersession so the caller reports "not complete" and the
      // user can re-run; the newest successful run always converges.
      console.info(err.message);
    } else {
      await markMatchingRunFailed(ctx, runId);
    }
    throw err;
  }
}

function withPriorFlags(
  m: UnitMatch,
  flagsByPair: ReadonlyMap<string, ApprovalFlags>,
): UnitMatch {
  const prior = flagsByPair.get(pairKey(m.experience_unit_id, m.job_requirement_unit_id));
  return prior !== undefined ? { ...m, ...prior } : m;
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
