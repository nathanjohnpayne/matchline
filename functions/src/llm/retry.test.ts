import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sleep, transportBackoffMs } from "./retry.ts";

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
