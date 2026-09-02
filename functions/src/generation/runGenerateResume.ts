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
import type {
  JobRequirementUnit,
  UnitMatch,
} from "../types/capability.js";

import {
  findStaleGroundingId,
  requirementSetToken,
  runGenerationPipeline,
  type GenerationDeps,
  type RunGenerationContext,
} from "./pipeline.js";

const APPLICATIONS_COLLECTION = "applications";
const REQUIREMENTS_COLLECTION = "jobRequirementUnits";
const MATCHES_COLLECTION = "unitMatches";

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
  /**
   * Token for the Requirement set the artifact was generated
   * against. The default persist rejects the write if the Role's
   * set has changed since — see `requirementSetToken`. Optional
   * so existing callers and test doubles keep working; when
   * absent the identity check is skipped and only the
   * cited-grounding check runs.
   */
  readonly requirementSetToken?: string;
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
    requirementSetToken: result.requirement_set_token,
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
      role_id?: string;
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
    // Re-verify the grounding INSIDE the transaction (#442,
    // Codex P1 on PR #449).
    //
    // Exactly the discipline the ownership re-check above already
    // applies, pointed at a different invariant. `loadInputs`
    // reads Requirements and matches through plain parallel
    // queries, so a JD re-parse that commits between that read
    // and this persist leaves the eligibility gate having
    // approved grounding that has since evaporated — and the
    // window is the entire LLM call, which runs for minutes. A
    // second tab or a direct callable invocation is enough.
    //
    // Doing it as a transactional READ rather than a fresh
    // `get()` is what makes it hold instead of merely narrowing
    // the window: `writeRequirementsAsBatch` replaces
    // Requirements in a transaction over this same query, so a
    // re-parse racing this persist puts the two in contention and
    // one of them retries against the other's committed state.
    //
    // Reads must precede writes in a Firestore transaction, and
    // these are issued sequentially rather than through
    // `Promise.all` to keep that ordering unambiguous.
    // **Absent inputs REJECT; they do not skip.**
    //
    // The first version guarded with `if (roleId && content)`,
    // which made a missing `role_id` a reason to bypass every
    // check and append the asset anyway. `firestore.rules` permits
    // owner-preserving Application updates, so an authenticated
    // owner clearing `role_id` mid-generation was enough to walk
    // straight past the guard this transaction exists to enforce.
    // A validation step whose absent-input path is "allow" is not
    // a validation step. Codex P1 on PR #449.
    //
    // Neither field can legitimately be missing here: the resume
    // path always sets `generated_content`, and `defaultLoadInputs`
    // could not have produced a result without resolving the
    // Role from `role_id`. So both are hard failures.
    const roleId = app.role_id;
    const content = asset.generated_content;
    if (typeof roleId !== "string" || roleId.length === 0) {
      throw new GenerateResumeGroundingStale(
        `Application ${applicationId} has no role_id at persist time, so ` +
          `the generated content cannot be verified against the Role's ` +
          `current requirements. Nothing was saved.`,
      );
    }
    if (content === undefined) {
      throw new GenerateResumeGroundingStale(
        `Generated asset for application ${applicationId} carries no ` +
          `content to verify. Nothing was saved.`,
      );
    }
    {
      const reqSnap = await tx.get(
        db
          .collection(REQUIREMENTS_COLLECTION)
          .where("owner_uid", "==", ownerUid)
          .where("role_id", "==", roleId),
      );
      const matchSnap = await tx.get(
        db
          .collection(MATCHES_COLLECTION)
          .where("owner_uid", "==", ownerUid)
          .where("role_id", "==", roleId)
          .where("approved_for_use", "==", true),
      );
      const requirements = reqSnap.docs.map(
        (d) => ({ ...(d.data() as JobRequirementUnit), id: d.id }),
      );

      // Identity of the SET, not just of the cited grounding.
      //
      // `findStaleGroundingId` reduces both sides to Unit ids, so
      // it cannot distinguish "still grounded" from "a different
      // requirement now grounds the same Unit" — a re-parse
      // followed by the user approving a freshly computed match
      // for that Unit makes the citation look live while the
      // artifact was written for requirements that are gone.
      // Codex P1 on PR #449, after the first revalidation landed.
      //
      // Both checks stay: this one catches a changed Requirement
      // set, the other catches a citation losing its approved
      // match (an un-approval mid-flight) without the set moving.
      // The remedy depends on what the re-parse produced. Against
      // an EMPTY Requirement set, re-running matching can only
      // discard the surviving matches — and `MatchesTab`
      // deliberately hides that control in this state, so naming
      // it would be both unavailable and ineffective. Same
      // distinction the pre-generation gate already makes. Codex
      // P2 on PR #449.
      const remedy =
        requirements.length === 0
          ? `This Role now has no requirements at all; parse the job ` +
            `description again on the Requirements tab.`
          : `Re-run matching on the Matches tab and generate again.`;
      const expectedToken = params.requirementSetToken;
      if (
        expectedToken !== undefined &&
        requirementSetToken(requirements) !== expectedToken
      ) {
        throw new GenerateResumeGroundingStale(
          `This Role's requirements changed while the resume was being ` +
            `generated — the job description was re-parsed, so the content ` +
            `was written against requirements that no longer exist. Nothing ` +
            `was saved. ${remedy}`,
        );
      }

      const staleId = findStaleGroundingId(
        content,
        matchSnap.docs.map((d) => ({ ...(d.data() as UnitMatch), id: d.id })),
        requirements,
      );
      if (staleId !== null) {
        throw new GenerateResumeGroundingStale(
          `Generated content cites Experience Unit ${staleId}, which no ` +
            `longer has an approved match against any current Requirement ` +
            `for this Role — the job description was re-parsed while this ` +
            `resume was being generated. Nothing was saved. ${remedy}`,
        );
      }
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

/**
 * Thrown when the grounding a generated asset cites stopped
 * holding between the LLM call and the persist — in practice, a
 * JD re-parse replaced the Role's Requirements mid-generation and
 * stranded the approved matches the content was grounded on.
 *
 * Nothing is written: the transaction aborts, so the user loses
 * the generation rather than gaining an artifact that cites
 * requirements the job description no longer contains. The
 * callable maps this to `failed-precondition`, alongside the
 * other "your inputs are not ready" refusals.
 */
export class GenerateResumeGroundingStale extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerateResumeGroundingStale";
  }
}
