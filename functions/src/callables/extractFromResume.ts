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
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

interface ExtractFromResumeData {
  readonly text?: string;
}

export const extractFromResumeCallable = onCall(
  {
    // Secret binding: the pipeline's Anthropic client (extraction)
    // and OpenAI client (embeddings) both resolve their API keys
    // via Firebase secret params at call time. Listing both here
    // materializes the secrets into the function's runtime env.
    secrets: [anthropicKey, openaiKey],
    // Not the 60s default: see ./timeouts.ts for why, and for
    // the client-side deadline that has to stay above it.
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.extractFromResume,
  },
  async (request, response) => {
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
    // `response` is undefined for a non-streaming invocation, and
    // `sendChunk` resolves false rather than throwing when the request
    // did not ask for a stream — so emitting unconditionally is safe
    // and an older client is unaffected. `safeProgress` in
    // llm/progress.ts additionally guarantees a rejected send (client
    // disconnected mid-call) cannot fail work already paid for.
      const units = await runExtractionPipeline(
        text,
        { ownerUid: request.auth.uid },
        { onProgress: (event) => void response?.sendChunk(event) },
      );
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
