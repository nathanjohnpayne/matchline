/**
 * Client-side wrapper around the `parseJobRequirements` callable
 * (`functions/src/callables/parseJobRequirements.ts`, registered
 * as `parseJobRequirements` per `functions/src/index.ts`).
 *
 * Wraps `httpsCallable` with the response shape the Role Detail
 * Requirements tab cares about (the persisted Requirement Units).
 * Same Step-2-of-the-core-loop contract as #199's resume-extract:
 * one call → parse → embed → persist → return. By the time this
 * resolves, the Requirements are in Firestore + the Role Detail
 * subscription will deliver them to the tab.
 *
 * Why a thin wrapper rather than calling httpsCallable inline at
 * the route: the callable name + response shape are the contract
 * with the server-side function; centralizing here means a future
 * rename or shape change touches one file. Mirrors
 * `invokeRunMatching` in `matches.ts`, `invokeValidateAsset` in
 * `validation.ts`, and `invokeExtractFromResume` in
 * `extraction.ts`.
 *
 * Sub-issue #201 (front-end for #19). The Requirements tab's
 * "Parse JD" / "Re-parse JD" buttons are the primary callers.
 */

import { httpsCallable } from "firebase/functions";

import { getFunctionsClient } from "../firebase.ts";
import type { JobRequirementUnit } from "../types/capability.ts";

export interface ParseJobRequirementsResponse {
  readonly requirements: readonly JobRequirementUnit[];
}

/**
 * Invoke the server-side JD parsing pipeline. Resolves to the
 * persisted Requirements on success (the pipeline writes them to
 * Firestore before returning, so a follow-up Role Detail
 * subscription will see them).
 *
 * Server-side error mapping (see `parseJobRequirementsCallable`):
 *   - `unauthenticated` if no auth context.
 *   - `invalid-argument` for empty / non-string text or roleId.
 *   - `permission-denied` if the Role doesn't exist OR isn't
 *     owned by the caller (anti-enumeration: collapsed to a
 *     single message so an attacker can't probe role-id space).
 *     The client surfaces this as the same "Role not found, or
 *     not owned by you" path the `getRole` reader uses.
 *   - `failed-precondition` if the parsing pipeline exhausted
 *     its retry budget. Carries `details.failures` with per-
 *     attempt diagnostics.
 *
 * Client surfaces these via the rejection path; the Requirements
 * tab decides whether to log + retry or surface inline.
 */
export async function invokeParseJobRequirements(
  roleId: string,
  text: string,
): Promise<ParseJobRequirementsResponse> {
  const fn = httpsCallable<
    { roleId: string; text: string },
    ParseJobRequirementsResponse
  >(getFunctionsClient(), "parseJobRequirements");
  const result = await fn({ roleId, text });
  return result.data;
}
