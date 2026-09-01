/**
 * Unit tests for `callableOptions` (#422).
 *
 * Codex P1 on PR #423: the helper is a new deterministic pure
 * function and nothing exercised it directly —
 * `tests/callable-timeout-budget.test.ts` only compared the two
 * constant tables. A regression in the returned options *shape*
 * would leave all five client wrappers on the SDK's 70s default
 * while the contract test still passed, silently reinstating the
 * bug this PR fixes.
 *
 * The cross-package ordering assertions live in
 * `tests/callable-timeout-budget.test.ts` — the only tsconfig
 * project that can import the server table. This file covers the
 * helper alone.
 */

import { describe, expect, it } from "vitest";

import {
  CALLABLE_TIMEOUT_MS,
  callableOptions,
  type CallableName,
} from "./callable-timeouts.ts";

const names = Object.keys(CALLABLE_TIMEOUT_MS) as CallableName[];

describe("callableOptions", () => {
  it.each(names)("%s: returns that callable's registered deadline", (name) => {
    expect(callableOptions(name)).toEqual({ timeout: CALLABLE_TIMEOUT_MS[name] });
  });

  it("returns exactly the { timeout } shape httpsCallable reads", () => {
    // The SDK reads `options.timeout || 70000`. An extra or renamed
    // key would be silently ignored and drop the call back to 70s.
    expect(Object.keys(callableOptions("extractFromResume"))).toEqual(["timeout"]);
  });

  it("returns a finite positive number for every callable", () => {
    // Boundary: 0, NaN and negative are all falsy-or-nonsense to the
    // SDK's `||` fallback, which would restore the 70s default.
    for (const name of names) {
      const { timeout } = callableOptions(name);
      expect(Number.isFinite(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(0);
    }
  });

  it("returns a fresh object each call", () => {
    // Callers hand this straight to the SDK; a shared mutable
    // singleton would let one call site's mutation leak into every
    // other callable's deadline.
    const a = callableOptions("runMatching");
    const b = callableOptions("runMatching");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("throws on an unregistered name rather than returning undefined", () => {
    // Failure mode. TypeScript makes this unrepresentable at compile
    // time, but `{ timeout: undefined }` is indistinguishable from
    // passing no options at all — it silently reinstates the 70s
    // default. A name arriving from untyped ground must fail loudly.
    expect(() => callableOptions("notACallable" as CallableName)).toThrow(
      /no client deadline registered/i,
    );
  });

  it("names the offending callable in the throw", () => {
    expect(() => callableOptions("notACallable" as CallableName)).toThrow(
      /notACallable/,
    );
  });
});
