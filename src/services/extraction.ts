/**
 * Client-side wrapper around the `extractFromResume` callable
 * (`functions/src/callables/extractFromResume.ts`, registered as
 * `extractFromResume` per `functions/src/index.ts:16`).
 *
 * Wraps `httpsCallable` with the response shape the Onboarding
 * route cares about (the persisted Units). The callable's pipeline
 * does Step 1 of the core loop end-to-end: extract → embed →
 * persist → return. By the time this resolves, the Units are in
 * Firestore + the Unit Review subscription will deliver them to
 * `/units`.
 *
 * Why a thin wrapper rather than calling httpsCallable inline at
 * the route: the callable name + response shape are the contract
 * with the server-side function; centralizing here means a future
 * rename or shape change touches one file. Mirrors
 * `invokeRunMatching` in `matches.ts` and `invokeValidateAsset`
 * in `validation.ts`.
 *
 * Sub-issue #199 (front-end for #17). Onboarding's paste-resume
 * UI is the primary caller.
 */

import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";
import { callableOptions } from "./callable-timeouts.ts";
import { parseProgressEvent, type ProgressEvent } from "./progress.ts";
import type { ExperienceUnit } from "../types/capability.ts";

export interface ExtractFromResumeResponse {
  readonly units: readonly ExperienceUnit[];
}

/**
 * Invoke the server-side extraction pipeline. Resolves to the
 * persisted Units on success (the pipeline writes them to
 * Firestore before returning, so a follow-up Unit Review
 * subscription will see them).
 *
 * Server-side error mapping (see `extractFromResumeCallable`):
 *   - `unauthenticated` if no auth context.
 *   - `invalid-argument` for empty / non-string text.
 *   - `failed-precondition` if the extraction pipeline exhausted
 *     its retry budget. Carries `details.failures` with per-
 *     attempt diagnostics.
 *
 * Client surfaces these via the rejection path; the Onboarding
 * route decides whether to log + retry or surface inline.
 */
export async function invokeExtractFromResume(
  text: string,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ExtractFromResumeResponse> {
  const fn = httpsCallable<
    { text: string },
    ExtractFromResumeResponse,
    unknown
  >(
    getFunctionsClient(),
    "extractFromResume",
    callableOptions("extractFromResume"),
  );

  if (onProgress === undefined) {
    const result = await fn({ text });
    return result.data;
  }

  // Streaming path (#428). The server emits a chunk per stage and per
  // retry attempt so the UI can report what is actually happening
  // across a ~108s call.
  //
  // **The deadline has to be re-supplied here.** `HttpsCallableStreamOptions`
  // has no `timeout` field, and `streamAtURL` — unlike `callAtURL` —
  // races nothing: it passes only `options.signal` to `fetch`. So the
  // streaming path silently escapes BOTH the SDK's 70s default (which
  // is what we want, since extraction runs longer than that) and the
  // explicit budget from #424 (which we do not want, because it leaves
  // a hung connection waiting forever). Driving an AbortSignal from
  // the same table keeps one source of truth for both paths.
  const { stream, data } = await fn.stream(
    { text },
    { signal: AbortSignal.timeout(callableOptions("extractFromResume").timeout) },
  );

  for await (const chunk of stream) {
    // Unrecognized chunks are dropped rather than rendered: the
    // deployed function is not necessarily the version this client was
    // built against (#422 made that concrete).
    const event = parseProgressEvent(chunk);
    if (event !== null) onProgress(event);
  }

  return await data;
}
