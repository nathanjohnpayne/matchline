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
import type { ExperienceUnit } from "../types/capability.ts";

export interface ExtractFromResumeResponse {
  readonly units: readonly ExperienceUnit[];
}

/**
 * Client-side deadline for the `extractFromResume` call, in ms.
 *
 * **Why this is not the default.** `httpsCallable` defaults to a
 * 70,000 ms client timeout (`@firebase/functions`
 * `callAtURL`: `options.timeout || 70000`). Extraction on a real
 * resume runs for minutes — see `EXTRACT_TIMEOUT_SECONDS` in
 * `functions/src/callables/extractFromResume.ts` — so leaving the
 * default here would just move #422's failure from the server to
 * the client and re-surface it as `deadline-exceeded`.
 *
 * **Why it must exceed the server budget.** Whichever side gives up
 * first decides what the user sees. If the client aborts, the SDK
 * synthesizes its own error and the server's structured
 * `HttpsError` — including the `failed-precondition` retry
 * diagnostics this module documents below — is thrown away. Holding
 * the client strictly above the server budget means a real server
 * verdict always wins the race, and the client deadline is only a
 * backstop for a connection that hangs past the point where Cloud
 * Run should have returned something.
 *
 * The 30s margin covers Cloud Run's own teardown-and-respond tail.
 * `tests/extract-timeout-budget.test.ts` pins the ordering so the
 * two values cannot drift back into conflict.
 */
export const EXTRACT_CALL_TIMEOUT_MS = 570_000;

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
): Promise<ExtractFromResumeResponse> {
  const fn = httpsCallable<{ text: string }, ExtractFromResumeResponse>(
    getFunctionsClient(),
    "extractFromResume",
    { timeout: EXTRACT_CALL_TIMEOUT_MS },
  );
  const result = await fn({ text });
  return result.data;
}
