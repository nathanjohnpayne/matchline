/**
 * HTTPS callable exposing the re-embed pipeline. Consumes a Unit
 * flagged `reembed_pending: true` (set by the service's
 * `updateFields` when a caller mutates `raw_text` or
 * `normalized_summary`, and by `buildManualUnit` when a manual
 * Unit is first inserted), regenerates its embedding from the
 * current `normalized_summary`, and clears the flag atomically
 * with the embedding write.
 *
 * Auth-required. The admin-SDK persist bypasses
 * `firestore.rules`, so the auth + ownership check below is the
 * authorization gate. Ownership failures are collapsed with
 * not-found into a single `permission-denied` response so an
 * attacker can't probe the Unit id space via differential
 * responses.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { openaiKey } from "../llm/openai.js";
import {
  ReembedEmptyInput,
  ReembedNotFoundOrForbidden,
  reembedExperienceUnit,
} from "../reembedding/reembed.js";

interface ReembedData {
  readonly unitId?: string;
}

export const reembedExperienceUnitCallable = onCall(
  {
    // The re-embed pipeline calls the OpenAI embeddings client;
    // the Anthropic secret isn't needed.
    secrets: [openaiKey],
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "reembedExperienceUnit requires a signed-in user.",
      );
    }

    const data = request.data as ReembedData;
    const rawUnitId = data?.unitId;
    if (typeof rawUnitId !== "string" || rawUnitId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "reembedExperienceUnit expects { unitId: string } with a non-empty unitId.",
      );
    }

    // Normalize once. A trailing-space id was a real gotcha in
    // the JD parsing callable (Codex P3 on #19) — same defensive
    // trim here so a caller can't accidentally pass whitespace
    // that survives into a Firestore doc path.
    const unitId = rawUnitId.trim();
    const ownerUid = request.auth.uid;

    try {
      await reembedExperienceUnit({ ownerUid, unitId });
      return { ok: true };
    } catch (err) {
      if (err instanceof ReembedNotFoundOrForbidden) {
        // Anti-enumeration: same response for "no such Unit" and
        // "Unit exists but belongs to someone else." The message
        // deliberately does not distinguish.
        throw new HttpsError(
          "permission-denied",
          "Unit not found or not owned by caller.",
        );
      }
      if (err instanceof ReembedEmptyInput) {
        throw new HttpsError(
          "failed-precondition",
          "Unit has no normalized_summary to embed.",
        );
      }
      // Embedding API transport failure (or anything else). The
      // embedding wasn't persisted; `reembed_pending` stays
      // `true` in Firestore; the caller can retry.
      throw err;
    }
  },
);
