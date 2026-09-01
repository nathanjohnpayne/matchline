/**
 * Unit tests for `logRetryExhaustion` (#426).
 *
 * The gap this closes: every pipeline collected per-attempt failures
 * and sent them to the browser, but never to Cloud Logging. A
 * production failure left `Callable request verification passed`
 * followed by silence.
 *
 * The redaction cases below exist because the first version of this
 * module truncated provider and Zod messages to 400 characters and
 * called that redaction. It is not: Zod v4 serializes the whole issue
 * list into `error.message`, and an `unrecognized_keys` issue on a
 * `.strict()` schema carries the model's hallucinated property names
 * verbatim at the front — where a leading slice preserves them intact.
 * Since the model is transcribing a résumé, those names can be user
 * content. Codex P1 on PR #427.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const errorSpy = vi.fn();
vi.mock("firebase-functions", () => ({ logger: { error: (...a: unknown[]) => errorSpy(...a) } }));

const { logRetryExhaustion } = await import("./retryDiagnostics.ts");

beforeEach(() => errorSpy.mockClear());

function payload(): Record<string, unknown> {
  return (errorSpy.mock.calls[0] as [string, Record<string, unknown>])[1];
}

const TRANSPORT = [
  { attempt: 0, kind: "transport_error", message: '401 {"type":"error"}' },
  { attempt: 1, kind: "transport_error", message: '401 {"type":"error"}' },
  { attempt: 2, kind: "transport_error", message: '401 {"type":"error"}' },
];

/** Exactly the shape Zod produces for a hallucinated property name. */
const LEAKY_SCHEMA_FAILURE = {
  attempt: 0,
  kind: "schema_error",
  message:
    '[{"code":"unrecognized_keys","keys":["Led Disney launch on Vega OS (Kepler)",' +
    '"hire@example.com"],"path":[],"message":"Unrecognized keys: ..."}]',
  zodIssues: [
    {
      code: "unrecognized_keys",
      keys: ["Led Disney launch on Vega OS (Kepler)", "hire@example.com"],
      path: ["units", 0],
      message: 'Unrecognized keys: "Led Disney launch on Vega OS (Kepler)"',
    },
  ],
};

describe("logRetryExhaustion", () => {
  describe("core output", () => {
    it("logs once at error severity with stage and model", () => {
      logRetryExhaustion("extraction.resume", "claude-sonnet-4-6", TRANSPORT);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg, p] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(msg).toContain("retry budget exhausted");
      expect(p.stage).toBe("extraction.resume");
      expect(p.model).toBe("claude-sonnet-4-6");
    });

    it("surfaces failure kinds as their own field", () => {
      // The field that separates a credential fault from a prompt
      // fault at a glance — the distinction that would have made
      // #422's diagnosis immediate.
      logRetryExhaustion("extraction.resume", "m", TRANSPORT);
      expect(payload().kinds).toEqual([
        "transport_error",
        "transport_error",
        "transport_error",
      ]);
    });

    it("extracts the HTTP status from a transport failure as a number", () => {
      logRetryExhaustion("extraction.resume", "m", TRANSPORT);
      const attempts = payload().attempts as Array<{ status?: number }>;
      expect(attempts[0]?.status).toBe(401);
    });

    it("only matches a status at the start, not a digit inside an echoed body", () => {
      logRetryExhaustion("extraction.resume", "m", [
        { attempt: 0, kind: "transport_error", message: 'error: employee id 404 at Disney' },
      ]);
      const attempts = payload().attempts as Array<{ status?: number }>;
      expect(attempts[0]?.status).toBeUndefined();
    });

    it("reports Zod issue codes and paths for a schema failure", () => {
      logRetryExhaustion("extraction.resume", "m", [LEAKY_SCHEMA_FAILURE]);
      const attempts = payload().attempts as Array<{ issues?: Array<{ code: string; path: string }> }>;
      expect(attempts[0]?.issues).toEqual([
        { code: "unrecognized_keys", path: "units.0" },
      ]);
    });
  });

  describe("redaction", () => {
    it("never emits a provider or Zod message", () => {
      logRetryExhaustion("extraction.resume", "m", [LEAKY_SCHEMA_FAILURE, ...TRANSPORT]);
      const serialized = JSON.stringify(payload());
      expect(serialized).not.toContain("Led Disney launch on Vega OS");
      expect(serialized).not.toContain("hire@example.com");
      expect(serialized).not.toContain("Unrecognized keys");
      expect(serialized).not.toContain('{"type":"error"}');
    });

    it("drops the model-controlled `keys` array entirely", () => {
      logRetryExhaustion("extraction.resume", "m", [LEAKY_SCHEMA_FAILURE]);
      const attempts = payload().attempts as Array<Record<string, unknown>>;
      const issues = attempts[0]!.issues as Array<Record<string, unknown>>;
      expect(Object.keys(issues[0]!).sort()).toEqual(["code", "path"]);
    });

    it("replaces a path segment that is not a schema-shaped identifier", () => {
      // Defence against a future z.record() whose keys are model output.
      logRetryExhaustion("extraction.resume", "m", [
        {
          attempt: 0,
          kind: "schema_error",
          zodIssues: [{ code: "invalid_type", path: ["units", 0, "hire@example.com"] }],
        },
      ]);
      const attempts = payload().attempts as Array<{ issues?: Array<{ path: string }> }>;
      expect(attempts[0]?.issues?.[0]?.path).toBe("units.0.*");
    });

    it("emits only the fixed top-level field set", () => {
      // ownerUid excluded, matching cost.ts's contract. A future field
      // addition has to come through this assertion.
      logRetryExhaustion("extraction.resume", "m", TRANSPORT);
      expect(Object.keys(payload())).toEqual(["stage", "model", "kinds", "attempts"]);
    });

    it("caps the number of issues logged per attempt", () => {
      const many = Array.from({ length: 50 }, () => ({ code: "invalid_type", path: ["units"] }));
      logRetryExhaustion("extraction.resume", "m", [
        { attempt: 0, kind: "schema_error", zodIssues: many },
      ]);
      const attempts = payload().attempts as Array<{ issues?: unknown[] }>;
      expect(attempts[0]!.issues!.length).toBeLessThanOrEqual(12);
    });
  });

  describe("robustness", () => {
    it("handles an empty failure list", () => {
      expect(() => logRetryExhaustion("extraction.resume", "m", [])).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it("never throws when the logger itself fails", () => {
      errorSpy.mockImplementationOnce(() => {
        throw new Error("logging backend down");
      });
      expect(() => logRetryExhaustion("extraction.resume", "m", TRANSPORT)).not.toThrow();
    });

    it("tolerates a missing message and missing zodIssues", () => {
      expect(() =>
        logRetryExhaustion("extraction.resume", "m", [{ attempt: 0, kind: "no_tool_use" }]),
      ).not.toThrow();
      const attempts = payload().attempts as Array<Record<string, unknown>>;
      expect(attempts[0]).toEqual({ attempt: 0, kind: "no_tool_use" });
    });

    it("tolerates malformed zodIssues without throwing", () => {
      expect(() =>
        logRetryExhaustion("extraction.resume", "m", [
          { attempt: 0, kind: "schema_error", zodIssues: ["nonsense", null, 42] as unknown[] },
        ]),
      ).not.toThrow();
      const attempts = payload().attempts as Array<{ issues?: Array<{ code: string; path: string }> }>;
      expect(attempts[0]?.issues?.every((i) => i.code === "unknown")).toBe(true);
    });
  });
});
