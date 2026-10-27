/**
 * Validation orchestrator (sub-issue #109 of #23).
 *
 * The composer that turns the per-claim validation primitives —
 * claim extraction (#106), traceability (#107), specificity
 * (#108) — into a single validation pass on an Application's
 * generated asset. Persists flag records to the AssetRef and
 * flips `validation_status` to `passed` / `failed` based on
 * the flags.
 *
 * Per-bullet pipeline:
 *   1. extractClaims(bullet) → Claim[]
 *   2. For each claim:
 *      a. checkTraceability(claim, sourceUnits) → if false,
 *         emit `untraceable` flag and skip specificity (a
 *         fabricated claim's specificity is moot).
 *      b. checkSpecificity(claim) → if false, emit
 *         `specificity` flag.
 *      c. Otherwise, emit `traced` flag (informational; the
 *         editor uses it for hover-trace UX).
 *
 * Concurrency (#619, #491): the calls above run through one bounded
 * pool (`callPool.ts`), `VALIDATION_CONCURRENCY` at a time across all
 * items and claims. Each claim still awaits traceability before it
 * submits specificity. Flags are assembled afterwards in document
 * order (item, then claim), and only then stamped with ids and
 * timestamps, so the output is the same as a sequential run's. The
 * first failed call aborts the pool; nothing persists unless every
 * item validated. With a `budgetMs`, the pool stops starting calls
 * `VALIDATION_DEADLINE_MARGIN_MS` before it runs out and the
 * orchestrator throws `ValidationDeadlineExceeded`.
 *
 * Asset-level status:
 *   - 0 untraceable + 0 specificity flags → `passed` (export OK).
 *   - any of either → `failed` (export blocked).
 *
 * Per the parent #23 spec: NO auto-regeneration. Failures
 * surface to the user as flags they explicitly resolve.
 *
 * Concurrency / cross-tenant safety: same shape as #99
 * (runMatching). The callable validates auth + asset
 * ownership up front; the orchestrator's persist is a
 * single-doc transactional update on `applications/{id}`
 * that replaces the whole flag set wholesale.
 */

import { randomUUID } from "node:crypto";

import { getAdminDb } from "../firestore/admin.js";
import type { ExperienceUnit } from "../types/capability.js";
import type {
  AssetRef,
  GeneratedAssetContent,
  GeneratedBullet,
  ValidationFlag,
  ValidationStatus,
} from "../types/crm.js";

import {
  extractClaims as extractClaimsFn,
  type Claim,
} from "./claimExtraction.js";
import {
  checkSpecificity as checkSpecificityFn,
  type SpecificityResult,
} from "./specificity.js";
import {
  checkTraceability as checkTraceabilityFn,
  type TraceabilityResult,
} from "./traceability.js";
import { unitEvidenceVersion } from "./unitEvidenceVersion.js";
import { createCallPool, settleInOrder, type CallPool } from "./callPool.js";
import {
  VALIDATIONS_SUBCOLLECTION,
  assetContentVersion,
  isAttestableContent,
  validationAttestationId,
  type ValidationAttestation,
} from "./attestation.js";

export interface ValidateAssetContext {
  readonly ownerUid: string;
  readonly applicationId: string;
  readonly assetId: string;
}

export interface ValidateAssetResult {
  readonly status: ValidationStatus;
  readonly flags: readonly ValidationFlag[];
  readonly validated_at: string;
  /**
   * JSON-string snapshot of `content` at validation time. Used
   * by the persist transaction to detect TOCTOU edits — if the
   * asset's `generated_content` changes between loadAsset and
   * persistFlags, the persist throws `ValidateAssetStale` so
   * the orchestrator can be re-run against fresh content.
   * CodeRabbit Major round 1 on PR #117.
   *
   * Internal field — the callable strips it before returning
   * to the client. Exported for testability of the persist
   * path.
   */
  readonly content_snapshot: string;
  /**
   * `unitEvidenceVersion` of every approved Unit the validator loaded
   * as evidence, keyed by Unit id: a fingerprint of the exact content
   * this verdict is about. Persisted on the asset as
   * `validated_unit_versions`; the editor's export gate recomputes it
   * from each cited Unit, so evidence changed at ANY point after it
   * was loaded (including while this validation was still running,
   * and including a write that kept `updated_at`) invalidates the
   * verdict. Content, not timestamps, also keeps client and server
   * clock skew out of the decision.
   */
  readonly validated_unit_versions: Readonly<Record<string, string>>;
}

export interface ValidationDeps {
  /** Override for tests. Default reads from Firestore. */
  readonly loadAsset?: (
    ctx: ValidateAssetContext,
  ) => Promise<{ readonly asset: AssetRef; readonly content: GeneratedAssetContent }>;
  /** Override for tests. Default reads from Firestore. */
  readonly loadUnits?: (
    unitIds: readonly string[],
    ownerUid: string,
  ) => Promise<readonly ExperienceUnit[]>;
  /** Override for tests. Default writes to Firestore. */
  readonly persistFlags?: (
    ctx: ValidateAssetContext,
    result: ValidateAssetResult,
  ) => Promise<void>;
  readonly extractClaims?: typeof extractClaimsFn;
  readonly checkTraceability?: typeof checkTraceabilityFn;
  readonly checkSpecificity?: typeof checkSpecificityFn;
  /** Injectable for deterministic ids in tests. */
  readonly generateId?: () => string;
  /** Injectable clock. */
  readonly now?: () => string;
  /** Model calls in flight at once. Default `VALIDATION_CONCURRENCY`. */
  readonly concurrency?: number;
  /**
   * Wall-clock budget for this run, in ms (the callable passes its
   * timeout). Omit for no deadline.
   */
  readonly budgetMs?: number;
  /** Injectable epoch-ms clock for the deadline. Default `Date.now`. */
  readonly clockMs?: () => number;
}

/**
 * Model calls in flight at once. #616's run measured about 2.5 s per
 * validation call (p50), so ~100 calls take ~40 s at 6 instead of
 * ~250 s one at a time. The org's Anthropic rate limits (Scale tier)
 * are far above 6 concurrent Sonnet calls, and 429s still back off
 * inside each check's retry loop.
 */
export const VALIDATION_CONCURRENCY = 6;

/**
 * How long before `budgetMs` runs out the pool stops starting calls.
 * Covers the calls already in flight (one call's worst case, retries
 * included, is well over its p50) plus the persist transaction.
 */
export const VALIDATION_DEADLINE_MARGIN_MS = 45_000;

export async function validateAsset(
  ctx: ValidateAssetContext,
  deps: ValidationDeps = {},
): Promise<ValidateAssetResult> {
  const loadAsset = deps.loadAsset ?? defaultLoadAsset;
  const loadUnits = deps.loadUnits ?? defaultLoadUnits;
  const persistFlags = deps.persistFlags ?? defaultPersistFlags;
  const extractClaims = deps.extractClaims ?? extractClaimsFn;
  const checkTraceability = deps.checkTraceability ?? checkTraceabilityFn;
  const checkSpecificity = deps.checkSpecificity ?? checkSpecificityFn;
  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());

  const { content } = await loadAsset(ctx);
  // The validator skips an item whose text is not a string, but the
  // editor still renders it, so a pass over malformed content would
  // attest text no check ever read (#506 review). Refuse it outright:
  // no verdict, no attestation.
  if (!isAttestableContent(content)) {
    throw new ValidateAssetMalformedContent(
      `Asset ${ctx.assetId} has malformed generated_content; refusing to validate it.`,
    );
  }

  // Validate every fact-bearing piece of the asset. All four
  // section types share the same `GeneratedItem` shape (id +
  // text + source_unit_ids) so the orchestrator iterates them
  // uniformly. cursor caught prior versions that bypassed
  // validation: summary as a plain string (#117 r1), skills/
  // education as plain string arrays (#117 r2), and
  // experience-section metadata as ungrounded fields the data
  // model couldn't validate (#122 rounds 3+4). V1 is
  // intentionally flat — no experience-section grouping.
  //
  // The order summary → bullets → skills → education isn't
  // semantically meaningful (each item is independently
  // validated); kept stable for deterministic flag-list
  // ordering downstream.
  const allBullets: GeneratedBullet[] = [
    content.summary,
    ...content.bullets,
    ...content.skills,
    ...(content.education ?? []),
  ];

  // Collect every Unit id referenced across the asset's bullets,
  // then load Units once. The orchestrator's outer loop runs at
  // bullet granularity; loading per-bullet would re-fetch the
  // same Units repeatedly when bullets share source_unit_ids.
  const allUnitIds = unique(allBullets.flatMap((b) => b.source_unit_ids));
  const units = await loadUnits(allUnitIds, ctx.ownerUid);
  const unitsById = new Map(units.map((u) => [u.id, u]));

  const clockMs = deps.clockMs ?? Date.now;
  const pool = createCallPool({
    concurrency: deps.concurrency ?? VALIDATION_CONCURRENCY,
    clockMs,
    ...(deps.budgetMs !== undefined && {
      deadlineAtMs:
        clockMs() + Math.max(0, deps.budgetMs - VALIDATION_DEADLINE_MARGIN_MS),
    }),
  });
  const checks = { extractClaims, checkTraceability, checkSpecificity };
  const perBullet = await settleInOrder(
    allBullets.map((bullet) => validateBullet(bullet, unitsById, ctx, checks, pool)),
  );

  // Ids and timestamps are stamped here, in document order, so they
  // don't depend on which call finished first.
  const flags: ValidationFlag[] = perBullet.flatMap((verdicts) =>
    verdicts.map((v) =>
      makeFlag(ctx.assetId, v.bulletId, v.claimId, v.status, v.trace, v.spec, {
        generateId,
        now,
      }),
    ),
  );

  const status = computeStatus(flags);
  const result: ValidateAssetResult = {
    status,
    flags,
    validated_at: now(),
    content_snapshot: JSON.stringify(content),
    validated_unit_versions: Object.fromEntries(
      units.map((u) => [u.id, unitEvidenceVersion(u)]),
    ),
  };

  await persistFlags(ctx, result);

  return result;
}

/** One claim's outcome, before it is stamped into a flag. */
interface ClaimVerdict {
  readonly bulletId: string;
  readonly claimId: string;
  readonly status: ValidationFlag["status"];
  readonly trace: TraceabilityResult;
  readonly spec?: SpecificityResult;
}

interface ValidationChecks {
  readonly extractClaims: typeof extractClaimsFn;
  readonly checkTraceability: typeof checkTraceabilityFn;
  readonly checkSpecificity: typeof checkSpecificityFn;
}

/** Per-bullet validation. Extracted for readability + testability. */
async function validateBullet(
  bullet: GeneratedBullet,
  unitsById: ReadonlyMap<string, ExperienceUnit>,
  ctx: ValidateAssetContext,
  checks: ValidationChecks,
  pool: CallPool,
): Promise<ClaimVerdict[]> {
  // Empty bullets — defensive: don't invoke claim extraction on
  // an empty string; #106's contract throws synchronously on
  // empty input. Skip silently.
  if (typeof bullet.text !== "string" || bullet.text.trim().length === 0) {
    return [];
  }

  const claims = await pool.run(() =>
    checks.extractClaims(
      { text: bullet.text, source_unit_ids: bullet.source_unit_ids },
      {
        ownerUid: ctx.ownerUid,
        applicationId: ctx.applicationId,
        assetId: ctx.assetId,
        bulletId: bullet.id,
      },
    ),
  );

  // Only the Units this bullet's generator said it grounded on
  // are candidates for traceability. A bullet that names a
  // company NOT in source_unit_ids is a fabrication regardless
  // of what other Units the user owns.
  const candidateUnits: ExperienceUnit[] = bullet.source_unit_ids
    .map((id) => unitsById.get(id))
    .filter((u): u is ExperienceUnit => u !== undefined);

  return settleInOrder(
    claims.map((claim) =>
      validateClaim(claim, candidateUnits, ctx, bullet.id, checks, pool),
    ),
  );
}

/** Per-claim validation. Two-phase: traceability → specificity. */
async function validateClaim(
  claim: Claim,
  candidateUnits: readonly ExperienceUnit[],
  ctx: ValidateAssetContext,
  bulletId: string,
  checks: ValidationChecks,
  pool: CallPool,
): Promise<ClaimVerdict> {
  const verdict = (
    status: ValidationFlag["status"],
    trace: TraceabilityResult,
    spec?: SpecificityResult,
  ): ClaimVerdict => ({ bulletId, claimId: claim.id, status, trace, spec });

  // Phase 1: traceability. A fabricated claim short-circuits —
  // its specificity is moot.
  const trace = await pool.run(() =>
    checks.checkTraceability(claim, candidateUnits, {
      ownerUid: ctx.ownerUid,
      applicationId: ctx.applicationId,
    }),
  );
  if (!trace.supports) {
    return verdict("untraceable", trace);
  }

  // Phase 2: specificity. The claim is supported but might be
  // vacuous.
  const spec = await pool.run(() =>
    checks.checkSpecificity(claim, {
      ownerUid: ctx.ownerUid,
      applicationId: ctx.applicationId,
    }),
  );
  if (!spec.specific) {
    return verdict("specificity", trace, spec);
  }

  // Both checks passed — informational `traced` flag.
  return verdict("traced", trace, spec);
}

function makeFlag(
  assetId: string,
  bulletId: string,
  claimId: string,
  status: ValidationFlag["status"],
  trace: TraceabilityResult,
  spec: SpecificityResult | undefined,
  deps: { generateId: () => string; now: () => string },
): ValidationFlag {
  // Rationale composes the layer that produced the flag:
  //   - `traced`: trace's rationale (the supporting Unit
  //     description) — informational.
  //   - `untraceable`: trace's rationale (why no Unit supports).
  //   - `specificity`: spec's rationale (why the claim is vague).
  const rationale =
    status === "specificity" && spec ? spec.rationale : trace.rationale;
  return {
    id: deps.generateId(),
    asset_id: assetId,
    bullet_id: bulletId,
    claim_id: claimId,
    status,
    rationale,
    created_at: deps.now(),
    ...(trace.supporting_unit_id !== undefined && status !== "untraceable"
      ? { supporting_unit_id: trace.supporting_unit_id }
      : {}),
    ...(status === "specificity" && spec?.matched_pattern !== undefined
      ? { matched_pattern: spec.matched_pattern }
      : {}),
  };
}

function computeStatus(flags: readonly ValidationFlag[]): ValidationStatus {
  // Any failure flag → failed. Otherwise passed. The orchestrator
  // is unreachable for `pending` (the asset has been validated)
  // and `stale` (set by edits, not by this function).
  for (const f of flags) {
    if (f.status === "untraceable" || f.status === "specificity") {
      return "failed";
    }
  }
  return "passed";
}

function unique<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

// -- Default Firestore implementations --------------------------------------

const APPLICATIONS_COLLECTION = "applications";
const UNITS_COLLECTION = "experienceUnits";

interface ApplicationDoc {
  readonly id: string;
  readonly owner_uid: string;
  readonly generated_assets?: readonly AssetRef[];
}

async function defaultLoadAsset(
  ctx: ValidateAssetContext,
): Promise<{ asset: AssetRef; content: GeneratedAssetContent }> {
  const db = getAdminDb();
  const snap = await db
    .collection(APPLICATIONS_COLLECTION)
    .doc(ctx.applicationId)
    .get();
  if (!snap.exists) {
    throw new ValidateAssetNotFound(
      `Application ${ctx.applicationId} not found.`,
    );
  }
  const app = snap.data() as ApplicationDoc;
  if (app.owner_uid !== ctx.ownerUid) {
    // Same anti-enumeration shape as parseJobRequirements (#19)
    // and runMatching (#99): collapse "not yours" into
    // "not found" so an attacker can't probe for ids.
    throw new ValidateAssetNotFound(
      `Application ${ctx.applicationId} not found.`,
    );
  }
  const asset = (app.generated_assets ?? []).find(
    (a) => a.id === ctx.assetId,
  );
  if (!asset) {
    throw new ValidateAssetNotFound(
      `Asset ${ctx.assetId} not found on application ${ctx.applicationId}.`,
    );
  }
  if (!asset.generated_content) {
    throw new ValidateAssetMissingContent(
      `Asset ${ctx.assetId} has no generated_content; nothing to validate.`,
    );
  }
  return { asset, content: asset.generated_content };
}

async function defaultLoadUnits(
  unitIds: readonly string[],
  ownerUid: string,
): Promise<readonly ExperienceUnit[]> {
  if (unitIds.length === 0) return [];
  const db = getAdminDb();
  // Firestore `in` query caps at 30 values; chunk.
  const FIRESTORE_IN_LIMIT = 30;
  const out: ExperienceUnit[] = [];
  for (let i = 0; i < unitIds.length; i += FIRESTORE_IN_LIMIT) {
    const chunk = unitIds.slice(i, i + FIRESTORE_IN_LIMIT);
    // Filter to APPROVED units only. Codex P1 round 1 on PR
    // #117 caught a prior version that returned any
    // owner-scoped Unit, including rejected/pending/flagged
    // ones. The same load-bearing zero-fab invariant from #82
    // applies here: validation must NEVER consult Units the
    // user hasn't approved as evidence — even if the generator
    // happened to ground a bullet on one (which it shouldn't,
    // but defense in depth). Mirrors `approvedUnitsQueryConstraints()`
    // from src/services/experienceUnits.ts.
    const snap = await db
      .collection(UNITS_COLLECTION)
      .where("owner_uid", "==", ownerUid)
      .where("user_approved", "==", true)
      .where("id", "in", chunk)
      .get();
    out.push(...(snap.docs.map((d) => d.data()) as ExperienceUnit[]));
  }
  return out;
}

async function defaultPersistFlags(
  ctx: ValidateAssetContext,
  result: ValidateAssetResult,
): Promise<void> {
  const db = getAdminDb();
  await db.runTransaction(async (tx) => {
    const ref = db.collection(APPLICATIONS_COLLECTION).doc(ctx.applicationId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new ValidateAssetNotFound(
        `Application ${ctx.applicationId} not found during persist.`,
      );
    }
    const app = snap.data() as ApplicationDoc;
    if (app.owner_uid !== ctx.ownerUid) {
      // Cross-tenant safety: even though the callable already
      // verified ownership, the persist re-checks inside the
      // transaction. Same defense-in-depth shape as #99.
      throw new ValidateAssetNotFound(
        `Application ${ctx.applicationId} not found during persist.`,
      );
    }
    const assets = app.generated_assets ?? [];
    const target = assets.find((a) => a.id === ctx.assetId);
    // Fail fast if the asset is gone — a deletion between load
    // and persist would otherwise let the transaction commit
    // a no-op `.map()` over an array missing the asset, and
    // validateAsset would return success having updated nothing.
    // CodeRabbit Critical round 1 on PR #117.
    if (!target) {
      throw new ValidateAssetNotFound(
        `Asset ${ctx.assetId} not found on application ${ctx.applicationId} during persist (deleted between load and persist?).`,
      );
    }
    // TOCTOU stale-write guard. The validation result was
    // computed against `content` snapshotted at loadAsset
    // time. If the asset's `generated_content` has changed
    // since then (the user edited a bullet, the orchestrator
    // re-generated, etc.), persisting these flags would mark
    // the asset "passed" against content that no longer
    // exists. Throw `ValidateAssetStale` instead so the caller
    // (and the editor surface) can re-trigger validation
    // against the new content. CodeRabbit Major round 1 on
    // PR #117.
    //
    // The hash comparison is JSON-string equality on
    // generated_content. Cheap relative to an LLM call; tight
    // enough that a single character change in any bullet
    // triggers stale.
    if (
      JSON.stringify(target.generated_content) !==
      result.content_snapshot
    ) {
      throw new ValidateAssetStale(
        `Asset ${ctx.assetId} content changed during validation; flags discarded. Re-run validateAsset.`,
      );
    }
    const updatedAssets = assets.map((a) =>
      a.id === ctx.assetId
        ? {
            ...a,
            validation_flags: result.flags,
            validation_status: result.status,
            validated_at: result.validated_at,
            validated_unit_versions: result.validated_unit_versions,
          }
        : a,
    );
    tx.update(ref, { generated_assets: updatedAssets });

    // The attestation the export gate trusts (#502): server-only, and
    // keyed by the content it is about, in the same commit as the
    // stale-content check above, so it can never describe content
    // other than what this run validated.
    if (result.status === "passed" || result.status === "failed") {
      const contentVersion = assetContentVersion(target.generated_content);
      const attestation: ValidationAttestation = {
        owner_uid: ctx.ownerUid,
        application_id: ctx.applicationId,
        asset_id: ctx.assetId,
        content_version: contentVersion,
        status: result.status,
        validated_at: result.validated_at,
        validated_unit_versions: result.validated_unit_versions,
      };
      tx.set(
        ref
          .collection(VALIDATIONS_SUBCOLLECTION)
          .doc(validationAttestationId(ctx.assetId, contentVersion)),
        attestation,
      );
    }
  });
}

// -- Errors -----------------------------------------------------------------

export class ValidateAssetNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateAssetNotFound";
  }
}

export class ValidateAssetMissingContent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateAssetMissingContent";
  }
}

/**
 * Thrown when `generated_content` is not the shape the validator can
 * check in full (`isAttestableContent`). Distinct from missing content
 * so the callable can tell the user regenerating, not generating, is
 * the fix.
 */
export class ValidateAssetMalformedContent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateAssetMalformedContent";
  }
}

/**
 * Thrown when the asset's `generated_content` changed between
 * the validation orchestrator's load and persist phases. The
 * persist transaction detects this by comparing a JSON-string
 * snapshot of the content. The caller's right move is to
 * re-run validateAsset against the fresh content.
 *
 * CodeRabbit Major round 1 on PR #117 — TOCTOU defense.
 */
export class ValidateAssetStale extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateAssetStale";
  }
}
