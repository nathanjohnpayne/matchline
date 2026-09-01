/**
 * Unit tests for `logRetryExhaustion` (#426).
 *
 * The gap this closes: every pipeline collected per-attempt failures
 * and sent them to the browser, but never to Cloud Logging. A
 * production failure left `Callable request verification passed`
 * followed by silence.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const errorSpy = vi.fn();
vi.mock("firebase-functions", () => ({ logger: { error: (...a: unknown[]) => errorSpy(...a) } }));

const { logRetryExhaustion } = await import("./retryDiagnostics.ts");

beforeEach(() => errorSpy.mockClear());

const TRANSPORT = [
  { attempt: 0, kind: "transport_error", message: "401 invalid x-api-key" },
  { attempt: 1, kind: "transport_error", message: "401 invalid x-api-key" },
  { attempt: 2, kind: "transport_error", message: "401 invalid x-api-key" },
];

describe("logRetryExhaustion", () => {
  it("logs once at error severity with the stage and model", () => {
    logRetryExhaustion("extraction.resume", "claude-sonnet-4-6", TRANSPORT);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain("retry budget exhausted");
    expect(payload.stage).toBe("extraction.resume");
    expect(payload.model).toBe("claude-sonnet-4-6");
  });

  it("surfaces the failure kinds as their own field", () => {
    // This is the field that separates a credential fault from a
    // prompt fault at a glance — the distinction that would have made
    // #426 a two-minute diagnosis.
    logRetryExhaustion("extraction.resume", "m", TRANSPORT);
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.kinds).toEqual([
      "transport_error",
      "transport_error",
      "transport_error",
    ]);
  });

  it("includes each attempt's message", () => {
    logRetryExhaustion("parsing.jd", "m", TRANSPORT);
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    const attempts = payload.attempts as Array<{ attempt: number; message: string }>;
    expect(attempts).toHaveLength(3);
    expect(attempts[0]?.message).toContain("invalid x-api-key");
  });

  it("truncates a long message so one Zod dump cannot flood the line", () => {
    const long = "x".repeat(5000);
    logRetryExhaustion("extraction.resume", "m", [
      { attempt: 0, kind: "schema_error", message: long },
    ]);
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    const attempts = payload.attempts as Array<{ message: string }>;
    expect(attempts[0]!.message.length).toBeLessThanOrEqual(400);
  });

  it("omits ownerUid-shaped fields entirely", () => {
    // Redaction contract: an observability path must not widen PII
    // exposure. Mirrors cost.ts.
    logRetryExhaustion("extraction.resume", "m", TRANSPORT);
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload)).toEqual(["stage", "model", "kinds", "attempts"]);
  });

  it("handles an empty failure list without throwing", () => {
    expect(() => logRetryExhaustion("extraction.resume", "m", [])).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws when the logger itself fails", () => {
    // Non-throwing contract: telemetry must not convert a
    // "needs manual review" outcome into an unhandled crash.
    errorSpy.mockImplementationOnce(() => {
      throw new Error("logging backend down");
    });
    expect(() =>
      logRetryExhaustion("extraction.resume", "m", TRANSPORT),
    ).not.toThrow();
  });

  it("coerces a non-string message rather than throwing", () => {
    const failures = [
      { attempt: 0, kind: "transport_error", message: undefined as unknown as string },
    ];
    expect(() => logRetryExhaustion("extraction.resume", "m", failures)).not.toThrow();
    const [, payload] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect((payload.attempts as Array<{ message: string }>)[0]!.message).toBe(
      "undefined",
    );
  });
});
