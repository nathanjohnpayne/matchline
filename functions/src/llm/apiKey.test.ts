/**
 * Unit tests for `normalizeApiKey` (#426).
 *
 * The regression: both provider secrets in `matchline-dev` were stored
 * with a trailing newline, so the SDK sent `x-api-key: sk-ant-…\n` and
 * every call failed in under a second. The first case below is the
 * exact production byte pattern.
 */

import { describe, expect, it } from "vitest";

import { normalizeApiKey } from "./apiKey.ts";

describe("normalizeApiKey", () => {
  it("strips the trailing newline that broke production", () => {
    // 109 raw bytes vs 108 stripped — what Secret Manager held.
    expect(normalizeApiKey("sk-ant-abc123\n")).toBe(
      "sk-ant-abc123",
    );
  });

  it("returns a clean key unchanged", () => {
    expect(normalizeApiKey("sk-ant-abc123")).toBe(
      "sk-ant-abc123",
    );
  });

  it("strips CRLF, leading whitespace, and surrounding spaces", () => {
    // A key pasted from a Windows-authored file or an editor that
    // added indentation is the same class of fault.
    expect(normalizeApiKey("sk-abc\r\n")).toBe("sk-abc");
    expect(normalizeApiKey("  sk-abc  ")).toBe("sk-abc");
    expect(normalizeApiKey("\n\tsk-abc\n")).toBe("sk-abc");
  });

  it("preserves internal characters, including hyphens and underscores", () => {
    const key = "sk-ant-api03_ABC-def_123";
    expect(normalizeApiKey(`${key}\n`)).toBe(key);
  });

  it("returns an empty string for empty or whitespace-only input", () => {
    // Boundary. Deliberately does NOT throw — see the module
    // docstring: client construction happens before input validation
    // in runGenerationPipeline, so throwing here would mask unrelated
    // domain errors with a credential error. An empty key surfaces as
    // transport_error via logRetryExhaustion instead.
    expect(normalizeApiKey("")).toBe("");
    expect(normalizeApiKey("   \n\t ")).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(normalizeApiKey(undefined)).toBe("");
  });

  it("never throws, for any input", () => {
    for (const v of ["", "  ", undefined, "\n", "sk-x"]) {
      expect(() => normalizeApiKey(v)).not.toThrow();
    }
  });
});
