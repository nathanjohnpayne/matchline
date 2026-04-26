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

export interface ValidateAssetContext {
  readonly ownerUid: string;
  readonly applicationId: string;
  readonly assetId: string;
}

export interface ValidateAssetResult {
  readonly status: ValidationStatus;
  readonly flags: readonly ValidationFlag[];
  readonly validated_at: string;
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
}

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

  // Collect every Unit id referenced across the asset's bullets,
  // then load Units once. The orchestrator's outer loop runs at
  // bullet granularity; loading per-bullet would re-fetch the
  // same Units repeatedly when bullets share source_unit_ids.
  const allBullets = content.experience.flatMap((s) => s.bullets);
  const allUnitIds = unique(allBullets.flatMap((b) => b.source_unit_ids));
  const units = await loadUnits(allUnitIds, ctx.ownerUid);
  const unitsById = new Map(units.map((u) => [u.id, u]));

  const flags: ValidationFlag[] = [];
  for (const bullet of allBullets) {
    const bulletFlags = await validateBullet(
      bullet,
      unitsById,
      ctx,
      {
        extractClaims,
        checkTraceability,
        checkSpecificity,
        generateId,
        now,
      },
    );
    flags.push(...bulletFlags);
  }

  const status = computeStatus(flags);
  const result: ValidateAssetResult = {
    status,
    flags,
    validated_at: now(),
  };

  await persistFlags(ctx, result);

  return result;
}

/** Per-bullet validation. Extracted for readability + testability. */
async function validateBullet(
  bullet: GeneratedBullet,
  unitsById: ReadonlyMap<string, ExperienceUnit>,
  ctx: ValidateAssetContext,
  deps: {
    extractClaims: typeof extractClaimsFn;
    checkTraceability: typeof checkTraceabilityFn;
    checkSpecificity: typeof checkSpecificityFn;
    generateId: () => string;
    now: () => string;
  },
): Promise<ValidationFlag[]> {
  // Empty bullets — defensive: don't invoke claim extraction on
  // an empty string; #106's contract throws synchronously on
  // empty input. Skip silently.
  if (typeof bullet.text !== "string" || bullet.text.trim().length === 0) {
    return [];
  }

  const claims = await deps.extractClaims(
    { text: bullet.text, source_unit_ids: bullet.source_unit_ids },
    {
      ownerUid: ctx.ownerUid,
      assetId: ctx.assetId,
      bulletId: bullet.id,
    },
  );

  // Only the Units this bullet's generator said it grounded on
  // are candidates for traceability. A bullet that names a
  // company NOT in source_unit_ids is a fabrication regardless
  // of what other Units the user owns.
  const candidateUnits: ExperienceUnit[] = bullet.source_unit_ids
    .map((id) => unitsById.get(id))
    .filter((u): u is ExperienceUnit => u !== undefined);

  const flags: ValidationFlag[] = [];
  for (const claim of claims) {
    const flag = await validateClaim(
      claim,
      candidateUnits,
      ctx,
      bullet.id,
      deps,
    );
    flags.push(flag);
  }
  return flags;
}

/** Per-claim validation. Two-phase: traceability → specificity. */
async function validateClaim(
  claim: Claim,
  candidateUnits: readonly ExperienceUnit[],
  ctx: ValidateAssetContext,
  bulletId: string,
  deps: {
    checkTraceability: typeof checkTraceabilityFn;
    checkSpecificity: typeof checkSpecificityFn;
    generateId: () => string;
    now: () => string;
  },
): Promise<ValidationFlag> {
  // Phase 1: traceability. A fabricated claim short-circuits —
  // its specificity is moot.
  const trace = await deps.checkTraceability(claim, candidateUnits, {
    ownerUid: ctx.ownerUid,
  });
  if (!trace.supports) {
    return makeFlag(
      ctx.assetId,
      bulletId,
      claim.id,
      "untraceable",
      trace,
      undefined,
      deps,
    );
  }

  // Phase 2: specificity. The claim is supported but might be
  // vacuous.
  const spec = await deps.checkSpecificity(claim, {
    ownerUid: ctx.ownerUid,
  });
  if (!spec.specific) {
    return makeFlag(
      ctx.assetId,
      bulletId,
      claim.id,
      "specificity",
      trace,
      spec,
      deps,
    );
  }

  // Both checks passed — informational `traced` flag.
  return makeFlag(
    ctx.assetId,
    bulletId,
    claim.id,
    "traced",
    trace,
    spec,
    deps,
  );
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
    ...(spec?.matched_pattern !== undefined
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
    const snap = await db
      .collection(UNITS_COLLECTION)
      .where("owner_uid", "==", ownerUid)
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
    const updatedAssets = (app.generated_assets ?? []).map((a) =>
      a.id === ctx.assetId
        ? {
            ...a,
            validation_flags: result.flags,
            validation_status: result.status,
            validated_at: result.validated_at,
          }
        : a,
    );
    tx.update(ref, { generated_assets: updatedAssets });
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
