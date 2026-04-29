/**
 * Client-side wrapper around the `validateAsset` callable
 * (`functions/src/callables/validateAsset.ts`, registered as
 * `validateAsset` per `functions/src/index.ts:41`).
 *
 * Wraps `httpsCallable` with the response shape the editor cares
 * about (status + flags + validated_at). The orchestrator strips
 * `content_snapshot` server-side before returning.
 *
 * Why a thin wrapper rather than calling httpsCallable inline at
 * the route: the callable name + response shape are the contract
 * with the server-side function; centralizing here means a
 * future rename or shape change touches one file. Mirrors the
 * `invokeRunMatching` shape in `matches.ts`.
 *
 * The Application Editor's inline-edit flow (#24, sub-issue #188)
 * is the primary caller: after a bullet edit flips the asset's
 * `validation_status` to "stale" via `editBulletInAsset`, this
 * call re-runs the orchestrator to compute fresh flags + flip
 * the status back to "passed" or "failed".
 */

import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";
import type { ValidationFlag, ValidationStatus } from "../types/crm.ts";

export interface ValidateAssetResponse {
  readonly status: ValidationStatus;
  readonly flags: readonly ValidationFlag[];
  readonly validated_at: string;
}

/**
 * Invoke the server-side validateAsset orchestrator. Resolves to
 * the public result on success (server-side persists flags +
 * status + validated_at to the asset before returning, so a
 * follow-up `getApplication` will see the fresh state).
 *
 * Server-side error mapping (see `validateAssetCallable`):
 *   - `unauthenticated` if no auth context
 *   - `invalid-argument` for missing/malformed ids
 *   - `permission-denied` for foreign / not-found applicationId/assetId
 *   - `failed-precondition` if asset has no generated content yet,
 *     OR if a per-stage retry budget exhausted (claim extraction /
 *     traceability / specificity)
 *   - `aborted` if content changed during validation (TOCTOU)
 * Client surfaces these via the rejection path; the caller decides
 * whether to log + retry or surface inline.
 */
export async function invokeValidateAsset(
  applicationId: string,
  assetId: string,
): Promise<ValidateAssetResponse> {
  const fn = httpsCallable<
    { applicationId: string; assetId: string },
    ValidateAssetResponse
  >(getFunctionsClient(), "validateAsset");
  const result = await fn({ applicationId, assetId });
  return result.data;
}
