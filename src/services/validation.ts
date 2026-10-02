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

import { doc, onSnapshot, type Unsubscribe } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";

import { getDb, getFunctionsClient } from "../firebase.ts";
import {
  VALIDATIONS_SUBCOLLECTION,
  validationAttestationId,
  type ValidationAttestation,
} from "../../functions/src/validation/attestation.ts";
import { callableOptions } from "./callable-timeouts.ts";
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
  >(
    getFunctionsClient(),
    "validateAsset",
    callableOptions("validateAsset"),
  );
  const result = await fn({ applicationId, assetId });
  return result.data;
}

/**
 * Subscribe to the server's validation attestation for one asset at
 * one content version (#502): `applications/{applicationId}/
 * validations/{assetId}__{contentVersion}`, written only by
 * `validateAsset`. Delivers `null` while the server holds no verdict
 * for that content, and the record once a run attests it.
 *
 * The caller re-subscribes when the asset's content (and so its
 * `assetContentVersion`) changes. Read-only: `firestore.rules`
 * allows no client write.
 */
export function subscribeValidationAttestation(
  applicationId: string,
  assetId: string,
  contentVersion: string,
  callback: (attestation: ValidationAttestation | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const ref = doc(
    getDb(),
    "applications",
    applicationId,
    VALIDATIONS_SUBCOLLECTION,
    validationAttestationId(assetId, contentVersion),
  );
  return onSnapshot(
    ref,
    (snap) => callback(snap.exists() ? (snap.data() as ValidationAttestation) : null),
    onError,
  );
}
