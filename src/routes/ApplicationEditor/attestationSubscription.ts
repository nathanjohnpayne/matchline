/**
 * Which server attestation the editor listens to, and when it must
 * open a fresh listener (#502). Extracted from the container so the
 * restart rule is testable without a React harness, the same pattern
 * as `RoleDetail/autoTriggerGate.ts`.
 *
 * - `recordKey` names the record: the asset and the fingerprint of its
 *   current content. A loaded record is only ever shown for the key it
 *   was loaded under.
 * - `restartKey` decides when the listener is re-opened. It covers the
 *   record and the verdict's `validated_at`: Firestore ends a listener
 *   after an error and never retries, so without re-subscribing on a
 *   new verdict, a rules rollout or auth blip would leave Export
 *   blocked even after a successful re-run wrote the record (Codex on
 *   #506). An application refetch that changes neither leaves it, and
 *   the listener, untouched.
 */

import { validationAttestationId } from "../../../functions/src/validation/attestation.ts";

export interface AttestationSubscription {
  readonly applicationId: string;
  readonly assetId: string;
  readonly contentVersion: string;
  readonly recordKey: string;
  readonly restartKey: string;
}

export function attestationSubscription(
  applicationId: string | undefined,
  assetId: string | undefined,
  contentVersion: string | null,
  validatedAt: string | undefined,
): AttestationSubscription | null {
  if (applicationId === undefined || assetId === undefined || contentVersion === null) return null;
  const recordKey = validationAttestationId(assetId, contentVersion);
  return {
    applicationId,
    assetId,
    contentVersion,
    recordKey,
    restartKey: JSON.stringify([applicationId, recordKey, validatedAt ?? null]),
  };
}
