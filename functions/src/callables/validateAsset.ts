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
  validateAsset as runValidateAsset,
  ValidateAssetMissingContent,
  ValidateAssetNotFound,
  ValidateAssetStale,
} from "../validation/validate.js";

interface ValidateAssetData {
  readonly applicationId?: string;
  readonly assetId?: string;
}

export const validateAssetCallable = onCall(
  {
    secrets: [anthropicKey],
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
      throw err;
    }
  },
);

/**
 * Validate one of the callable's id args. Rejects empty/
 * whitespace inputs AND inputs containing `/` (Firestore
 * accepts `/` in ids but interprets them as sub-collection
 * boundaries — passing one would either fail downstream in a
 * confusing way OR, worse, navigate to an unintended path).
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
