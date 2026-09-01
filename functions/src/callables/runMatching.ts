/**
 * HTTPS callable exposing the matching pipeline. Step 3 of the
 * core loop. One call: roleId → score every approved Unit
 * against every Requirement under the Role → atomically
 * replace the persisted match set → return.
 *
 * Auth-required; role_id required. Same role-ownership
 * precondition as `parseJobRequirements` — the admin SDK persist
 * bypasses rules, so this auth check is the authorization gate.
 *
 * No LLM secrets needed at V1: scoring is pure math over cached
 * embeddings (#97 + #98). The rationale-string LLM call is
 * deferred to #100 and gets its own callable.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { runMatchingPipeline, readRoleOwnerUid } from "../matching/pipeline.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

interface RunMatchingData {
  readonly roleId?: string;
}

export const runMatchingCallable = onCall(
  {
    // Not the 60s default: no LLM call, but wall clock scales with
    // (approved Units × Requirements). See ./timeouts.ts (#422).
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.runMatching,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "runMatching requires a signed-in user.",
      );
    }

    const data = request.data as RunMatchingData;
    const rawRoleId = data?.roleId;
    if (typeof rawRoleId !== "string" || rawRoleId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "runMatching expects { roleId: string } with a non-empty roleId.",
      );
    }

    const roleId = rawRoleId.trim();
    const ownerUid = request.auth.uid;

    // Role-ownership precondition. Mirrors `parseJobRequirements`.
    // Collapses "not found" and "not yours" into one message so an
    // attacker can't enumerate which role ids exist (the shape
    // Codex P2 caught on #19).
    const roleOwnerUid = await readRoleOwnerUid(roleId);
    if (roleOwnerUid === null || roleOwnerUid !== ownerUid) {
      throw new HttpsError(
        "permission-denied",
        "Role not found or not owned by caller.",
      );
    }

    const matches = await runMatchingPipeline({ ownerUid, roleId });
    return { matches };
  },
);
