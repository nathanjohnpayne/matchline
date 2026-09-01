/**
 * HTTPS callable exposing the validation orchestrator (#109).
 * Step 4 of the core loop. One call: applicationId + assetId →
 * extract claims → traceability + specificity per claim →
 * persist flags + status.
 *
 * Auth-required; both ids required. The orchestrator's default
 * loaders re-verify ownership inside the transaction, but the
 * callable also rejects unauthorized calls up front (defense in
 * depth, same shape as parseJobRequirements / runMatching).
 *
 * No LLM secrets are scoped explicitly here — the underlying
 * checks call modelFor("validation") and use the existing
 * anthropic() factory which reads from the standard secret.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { anthropicKey } from "../llm/anthropic.js";
import {
  ClaimExtractionError,
  SpecificityCheckError,
  TraceabilityCheckError,
} from "../validation/errors.js";
import {
  validateAsset as runValidateAsset,
  ValidateAssetMissingContent,
  ValidateAssetNotFound,
  ValidateAssetStale,
} from "../validation/validate.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

interface ValidateAssetData {
  readonly applicationId?: string;
  readonly assetId?: string;
}

export const validateAssetCallable = onCall(
  {
    secrets: [anthropicKey],
    // Not the 60s default: several Sonnet passes per invocation,
    // each with its own retry budget. See ./timeouts.ts (#422).
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.validateAsset,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "validateAsset requires a signed-in user.",
      );
    }

    const data = request.data as ValidateAssetData;
    const rawApplicationId = data?.applicationId;
    const rawAssetId = data?.assetId;
    const applicationId = validateId("applicationId", rawApplicationId);
    const assetId = validateId("assetId", rawAssetId);

    const ctx = {
      ownerUid: request.auth.uid,
      applicationId,
      assetId,
    };

    try {
      const result = await runValidateAsset(ctx);
      // Strip `content_snapshot` — it's an internal
      // TOCTOU-detection field, not part of the public response.
      const { content_snapshot: _snapshot, ...publicResult } = result;
      return publicResult;
    } catch (err) {
      if (err instanceof ValidateAssetNotFound) {
        // Anti-enumeration: same `permission-denied` shape as
        // parseJobRequirements / runMatching. The orchestrator's
        // ValidateAssetNotFound is thrown for both "missing
        // application" and "wrong owner" — collapsing them here
        // means an attacker can't probe for ids.
        throw new HttpsError(
          "permission-denied",
          "Application or asset not found, or not owned by caller.",
        );
      }
      if (err instanceof ValidateAssetMissingContent) {
        throw new HttpsError(
          "failed-precondition",
          "Asset has no generated content yet; run generation before validation.",
        );
      }
      if (err instanceof ValidateAssetStale) {
        // The orchestrator detected a TOCTOU edit (asset content
        // changed during validation). Surface to the caller so
        // the editor can re-trigger validation against the
        // fresh content. CodeRabbit Major round 1 on PR #117.
        throw new HttpsError(
          "aborted",
          "Asset content changed during validation; re-run validateAsset.",
        );
      }
      // Per-stage retry-budget-exhausted errors. Each module
      // throws its own error class after MAX_ATTEMPTS schema/
      // transport failures (mirrors the JdParsingError pattern
      // in parseJobRequirements). Surface as
      // `failed-precondition` with the per-attempt failure
      // detail attached so the editor surface (#24) can show
      // which stage broke and which attempts saw which Zod
      // issues. cursor CHANGES_REQUESTED round 2 on #117.
      if (err instanceof ClaimExtractionError) {
        throw new HttpsError(
          "failed-precondition",
          "Claim extraction failed after retries; needs manual review.",
          { failures: err.failures, stage: "claim_extraction" },
        );
      }
      if (err instanceof TraceabilityCheckError) {
        throw new HttpsError(
          "failed-precondition",
          "Traceability check failed after retries; needs manual review.",
          { failures: err.failures, stage: "traceability" },
        );
      }
      if (err instanceof SpecificityCheckError) {
        throw new HttpsError(
          "failed-precondition",
          "Specificity check failed after retries; needs manual review.",
          { failures: err.failures, stage: "specificity" },
        );
      }
      throw err;
    }
  },
);

/**
 * Validate one of the callable's id args. Rejects empty/
 * whitespace inputs AND inputs containing `/` (Firestore
 * document IDs cannot contain `/`; rejecting here keeps the
 * failure at the callable boundary with a clear
 * `invalid-argument` error).
 * CodeRabbit Major round 1 on PR #117.
 */
function validateId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      `validateAsset expects { applicationId: string, assetId: string } with non-empty ${name}.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.includes("/")) {
    throw new HttpsError(
      "invalid-argument",
      `validateAsset.${name} must not contain "/" (Firestore path delimiter).`,
    );
  }
  return trimmed;
}
