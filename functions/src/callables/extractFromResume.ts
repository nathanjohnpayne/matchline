/**
 * HTTPS callable that exposes `extractFromResume` to the frontend.
 *
 * Auth-required: every call must carry a resolved Firebase Auth uid
 * — the core extraction stamps `owner_uid` from this value so
 * `firestore.rules` accepts the resulting Unit writes.
 *
 * Note: this callable does NOT persist or embed. That's #68's
 * pipeline. Returning the Units keeps the callable small; the
 * caller (Unit Review surface) can persist via the service layer
 * or #68 can chain.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { extractFromResume } from "../extraction/resume.js";
import { ExtractionError } from "../extraction/errors.js";
import { anthropicKey } from "../llm/anthropic.js";

interface ExtractFromResumeData {
  readonly text?: string;
}

export const extractFromResumeCallable = onCall(
  {
    // Secret binding: the Anthropic client at call time resolves the
    // API key via the `anthropicKey` param defined in `llm/anthropic.ts`.
    // Listing it here materializes the secret into the function's
    // runtime environment.
    secrets: [anthropicKey],
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "extractFromResume requires a signed-in user.",
      );
    }

    const data = request.data as ExtractFromResumeData;
    const text = data?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "extractFromResume expects { text: string } with non-empty content.",
      );
    }

    try {
      const units = await extractFromResume(text, { ownerUid: request.auth.uid });
      return { units };
    } catch (err) {
      if (err instanceof ExtractionError) {
        // All retries exhausted. Surface as "needs manual review"
        // per spec § Execution targets / Reliability. The failure
        // list rides along so the frontend can show per-attempt
        // diagnostics (and the eval harness can score retries).
        throw new HttpsError(
          "failed-precondition",
          "Extraction failed after retries; needs manual review.",
          { failures: err.failures },
        );
      }
      throw err;
    }
  },
);
