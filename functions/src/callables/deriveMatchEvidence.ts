/**
 * HTTPS callable exposing the read-only evidence derivation
 * (#441). One call: roleId → a verdict per UnitMatch under the
 * Role → return. **Writes nothing.**
 *
 * ## Why a callable at all
 *
 * `scripts/ci/check_no_other_skill_normalization` allows only
 * `functions/src/matching/normalize.ts` to define
 * `normalizeSkill` / `normalizeTool` / `normalizeDomain`, and
 * only that module to import the `*.seed.json` ontology. That is
 * the single-source-of-truth invariant for canonical vocabulary
 * (#96), and it means the browser cannot answer "does this pair
 * overlap on a canonical skill" for itself. Hence a round-trip.
 *
 * ## Why it is read-only, emphatically
 *
 * The previous attempt (#438) wrote on Role open and drew eleven
 * review findings, nine of which existed only because of the
 * write: a lost-approval race, a cross-Role state leak, deletion
 * of the user's approval decisions, and an owner-wide permanent
 * refusal among them. This path issues three `get()`s and no
 * mutation of any kind — see `../matching/evidence-read.ts`.
 * `tests/derive-match-evidence.integration.test.ts` asserts that
 * against a live emulator by snapshotting every document across
 * the call.
 *
 * Auth-required; roleId required; same role-ownership
 * precondition as `runMatching` — the admin SDK bypasses
 * `firestore.rules`, so this auth check is the authorization
 * gate, and "not found" collapses into "not yours" so the
 * response cannot be used to enumerate role ids.
 */

import { HttpsError, onCall } from "firebase-functions/v2/https";

import { readAndDeriveEvidence } from "../matching/evidence-read.js";
import { readRoleOwnerUid } from "../matching/pipeline.js";
import { CALLABLE_TIMEOUT_SECONDS } from "./timeouts.js";

interface DeriveMatchEvidenceData {
  readonly roleId?: string;
}

export const deriveMatchEvidenceCallable = onCall(
  {
    // Pure math over already-persisted fields — no LLM, no
    // embeddings, no writes. Wall clock scales with
    // (Units × Requirements) exactly as `runMatching` does, so it
    // carries the same budget. See ./timeouts.ts (#422).
    timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.deriveMatchEvidence,
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError(
        "unauthenticated",
        "deriveMatchEvidence requires a signed-in user.",
      );
    }

    const data = request.data as DeriveMatchEvidenceData;
    const rawRoleId = data?.roleId;
    if (typeof rawRoleId !== "string" || rawRoleId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "deriveMatchEvidence expects { roleId: string } with a non-empty roleId.",
      );
    }

    const roleId = rawRoleId.trim();
    const ownerUid = request.auth.uid;

    const roleOwnerUid = await readRoleOwnerUid(roleId);
    if (roleOwnerUid === null || roleOwnerUid !== ownerUid) {
      throw new HttpsError(
        "permission-denied",
        "Role not found or not owned by caller.",
      );
    }

    const evidence = await readAndDeriveEvidence({ ownerUid, roleId });

    // Plain object rather than a Map: the callable protocol
    // serializes to JSON, and a Map would arrive as `{}`.
    return { evidence: Object.fromEntries(evidence) };
  },
);
