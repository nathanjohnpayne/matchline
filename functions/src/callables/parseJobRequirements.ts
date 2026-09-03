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
      // Streaming progress (#428). Emitting is unconditional and safe:
      // `response` is undefined for a non-streaming invocation, and
      // `sendChunk` resolves false rather than throwing when the
      // request did not ask for a stream, so an older client is
      // unaffected.
      //
      // `.catch`, not `void`. `sendChunk` returns a promise that can
      // reject asynchronously on a write error — a client that
      // disconnected mid-call is the common case — and by then
      // `safeProgress`'s synchronous try/catch has already returned,
      // so it cannot see it. A discarded rejection becomes an
      // unhandled rejection, which on Node 20 can terminate an
      // otherwise successful, already-paid-for call. Codex P1 on
      // PR #436.
      const requirements = await runJdParsingPipeline(
        text,
        { ownerUid, roleId },
        {
          onProgress: (event) => {
            response?.sendChunk(event).catch(() => {});
          },
          // Bounds wasted work when the client disconnects: the retry
          // loop stops starting NEW attempts. Deliberately NOT a gate
          // on persistence — a completed extraction is already paid
          // for, and the Units are what the user returns to. Throwing
          // them away would maximise the waste rather than bound it
          // (CodeRabbit P1, #436).
          signal: response?.signal,
        },
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
