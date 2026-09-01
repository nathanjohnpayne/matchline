/**
 * Cross-package timeout-budget contract for every HTTPS callable
 * (#422).
 *
 * The bug this pins: callables ran on Firebase Functions v2's default
 * 60s `timeoutSeconds` while their pipelines need minutes on real
 * input. Cloud Run killed the request, the terminated response
 * carried no CORS headers, the browser's `fetch` rejected, and
 * `@firebase/functions` surfaced a bare `internal`. Reported first
 * from `/onboarding` (extraction), then from Role Detail (JD parse).
 *
 * Two tables have to stay in a specific relationship for the fix to
 * hold, and they live in different packages — server budgets in
 * `functions/src/callables/timeouts.ts`, client deadlines in
 * `src/services/callable-timeouts.ts`. The client cannot import the
 * server table (separate package, separate `node_modules`), so
 * nothing but this test connects them, and nothing but this test
 * stops a future edit to one from silently invalidating the other.
 *
 * Lives under `tests/` because it is the only tsconfig project that
 * spans both (see the scope note in `tsconfig.tests.json`).
 */

import { describe, expect, it } from "vitest";

import { CALLABLE_TIMEOUT_SECONDS } from "../functions/src/callables/timeouts.ts";
import { CALLABLE_TIMEOUT_MS } from "../src/services/callable-timeouts.ts";

/** `@firebase/functions` `callAtURL`: `options.timeout || 70000`. */
const SDK_DEFAULT_CLIENT_TIMEOUT_MS = 70_000;

/** Firebase Functions v2 default when `timeoutSeconds` is omitted. */
const FIREBASE_DEFAULT_TIMEOUT_SECONDS = 60;

/** Cloud Run's ceiling for a 2nd-gen function; a larger value fails at deploy. */
const CLOUD_RUN_MAX_TIMEOUT_SECONDS = 3600;

/**
 * Margin the client must hold over the server, covering Cloud Run's
 * teardown-and-respond tail. A margin of a second or two would
 * satisfy the ordering while still racing the server's response.
 */
const MIN_CLIENT_MARGIN_MS = 15_000;

const serverNames = Object.keys(CALLABLE_TIMEOUT_SECONDS).sort();
const clientNames = Object.keys(CALLABLE_TIMEOUT_MS).sort();

describe("callable timeout budgets", () => {
  it("covers exactly the same callables on both sides", () => {
    // A callable present in one table and absent from the other is
    // silently running on that side's default — which is the whole
    // bug. Set equality is what makes adding a callable without its
    // client deadline a test failure rather than a latent regression.
    expect(clientNames).toEqual(serverNames);
  });

  it.each(serverNames)("%s: server budget beats the Firebase default", (name) => {
    expect(
      CALLABLE_TIMEOUT_SECONDS[name as keyof typeof CALLABLE_TIMEOUT_SECONDS],
    ).toBeGreaterThan(FIREBASE_DEFAULT_TIMEOUT_SECONDS);
  });

  it.each(serverNames)("%s: client deadline beats the SDK default", (name) => {
    // Raising only the server budget relocates the failure rather
    // than fixing it — the client would abort at 70s instead.
    expect(
      CALLABLE_TIMEOUT_MS[name as keyof typeof CALLABLE_TIMEOUT_MS],
    ).toBeGreaterThan(SDK_DEFAULT_CLIENT_TIMEOUT_MS);
  });

  it.each(serverNames)(
    "%s: client deadline sits strictly above the server budget",
    (name) => {
      // Whichever side gives up first decides what the user sees. The
      // client must lose that race so the server's structured
      // HttpsError, with its retry diagnostics, reaches the UI.
      //
      // generateResume is why this is a test and not a convention:
      // #124 set its server budget to 90s while the client kept the
      // 70s default, so the client aborted first on every call that
      // ran long and the server's verdict was discarded.
      const serverMs =
        CALLABLE_TIMEOUT_SECONDS[
          name as keyof typeof CALLABLE_TIMEOUT_SECONDS
        ] * 1000;
      const clientMs =
        CALLABLE_TIMEOUT_MS[name as keyof typeof CALLABLE_TIMEOUT_MS];
      expect(clientMs).toBeGreaterThan(serverMs);
      expect(clientMs - serverMs).toBeGreaterThanOrEqual(MIN_CLIENT_MARGIN_MS);
    },
  );

  it.each(serverNames)("%s: server budget stays inside the Cloud Run ceiling", (name) => {
    expect(
      CALLABLE_TIMEOUT_SECONDS[name as keyof typeof CALLABLE_TIMEOUT_SECONDS],
    ).toBeLessThanOrEqual(CLOUD_RUN_MAX_TIMEOUT_SECONDS);
  });

  it("gives extraction the largest budget of any callable", () => {
    // Extraction is the heaviest pipeline: 3 attempts at 16,384
    // output tokens over a whole resume. If another callable ever
    // outgrows it, that is worth noticing deliberately rather than
    // discovering through a timeout.
    const max = Math.max(...Object.values(CALLABLE_TIMEOUT_SECONDS));
    expect(CALLABLE_TIMEOUT_SECONDS.extractFromResume).toBe(max);
  });
});
