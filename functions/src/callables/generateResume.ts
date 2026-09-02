/**
 * HTTPS callable wrapping the generation orchestrator (#121
 * `runGenerateResume`). Step 5 of the core loop. One call:
 * applicationId → runGenerateResume (LLM + persist) →
 * { assetId, applicationId }.
 *
 * Auth-required; applicationId required. The orchestrator's
 * default loaders re-verify ownership at LLM-call time; the
 * persist transaction re-verifies AGAIN inside the tx.
 *
 * Same shape as `validateAssetCallable` (#109): the callable
 * is a thin wrapper that does auth + arg validation + error
 * mapping; the orchestrator does the work.
 */

import {
  HttpsError,
  onCall,
  type CallableRequest,
} from "firebase-functions/v2/https";

import { anthropicKey } from "../llm/anthropic.js";
import {
  GenerationApplicationNotFound,
  GenerationError,
  GenerationNoApprovedUnitsError,
} from "../generation/pipeline.js";
import {
  runGenerateResume,
  GenerateResumeGroundingStale,
  GenerateResumePersistNotFound,
  type RunGenerateResumeDeps,
} from "../generation/runGenerateResume.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

export interface GenerateResumeData {
  readonly applicationId?: string;
}

export interface GenerateResumeResponse {
  readonly assetId: string;
  readonly applicationId: string;
}

/**
 * Inner handler — exported so unit tests can invoke it
 * directly with a fabricated `CallableRequest` instead of
 * routing through `onCall`'s runtime. Tests pass a `deps`
 * argument to inject the orchestrator's mocks (LLM client,
 * persist, etc.) the same way #120 + #121 do at the
 * orchestrator level. CodeRabbit Critical round 1 on PR #124
 * called for this coverage.
 */
export async function generateResumeHandler(
  request: CallableRequest<GenerateResumeData>,
  deps: RunGenerateResumeDeps = {},
): Promise<GenerateResumeResponse> {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "generateResume requires a signed-in user.",
    );
  }

  const applicationId = validateApplicationId(request.data?.applicationId);
  const ownerUid = request.auth.uid;

  try {
    const result = await runGenerateResume(
      { ownerUid, applicationId },
      deps,
    );
    return {
      assetId: result.assetId,
      applicationId: result.applicationId,
    };
  } catch (err) {
    if (
      err instanceof GenerationApplicationNotFound ||
      err instanceof GenerateResumePersistNotFound
    ) {
      // Anti-enumeration: collapse "missing application" and
      // "wrong owner" — at LLM-call load AND at persist —
      // into one message so an attacker can't probe id
      // space. Same shape as validateAsset / runMatching.
      throw new HttpsError(
        "permission-denied",
        "Application not found, or not owned by caller.",
      );
    }
    if (err instanceof GenerationNoApprovedUnitsError) {
      // Empty-Units OR empty-approved-matches gate. The
      // pipeline's distinguishing message ("Approved Units
      // present (N) but no approved UnitMatches" vs. "No
      // approved ExperienceUnits") flows through verbatim
      // so the editor surface (#24) can show the right CTA
      // ("approve a match in the Matches tab" vs. "approve
      // some Units first").
      throw new HttpsError("failed-precondition", err.message);
    }
    if (err instanceof GenerateResumeGroundingStale) {
      // The persist transaction found the content's grounding no
      // longer live — a JD re-parse landed mid-generation (#442).
      // Nothing was written. `failed-precondition` alongside the
      // other "your inputs are not ready" refusals, message
      // verbatim so the editor surface can name the remedy.
      throw new HttpsError("failed-precondition", err.message);
    }
    if (err instanceof GenerationError) {
      // Retry-budget-exhausted error. Surface the per-attempt
      // failure detail with `stage: "generation"` so the
      // editor surface can show which attempts saw which
      // schema/transport/value-error issues. Same shape as
      // validateAsset's per-stage mapping (#109).
      throw new HttpsError(
        "failed-precondition",
        "Resume generation failed after retries; needs manual review.",
        { failures: err.failures, stage: "generation" },
      );
    }
    throw err;
  }
}

export const generateResumeCallable = onCall(
  {
    secrets: [anthropicKey],
    // The orchestrator runs Anthropic + Firestore reads + a
    // transactional write with a 3-attempt LLM retry budget. Was a
    // bespoke 90s, which sat ABOVE the client SDK's 70s default and
    // so was never actually reachable — the client aborted first and
    // discarded the server's error. See ./timeouts.ts (#422).
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.generateResume,
  },
  (request) => generateResumeHandler(request),
);

/**
 * Validate the callable's `applicationId` arg. Same shape as
 * validateAsset's `validateId` (#109): rejects non-string,
 * empty/whitespace, and `/`-containing values (Firestore
 * accepts `/` in ids but interprets them as sub-collection
 * boundaries). CodeRabbit Major round 1 on PR #117.
 */
function validateApplicationId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "generateResume expects { applicationId: string } with a non-empty applicationId.",
    );
  }
  const trimmed = value.trim();
  if (trimmed.includes("/")) {
    throw new HttpsError(
      "invalid-argument",
      'generateResume.applicationId must not contain "/" (Firestore path delimiter).',
    );
  }
  return trimmed;
}
