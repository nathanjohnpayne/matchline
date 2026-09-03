import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractRetryAfterMs, sleep, transportBackoffMs } from "./retry.ts";

describe("transportBackoffMs", () => {
  beforeEach(() => {
    // Pin Math.random so the schedule numbers are deterministic.
    // Tests that exercise jitter explicitly override per-case.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default schedule doubles per attempt up to the 5000ms cap", () => {
    expect(transportBackoffMs(0)).toBe(500);
    expect(transportBackoffMs(1)).toBe(1000);
    expect(transportBackoffMs(2)).toBe(2000);
    expect(transportBackoffMs(3)).toBe(4000);
    expect(transportBackoffMs(4)).toBe(5000);
    expect(transportBackoffMs(10)).toBe(5000);
  });

  it("adds floor(random * 250) jitter on top of the exponential base", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // 500 + floor(0.5 * 250) = 500 + 125
    expect(transportBackoffMs(0)).toBe(625);
  });

  it("doubles base and cap for 429 rate-limit errors", () => {
    expect(transportBackoffMs(0, { status: 429 })).toBe(1000);
    expect(transportBackoffMs(1, { status: 429 })).toBe(2000);
    expect(transportBackoffMs(2, { status: 429 })).toBe(4000);
    expect(transportBackoffMs(3, { status: 429 })).toBe(8000);
    expect(transportBackoffMs(4, { status: 429 })).toBe(10000);
    expect(transportBackoffMs(20, { status: 429 })).toBe(10000);
  });

  it("doubles base and cap for 503 server-overload errors", () => {
    expect(transportBackoffMs(0, { status: 503 })).toBe(1000);
    expect(transportBackoffMs(20, { status: 503 })).toBe(10000);
  });

  it("doubles base and cap for upstream-proxy slow-down (502, 504)", () => {
    expect(transportBackoffMs(0, { status: 502 })).toBe(1000);
    expect(transportBackoffMs(0, { status: 504 })).toBe(1000);
  });

  it("doubles base and cap for Anthropic's documented 529 \"Overloaded\"", () => {
    // 529 is Anthropic-specific (not a standard HTTP status). Listed
    // in their error-handling docs alongside 429 — applying the
    // same slow-down schedule.
    expect(transportBackoffMs(0, { status: 529 })).toBe(1000);
    expect(transportBackoffMs(20, { status: 529 })).toBe(10000);
  });

  it("treats plain Error instances (ECONNRESET etc.) as default schedule", () => {
    // No `.status` field — falls through the slow-down detection.
    expect(transportBackoffMs(0, new Error("ECONNRESET"))).toBe(500);
    expect(transportBackoffMs(1, new Error("ETIMEDOUT"))).toBe(1000);
  });

  it("ignores non-numeric status fields (defends against string statuses)", () => {
    expect(transportBackoffMs(0, { status: "429" })).toBe(500);
    expect(transportBackoffMs(0, { status: null })).toBe(500);
  });

  it("ignores non-slow-down numeric statuses (4xx caller errors, 500)", () => {
    // 400 / 401 are caller-bug responses — exponential retry won't
    // help, but if a caller passes one through, default schedule is
    // the safer fallback. 500 is generic "something went wrong"
    // without a slow-down semantic.
    expect(transportBackoffMs(0, { status: 400 })).toBe(500);
    expect(transportBackoffMs(0, { status: 401 })).toBe(500);
    expect(transportBackoffMs(0, { status: 500 })).toBe(500);
  });

  it("clamps negative attempt to 0 (defensive — caller bug shouldn't crash)", () => {
    expect(transportBackoffMs(-1)).toBe(500);
    expect(transportBackoffMs(-100)).toBe(500);
  });

  it("clamps non-finite attempt to 0 (NaN / Infinity shouldn't produce a NaN delay)", () => {
    // A NaN/Infinity attempt used to flow through
    // Math.max(0, Math.floor(attempt)) unguarded, yielding a NaN
    // delay that setTimeout treats as 1ms — a tight retry storm,
    // exactly what this helper exists to prevent.
    expect(transportBackoffMs(NaN)).toBe(500);
    expect(transportBackoffMs(Infinity)).toBe(500);
    expect(transportBackoffMs(-Infinity)).toBe(500);
    for (const attempt of [NaN, Infinity, -Infinity]) {
      const v = transportBackoffMs(attempt);
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns a non-negative integer for any reasonable attempt", () => {
    vi.restoreAllMocks(); // real Math.random
    for (let attempt = 0; attempt < 20; attempt++) {
      const v = transportBackoffMs(attempt);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5000 + 249);
    }
  });
});

// -- #114: header-aware retry hints ---------------------------------------

describe("extractRetryAfterMs", () => {
  // Pin `now` so date-based assertions are deterministic.
  // 2026-04-26T20:00:00Z — exactly the time the #114 fix was authored.
  const NOW = Date.parse("2026-04-26T20:00:00Z");

  it("returns null when the error has no headers", () => {
    expect(extractRetryAfterMs(new Error("ECONNRESET"), NOW)).toBeNull();
    expect(extractRetryAfterMs({ status: 429 }, NOW)).toBeNull();
    expect(extractRetryAfterMs(undefined, NOW)).toBeNull();
    expect(extractRetryAfterMs(null, NOW)).toBeNull();
  });

  it("parses retry-after as integer delta-seconds (RFC 7231)", () => {
    const err = { status: 429, headers: { "retry-after": "30" } };
    expect(extractRetryAfterMs(err, NOW)).toBe(30_000);
  });

  it("parses retry-after as HTTP-date and returns offset from now", () => {
    // 90 seconds in the future.
    const err = {
      status: 429,
      headers: { "retry-after": "Sun, 26 Apr 2026 20:01:30 GMT" },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(90_000);
  });

  it("falls through to anthropic-ratelimit-requests-reset (ISO 8601)", () => {
    // 45 seconds in the future, retry-after absent.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "2026-04-26T20:00:45Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(45_000);
  });

  it("falls through to anthropic-ratelimit-tokens-reset when retry-after + requests-reset absent", () => {
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-tokens-reset": "2026-04-26T20:00:15Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(15_000);
  });

  it("Codex P2 on #144: takes the max across requests-reset + tokens-reset when both present", () => {
    // Independent windows — retrying before the later resets just
    // burns the next attempt on another 429. The 60s tokens-reset
    // dominates the 20s requests-reset.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "2026-04-26T20:00:20Z",
        "anthropic-ratelimit-tokens-reset": "2026-04-26T20:01:00Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(60_000);
  });

  it("Codex P2 on #144: max-across still works when one of the two is malformed", () => {
    // requests-reset is garbage, tokens-reset is valid — should
    // return the tokens-reset value, not null.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "definitely not iso",
        "anthropic-ratelimit-tokens-reset": "2026-04-26T20:00:25Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(25_000);
  });

  it("Codex P2 on #144: max-across drops past-timestamps but keeps the future one", () => {
    // requests-reset is in the past (clock skew / stale error),
    // tokens-reset is in the future. Past is dropped; future wins.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "2026-04-26T19:59:00Z",
        "anthropic-ratelimit-tokens-reset": "2026-04-26T20:00:30Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(30_000);
  });

  it("prefers retry-after over the anthropic-ratelimit-* fallbacks", () => {
    const err = {
      status: 429,
      headers: {
        "retry-after": "10",
        "anthropic-ratelimit-requests-reset": "2026-04-26T20:01:00Z",
        "anthropic-ratelimit-tokens-reset": "2026-04-26T20:02:00Z",
      },
    };
    // retry-after wins → 10 seconds, not the longer reset windows.
    expect(extractRetryAfterMs(err, NOW)).toBe(10_000);
  });

  it("normalizes header keys to lowercase (handles SDK + raw fetch differences)", () => {
    const err = {
      status: 429,
      headers: { "Retry-After": "20" },
    };
    expect(extractRetryAfterMs(err, NOW)).toBe(20_000);
  });

  it("reads from a Web Headers instance via .entries()", () => {
    const headers = new Headers();
    headers.set("retry-after", "5");
    const err = { status: 429, headers };
    expect(extractRetryAfterMs(err, NOW)).toBe(5_000);
  });

  it("silently falls through when retry-after is malformed", () => {
    // Not a number, not a date.
    const err = {
      status: 429,
      headers: { "retry-after": "totally not a date" },
    };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("rejects fractional delta-seconds (RFC requires integer)", () => {
    const err = {
      status: 429,
      headers: { "retry-after": "1.5" },
    };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("rejects negative deltas (header timestamp in the past)", () => {
    // Past timestamp — clock skew or stale cached error. Fall
    // through to exponential rather than pin at 0.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "2026-04-26T19:59:00Z",
      },
    };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("ignores empty-string header values", () => {
    const err = {
      status: 429,
      headers: { "retry-after": "" },
    };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("ignores non-string header values defensively", () => {
    const err = {
      status: 429,
      headers: { "retry-after": 30 as unknown as string },
    };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("falls through cleanly when headers field is null", () => {
    const err = { status: 429, headers: null };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });

  it("falls through cleanly when headers field is a non-object (string)", () => {
    const err = { status: 429, headers: "x-rate-limit: 30" };
    expect(extractRetryAfterMs(err, NOW)).toBeNull();
  });
});

describe("transportBackoffMs (header-aware, #114)", () => {
  const NOW = Date.parse("2026-04-26T20:00:00Z");

  beforeEach(() => {
    // Pin `Date.now` so our test errors with ISO-8601 reset
    // headers produce deterministic offsets.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    // Pin Math.random for jitter — tests assert exact equality
    // against the elevated base, jitter contributes 0.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("elevates delay to the retry-after hint when it exceeds exponential", () => {
    // Attempt 0 → exponential = 1000ms (slow-down base for 429).
    // retry-after: 30 seconds → elevated to 30_000ms.
    const err = { status: 429, headers: { "retry-after": "30" } };
    expect(transportBackoffMs(0, err)).toBe(30_000);
  });

  it("keeps exponential when the retry-after hint is shorter", () => {
    // Attempt 4 → exponential cap = 10_000ms.
    // retry-after: 1 second → elevated stays at 10_000.
    const err = { status: 429, headers: { "retry-after": "1" } };
    expect(transportBackoffMs(4, err)).toBe(10_000);
  });

  it("regression: behavior identical to pre-#114 when no headers present", () => {
    // The retry.test.ts `"doubles base and cap for 429"` block
    // already asserts these exact values without headers. Re-
    // pinning here so a future refactor that breaks the no-header
    // path fails this file too.
    expect(transportBackoffMs(0, { status: 429 })).toBe(1000);
    expect(transportBackoffMs(2, { status: 429 })).toBe(4000);
    expect(transportBackoffMs(20, { status: 429 })).toBe(10_000);
  });

  it("malformed retry-after silently falls through to exponential", () => {
    // Garbage header → null hint → exponential (1000ms at attempt 0).
    const err = { status: 429, headers: { "retry-after": "moments" } };
    expect(transportBackoffMs(0, err)).toBe(1000);
  });

  it("honors anthropic-ratelimit-requests-reset on attempt 0", () => {
    // 45-second reset window → elevated above the 1000ms exponential.
    const err = {
      status: 429,
      headers: {
        "anthropic-ratelimit-requests-reset": "2026-04-26T20:00:45Z",
      },
    };
    expect(transportBackoffMs(0, err)).toBe(45_000);
  });

  it("jitter still applies on top of the elevated header hint", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const err = { status: 429, headers: { "retry-after": "30" } };
    // 30_000 + floor(0.5 * 250) = 30_125
    expect(transportBackoffMs(0, err)).toBe(30_125);
  });

  it("CR Critical on #144: clamps to int32 ceiling so setTimeout doesn't coerce to 1ms", () => {
    // RFC 7231 allows a far-future HTTP-date — without the clamp,
    // setTimeout silently coerces values > 2^31-1 down to 1ms,
    // turning a "wait 100 years" hint into a tight retry storm.
    // 100 years out → ~3.15e12 ms, well past the int32 ceiling.
    const err = {
      status: 429,
      headers: { "retry-after": "Mon, 26 Apr 2126 20:00:00 GMT" },
    };
    expect(transportBackoffMs(0, err)).toBe(2_147_483_647);
  });
});

describe("sleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a setTimeout with the requested delay and resolves after it elapses", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = sleep(1234);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1234);

    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Not yet — timer hasn't fired.
    await Promise.resolve();
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1234);
    await promise;
    expect(resolved).toBe(true);
  });
});

describe("sleep abort-awareness (#436)", () => {
  it("resolves immediately when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    const t0 = Date.now();
    await sleep(10_000, c.signal);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("resolves early when aborted mid-wait", async () => {
    // A 429's retry-after can be long; without this the callable stays
    // alive through the whole backoff for a caller that has gone.
    const c = new AbortController();
    const t0 = Date.now();
    const p = sleep(10_000, c.signal);
    setTimeout(() => c.abort(), 20);
    await p;
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("still waits the full duration with no signal", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it("resolves rather than rejecting on abort", async () => {
    // The retry loop owns cancellation via its pre-attempt check;
    // rejecting here would add a second path for the same decision.
    const c = new AbortController();
    const p = sleep(5_000, c.signal);
    c.abort();
    await expect(p).resolves.toBeUndefined();
  });
});
