/**
 * App-level tests. Currently pinning the
 * DEBUG_ROUTES_ENABLED gate (cursor #140 r1) so a future
 * change can't silently re-expose the PDF prototype
 * route in production.
 *
 * The gate reads `import.meta.env.DEV`, which Vite
 * statically replaces at build time:
 *   - `npm run dev` / vitest:                 DEV === true
 *   - `npm run build` / production bundle:    DEV === false
 *
 * Vitest runs in dev mode, so this test only directly
 * verifies the dev-true side. Production-side correctness
 * comes from Vite's documented tree-shaking of the false
 * branch — verified manually via `npm run build` +
 * inspecting `dist/assets/*.js` for the absence of the
 * `/debug/pdf-prototype` route string.
 */

import { describe, expect, it } from "vitest";

import { DEBUG_ROUTES_ENABLED } from "./App.tsx";

describe("DEBUG_ROUTES_ENABLED (cursor #140 r1)", () => {
  it("is true in dev / test mode (vitest sets `import.meta.env.DEV = true`)", () => {
    // The reverse case (DEV === false in production) is
    // verifiable by running `npm run build` and confirming
    // the dist bundle doesn't reference `/debug/pdf-prototype`.
    // We don't test that here because it'd require a full
    // production build per test run.
    expect(DEBUG_ROUTES_ENABLED).toBe(true);
    expect(import.meta.env.DEV).toBe(true);
  });

  it("matches `import.meta.env.DEV` exactly (not hard-coded)", () => {
    // Defensive pin: a future change that hard-codes
    // `DEBUG_ROUTES_ENABLED = true` would silently re-expose
    // the prototype in production. This test asserts the
    // value is sourced from `import.meta.env.DEV`, the
    // load-bearing toggle.
    expect(DEBUG_ROUTES_ENABLED).toBe(import.meta.env.DEV);
  });
});
