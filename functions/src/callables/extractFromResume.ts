/**
 * HTTPS callable that exposes the extraction pipeline to the
 * frontend. One call does Step 1 of the core loop end-to-end:
 *
 *   paste → extract → embed → persist → return the Units
 *
 * Auth-required: every call must carry a resolved Firebase Auth uid
 * — the core extraction stamps `owner_uid` from this value so
 * `firestore.rules` accepts the resulting Unit writes and the
 * embeddings carry the same caller context for cost attribution.
 *
 * The pipeline's persist step uses the admin SDK (bypasses rules),
 * so the auth check below is the authorization gate.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { runExtractionPipeline } from "../extraction/pipeline.js";
import { ExtractionError } from "../extraction/errors.js";
import { anthropicKey } from "../llm/anthropic.js";
import { openaiKey } from "../llm/openai.js";

interface ExtractFromResumeData {
  readonly text?: string;
}

/**
 * Wall-clock budget for one `extractFromResume` invocation.
 *
 * **Why this is not the default.** Firebase Functions v2 defaults
 * `timeoutSeconds` to 60. The pipeline behind this callable cannot
 * finish in 60s on a real resume: `extraction/resume.ts` runs up to
 * `MAX_ATTEMPTS` (3) Anthropic calls at `MAX_OUTPUT_TOKENS`
 * (16,384), and that module's own comment records that Nathan's
 * 9k-character resume serializes to ~10-12k output tokens — a
 * multi-minute single call before any retry fires. Embeddings and
 * the Firestore batch commit land on top of that.
 *
 * When the budget is exceeded, Cloud Run kills the container
 * mid-request. The terminated response never gets the CORS headers
 * the callable protocol needs, so the browser's `fetch` rejects and
 * the client SDK reports a bare `internal` with no diagnostic —
 * which is exactly the failure #422 reported from `/onboarding`.
 *
 * **Why 540 and not more.** 540s (9 min) covers a full-length first
 * attempt plus one full-length retry, with room for the embed +
 * persist tail. A pathological run that burns all three attempts at
 * the token ceiling can still exceed it; that is a deliberate
 * trade — the alternative is making a user wait ~13 minutes to be
 * told extraction failed. Reducing the wall clock itself (streaming,
 * chunking the resume, or a tighter output budget) is the real
 * long-term fix and is tracked separately.
 *
 * Exported so `tests/extract-timeout-budget.test.ts` can assert the
 * client-side callable timeout in `src/services/extraction.ts` stays
 * strictly greater than this value. If the client gives up first,
 * the server's structured `HttpsError` is lost and the user sees a
 * bare code again.
 */
export const EXTRACT_TIMEOUT_SECONDS = 540;

export const extractFromResumeCallable = onCall(
  {
    // Secret binding: the pipeline's Anthropic client (extraction)
    // and OpenAI client (embeddings) both resolve their API keys
    // via Firebase secret params at call time. Listing both here
    // materializes the secrets into the function's runtime env.
    secrets: [anthropicKey, openaiKey],
    timeoutSeconds: EXTRACT_TIMEOUT_SECONDS,
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
      // Full pipeline: extract → embed → persist → return.
      const units = await runExtractionPipeline(text, {
        ownerUid: request.auth.uid,
      });
      return { units };
    } catch (err) {
      if (err instanceof ExtractionError) {
        // Extraction retries exhausted. Surface as "needs manual
        // review" per spec § Execution targets / Reliability.
        // The failure list rides along so the frontend can show
        // per-attempt diagnostics and the eval harness can score
        // retries.
        throw new HttpsError(
          "failed-precondition",
          "Extraction failed after retries; needs manual review.",
          { failures: err.failures },
        );
      }
      // Non-ExtractionError paths (embedding failure, Firestore
      // write failure, transport error downstream of extraction)
      // bubble as internal — the frontend retries from scratch.
      throw err;
    }
  },
);
