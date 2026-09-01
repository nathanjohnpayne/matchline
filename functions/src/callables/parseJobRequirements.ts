/**
 * HTTPS callable exposing the JD parsing pipeline. Step 2 of the
 * core loop. One call: paste → parse → embed → persist → return the
 * Requirement Units the matcher will consume.
 *
 * Auth-required; role_id required. The callable stamps `role_id` on
 * every returned Requirement so subsequent match queries scope
 * cleanly via `where("role_id", "==", ...)`.
 *
 * Rules still enforce ownership; the admin SDK persist bypasses
 * rules, so this auth check is the authorization gate.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { getAdminDb } from "../firestore/admin.js";
import { JdParsingError } from "../parsing/errors.js";
import { runJdParsingPipeline } from "../parsing/pipeline.js";
import { anthropicKey } from "../llm/anthropic.js";
import { openaiKey } from "../llm/openai.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

interface ParseJobRequirementsData {
  readonly roleId?: string;
  readonly text?: string;
}

export const parseJobRequirementsCallable = onCall(
  {
    secrets: [anthropicKey, openaiKey],
    // Not the 60s default: see ./timeouts.ts. A JD parse runs the
    // same 3-attempt / 16,384-token loop extraction does.
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.parseJobRequirements,
  },
  async (request, response) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "parseJobRequirements requires a signed-in user.",
      );
    }

    const data = request.data as ParseJobRequirementsData;
    const rawText = data?.text;
    const rawRoleId = data?.roleId;
    if (typeof rawText !== "string" || rawText.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "parseJobRequirements expects { roleId: string, text: string } with non-empty text.",
      );
    }
    if (typeof rawRoleId !== "string" || rawRoleId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "parseJobRequirements expects { roleId: string, text: string } with a non-empty roleId.",
      );
    }

    // Normalize once. Passing the untrimmed roleId downstream would
    // persist Requirements under e.g. " role-1 " while subsequent
    // queries use the canonical "role-1" — newly parsed Requirements
    // would vanish from the UI (Codex P3 on #19).
    const roleId = rawRoleId.trim();
    const text = rawText.trim();
    const ownerUid = request.auth.uid;

    // Role-ownership precondition. The admin-SDK pipeline bypasses
    // firestore.rules, so we enforce ownership here before any
    // LLM / Firestore writes. Collapses "not found" and "not yours"
    // into one message so an attacker can't enumerate which role
    // ids exist (Codex P2 on #19; also the body of #74 which this
    // closes).
    const roleSnap = await getAdminDb().collection("roles").doc(roleId).get();
    const roleOwnerUid = (roleSnap.data() as { owner_uid?: string } | undefined)
      ?.owner_uid;
    if (!roleSnap.exists || roleOwnerUid !== ownerUid) {
      throw new HttpsError(
        "permission-denied",
        "Role not found or not owned by caller.",
      );
    }

    try {
      // See extractFromResume.ts: emitting is unconditional and safe —
      // `sendChunk` resolves false for a non-streaming request (#428).
      const requirements = await runJdParsingPipeline(
        text,
        { ownerUid, roleId },
        { onProgress: (event) => void response?.sendChunk(event) },
      );
      return { requirements };
    } catch (err) {
      if (err instanceof JdParsingError) {
        throw new HttpsError(
          "failed-precondition",
          "JD parsing failed after retries; needs manual review.",
          { failures: err.failures },
        );
      }
      throw err;
    }
  },
);
