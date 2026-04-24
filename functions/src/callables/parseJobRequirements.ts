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

import { JdParsingError } from "../parsing/errors.js";
import { runJdParsingPipeline } from "../parsing/pipeline.js";
import { anthropicKey } from "../llm/anthropic.js";
import { openaiKey } from "../llm/openai.js";

interface ParseJobRequirementsData {
  readonly roleId?: string;
  readonly text?: string;
}

export const parseJobRequirementsCallable = onCall(
  {
    secrets: [anthropicKey, openaiKey],
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "parseJobRequirements requires a signed-in user.",
      );
    }

    const data = request.data as ParseJobRequirementsData;
    const text = data?.text;
    const roleId = data?.roleId;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "parseJobRequirements expects { roleId: string, text: string } with non-empty text.",
      );
    }
    if (typeof roleId !== "string" || roleId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "parseJobRequirements expects { roleId: string, text: string } with a non-empty roleId.",
      );
    }

    try {
      const requirements = await runJdParsingPipeline(text, {
        ownerUid: request.auth.uid,
        roleId,
      });
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
