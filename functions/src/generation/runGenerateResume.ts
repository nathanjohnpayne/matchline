/**
 * Generation orchestrator for sub-issue #121 of #22.
 * Composes:
 *
 *   runGenerationPipeline (#120, LLM only)
 *     → persistAsset       (transactional append to Application.generated_assets[])
 *     → { assetId, applicationId, ...result }
 *
 * Same shape as `validateAsset` (#109): a single
 * orchestrator-level function the HTTPS callable wraps. The
 * integration test (#121) calls THIS function with DI'd
 * mocks rather than the callable, so the LLM + persistence
 * paths can be verified against the real Firestore emulator
 * without spinning the full Cloud Functions runtime.
 *
 * The persist is a transaction. It re-checks ownership inside
 * the tx (defense in depth — the pipeline's loadInputs already
 * checked at LLM-call time, but a between-call deletion or
 * owner_uid swap could still race the persist). Same shape as
 * #109's persistFlags + #99's matching persist.
 */

import { randomUUID } from "node:crypto";

import { getAdminDb } from "../firestore/admin.js";
import type { AssetRef, GeneratedAssetContent } from "../types/crm.js";

import {
  runGenerationPipeline,
  type GenerationDeps,
  type RunGenerationContext,
} from "./pipeline.js";

const APPLICATIONS_COLLECTION = "applications";

export interface RunGenerateResumeResult {
  readonly assetId: string;
  readonly applicationId: string;
  readonly content: GeneratedAssetContent;
  readonly cost_usd: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
}

export interface RunGenerateResumeDeps extends GenerationDeps {
  /**
   * Persist the generated AssetRef. Default appends to
   * `Application.generated_assets[]` in a transaction with
   * an ownership re-check. Override in tests when you want
   * to assert on the input shape without hitting Firestore.
   */
  readonly persistAsset?: (params: PersistAssetParams) => Promise<void>;
  /**
   * Override the timestamp source for deterministic tests.
   * Defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
}

export interface PersistAssetParams {
  readonly ownerUid: string;
  readonly applicationId: string;
  readonly asset: AssetRef;
}

export async function runGenerateResume(
  ctx: RunGenerationContext,
  deps: RunGenerateResumeDeps = {},
): Promise<RunGenerateResumeResult> {
  // The pipeline call is what may throw
  // GenerationApplicationNotFound /
  // GenerationNoApprovedUnitsError / GenerationError. The
  // callable maps each to its HttpsError code; this
  // orchestrator just lets them propagate.
  const result = await runGenerationPipeline(ctx, deps);

  const generateId = deps.generateId ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const persistAsset = deps.persistAsset ?? defaultPersistAsset;

  const assetId = generateId();
  const createdAt = now();

  const asset: AssetRef = {
    id: assetId,
    owner_uid: ctx.ownerUid,
    application_id: ctx.applicationId,
    kind: "resume",
    format: "json",
    // V1 stores structured content inline; PDF/DOCX export
    // (#50) writes binary to Storage and populates this.
    storage_path: "",
    generated_content: result.content,
    validation_status: "pending",
    cost_usd: result.cost_usd,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    latency_ms: result.latency_ms,
    created_at: createdAt,
  };

  await persistAsset({
    ownerUid: ctx.ownerUid,
    applicationId: ctx.applicationId,
    asset,
  });

  return {
    assetId,
    applicationId: ctx.applicationId,
    content: result.content,
    cost_usd: result.cost_usd,
    input_tokens: result.input_tokens,
    output_tokens: result.output_tokens,
    latency_ms: result.latency_ms,
  };
}

async function defaultPersistAsset(params: PersistAssetParams): Promise<void> {
  const { ownerUid, applicationId, asset } = params;
  const db = getAdminDb();
  await db.runTransaction(async (tx) => {
    const ref = db.collection(APPLICATIONS_COLLECTION).doc(applicationId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      // Anti-enumeration: same shape as #120's loadInputs
      // not-found. The callable maps this to permission-denied.
      throw new GenerateResumePersistNotFound(
        `Application ${applicationId} not found during persist.`,
      );
    }
    const app = snap.data() as {
      owner_uid?: string;
      generated_assets?: AssetRef[];
    };
    if (app.owner_uid !== ownerUid) {
      // Cross-tenant safety: even though the pipeline already
      // verified ownership at load, re-check inside the tx.
      // An adversarial owner_uid swap between LLM call and
      // persist would otherwise stamp Bob's generated content
      // onto Alice's application.
      throw new GenerateResumePersistNotFound(
        `Application ${applicationId} not found during persist.`,
      );
    }
    const assets = app.generated_assets ?? [];
    tx.update(ref, {
      generated_assets: [...assets, asset],
      // Bump activity for the kanban (#27 / Phase 2b).
      last_activity_at: asset.created_at,
    });
  });
}

/**
 * Thrown when the persist transaction can't find the
 * Application doc OR finds it owned by a different uid.
 * Same anti-enumeration collapse as
 * `GenerationApplicationNotFound` (#120). The callable maps
 * this to `permission-denied`.
 */
export class GenerateResumePersistNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateResumePersistNotFound";
  }
}
