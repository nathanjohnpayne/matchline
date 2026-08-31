/**
 * Cross-package timeout-budget contract for `extractFromResume`
 * (#422).
 *
 * The bug this pins: `extractFromResumeCallable` ran on Firebase
 * Functions v2's default 60s `timeoutSeconds` while its pipeline
 * needs minutes on a real resume. Cloud Run killed the request, the
 * terminated response carried no CORS headers, the browser's `fetch`
 * rejected, and `@firebase/functions` surfaced a bare `internal`.
 *
 * Two numbers have to stay in a specific relationship for the fix to
 * hold, and they live in different packages — the server budget in
 * `functions/src/callables/`, the client deadline in `src/services/`.
 * Nothing but this test connects them, so nothing but this test stops
 * a future edit to one from silently invalidating the other.
 *
 * Lives under `tests/` rather than beside either module because it is
 * the only tsconfig project that spans both (see the scope note in
 * `tsconfig.tests.json`).
 */

import { describe, expect, it } from "vitest";

import { EXTRACT_TIMEOUT_SECONDS } from "../functions/src/callables/extractFromResume.ts";
import { EXTRACT_CALL_TIMEOUT_MS } from "../src/services/extraction.ts";

/** `@firebase/functions` `callAtURL`: `options.timeout || 70000`. */
const SDK_DEFAULT_CLIENT_TIMEOUT_MS = 70_000;

/** Firebase Functions v2 default when `timeoutSeconds` is omitted. */
const FIREBASE_DEFAULT_TIMEOUT_SECONDS = 60;

describe("extractFromResume timeout budget", () => {
  it("gives the server more than the Firebase default", () => {
    // The regression itself: leaving this at the default is what
    // produced the bare "internal" banner on /onboarding.
    expect(EXTRACT_TIMEOUT_SECONDS).toBeGreaterThan(
      FIREBASE_DEFAULT_TIMEOUT_SECONDS,
    );
  });

  it("gives the client more than the SDK default", () => {
    // Raising only the server budget moves the failure rather than
    // fixing it — the client would abort at 70s with
    // `deadline-exceeded` instead.
    expect(EXTRACT_CALL_TIMEOUT_MS).toBeGreaterThan(
      SDK_DEFAULT_CLIENT_TIMEOUT_MS,
    );
  });

  it("holds the client deadline strictly above the server budget", () => {
    // Whichever side gives up first decides what the user sees. The
    // client must lose that race so the server's structured
    // HttpsError (with its retry diagnostics) reaches the UI.
    expect(EXTRACT_CALL_TIMEOUT_MS).toBeGreaterThan(
      EXTRACT_TIMEOUT_SECONDS * 1000,
    );
  });

  it("leaves the client enough margin for Cloud Run's response tail", () => {
    // A margin of a second or two would technically satisfy the
    // ordering above while still racing the server's teardown. Pin a
    // real floor so a future trim can't erode it to nothing.
    const marginMs = EXTRACT_CALL_TIMEOUT_MS - EXTRACT_TIMEOUT_SECONDS * 1000;
    expect(marginMs).toBeGreaterThanOrEqual(15_000);
  });

  it("stays inside the Cloud Run v2 ceiling", () => {
    // Firebase rejects a deploy above 3600s for a 2nd-gen function;
    // a too-large value fails at deploy time, not at test time.
    expect(EXTRACT_TIMEOUT_SECONDS).toBeLessThanOrEqual(3600);
  });
});
