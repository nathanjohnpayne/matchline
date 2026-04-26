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
    if (
      typeof rawApplicationId !== "string" ||
      rawApplicationId.trim().length === 0
    ) {
      throw new HttpsError(
        "invalid-argument",
        "validateAsset expects { applicationId: string, assetId: string } with non-empty applicationId.",
      );
    }
    if (typeof rawAssetId !== "string" || rawAssetId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "validateAsset expects { applicationId: string, assetId: string } with non-empty assetId.",
      );
    }

    const ctx = {
      ownerUid: request.auth.uid,
      applicationId: rawApplicationId.trim(),
      assetId: rawAssetId.trim(),
    };

    try {
      const result = await runValidateAsset(ctx);
      return result;
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
      throw err;
    }
  },
);
