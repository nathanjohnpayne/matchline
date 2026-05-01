/**
 * Client-side wrapper around the `generateResume` callable
 * (`functions/src/callables/generateResume.ts`, registered as
 * `generateResume` per `functions/src/index.ts`).
 *
 * Wraps `httpsCallable` with the response shape the Role Detail
 * Applications tab cares about (the persisted assetId +
 * applicationId). Step 5 of the core loop. The orchestrator's
 * default loaders re-verify ownership at LLM-call time AND at
 * persist; the rules layer gates the read paths the callable's
 * pipeline takes; the callable itself enforces auth.
 *
 * Why a thin wrapper rather than calling httpsCallable inline at
 * the route: the callable name + response shape are the contract
 * with the server-side function; centralizing here means a future
 * rename or shape change touches one file. Mirrors
 * `invokeRunMatching` in `matches.ts`, `invokeValidateAsset` in
 * `validation.ts`, `invokeExtractFromResume` in `extraction.ts`,
 * and `invokeParseJobRequirements` in `requirements.ts`.
 *
 * Sub-issue #202 (front-end for #22). The Role Detail
 * Applications tab's "Generate resume" CTA is the primary
 * caller — it pre-creates an Application linked to the Role,
 * then invokes this wrapper to populate the asset.
 */

import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";

export interface GenerateResumeResponse {
  readonly assetId: string;
  readonly applicationId: string;
}

/**
 * Invoke the server-side resume-generation orchestrator.
 * Resolves to the persisted `{ assetId, applicationId }` on
 * success. The pipeline writes the AssetRef + GeneratedAssetContent
 * inside a transaction before returning, so a follow-up
 * `getApplication` will see the fresh state. The Application
 * Editor route (`/applications/:id`) takes over from there.
 *
 * Server-side error mapping (see `generateResumeCallable`):
 *   - `unauthenticated` if no auth context.
 *   - `invalid-argument` for non-string / empty / `/`-containing
 *     applicationId.
 *   - `permission-denied` if the Application doesn't exist OR
 *     isn't owned by the caller (anti-enumeration: collapsed
 *     to a single message). The CTA caller should never hit
 *     this in practice — the Application is freshly created
 *     by the same user before this call.
 *   - `failed-precondition` with `details.failures` if the
 *     pipeline exhausted its retry budget; same shape as
 *     `validateAsset`. Also fires on the no-approved-Units OR
 *     no-approved-Matches gate; the message distinguishes
 *     ("no approved ExperienceUnits" vs. "no approved
 *     UnitMatches") so the caller can render the right CTA.
 *
 * Client surfaces these via the rejection path; the
 * Applications tab decides whether to log + retry or surface
 * inline.
 */
export async function invokeGenerateResume(
  applicationId: string,
): Promise<GenerateResumeResponse> {
  const fn = httpsCallable<{ applicationId: string }, GenerateResumeResponse>(
    getFunctionsClient(),
    "generateResume",
  );
  const result = await fn({ applicationId });
  return result.data;
}
