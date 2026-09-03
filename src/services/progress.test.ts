/**
 * Unit tests for the progress vocabulary and copy (#428).
 *
 * What a user reads during a two-minute wait is exactly the kind of
 * thing that should be testable without a timer, so all of it is pure.
 */

import { describe, expect, it } from "vitest";

import {
  EXTRACTION_VOCABULARY,
  JD_PARSING_VOCABULARY,
  durationHint,
  formatElapsed,
  parseProgressEvent,
  progressMessage,
  TYPICAL_DURATION_MS,
} from "./progress.ts";

describe("parseProgressEvent", () => {
  it("accepts a known stage", () => {
    expect(parseProgressEvent({ stage: "embedding" })).toEqual({
      stage: "embedding",
    });
  });

  it("carries attempt and maxAttempts when present", () => {
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: 2, maxAttempts: 3 }),
    ).toEqual({ stage: "analyzing", attempt: 2, maxAttempts: 3 });
  });

  it("rejects an unknown stage rather than rendering it", () => {
    // The deployed function is not necessarily the version this client
    // was built against — #422 made that concrete. Holding the last
    // known-good state beats showing a stage we have no copy for.
    expect(parseProgressEvent({ stage: "reticulating" })).toBeNull();
  });

  it("rejects non-objects and malformed shapes", () => {
    expect(parseProgressEvent(null)).toBeNull();
    expect(parseProgressEvent(undefined)).toBeNull();
    expect(parseProgressEvent("analyzing")).toBeNull();
    expect(parseProgressEvent({})).toBeNull();
    expect(parseProgressEvent({ stage: 3 })).toBeNull();
  });

  it("rejects fractional counters", () => {
    // "Attempt 2.5" reads as a bug in the product, not the payload
    // (CodeRabbit P2, #436).
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: 2.5, maxAttempts: 3 }),
    ).toEqual({ stage: "analyzing", maxAttempts: 3 });
  });

  it("drops maxAttempts when it is below attempt", () => {
    // Otherwise the copy reads "Attempt 3 of 2".
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: 3, maxAttempts: 2 }),
    ).toEqual({ stage: "analyzing", attempt: 3 });
  });

  it("keeps maxAttempts when it equals attempt", () => {
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: 3, maxAttempts: 3 }),
    ).toEqual({ stage: "analyzing", attempt: 3, maxAttempts: 3 });
  });

  it("drops nonsensical attempt values instead of rendering them", () => {
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: 0, maxAttempts: -1 }),
    ).toEqual({ stage: "analyzing" });
    expect(
      parseProgressEvent({ stage: "analyzing", attempt: Number.NaN }),
    ).toEqual({ stage: "analyzing" });
  });
});

describe("progressMessage", () => {
  it("names the subject on the first attempt", () => {
    const msg = progressMessage(
      { stage: "analyzing", attempt: 1, maxAttempts: 3 },
      EXTRACTION_VOCABULARY,
    );
    expect(msg).toContain("your resume");
    expect(msg).not.toMatch(/retry/i);
  });

  it("calls a retry a retry, with the count", () => {
    // The single most useful thing to surface during a long wait: a
    // second attempt is otherwise indistinguishable from a hang.
    const msg = progressMessage(
      { stage: "analyzing", attempt: 2, maxAttempts: 3 },
      EXTRACTION_VOCABULARY,
    );
    expect(msg).toMatch(/retrying/i);
    expect(msg).toContain("2");
    expect(msg).toContain("3");
  });

  it("omits the total when maxAttempts is unknown", () => {
    const msg = progressMessage(
      { stage: "analyzing", attempt: 2 },
      EXTRACTION_VOCABULARY,
    );
    expect(msg).toMatch(/retrying/i);
    expect(msg).not.toContain(" of ");
  });

  it("uses the operation's own nouns", () => {
    expect(
      progressMessage({ stage: "saving" }, JD_PARSING_VOCABULARY),
    ).toContain("Requirements");
    expect(progressMessage({ stage: "saving" }, EXTRACTION_VOCABULARY)).toContain(
      "Experience Units",
    );
  });

  it("degrades to a neutral line with no event", () => {
    // Route A of #428 was rejected for inventing stages; the fallback
    // must not name one.
    const msg = progressMessage(null, JD_PARSING_VOCABULARY);
    expect(msg).toContain("the job description");
    expect(msg).not.toMatch(/saving|indexing|retry/i);
  });

  it("covers every stage without falling through", () => {
    for (const stage of ["analyzing", "embedding", "saving"] as const) {
      expect(
        progressMessage({ stage }, EXTRACTION_VOCABULARY).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("formatElapsed", () => {
  it("shows seconds below a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(45_400)).toBe("45s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("switches to m:ss at a minute", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(108_600)).toBe("1:48");
    expect(formatElapsed(605_000)).toBe("10:05");
  });

  it("clamps nonsense rather than rendering NaN", () => {
    // A clock adjustment mid-operation must not produce "-3s".
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});

describe("durationHint", () => {
  it("sets an expectation before the typical duration", () => {
    // What stops a user reloading at 45s and abandoning a call that
    // was going to succeed.
    const hint = durationHint(45_000, TYPICAL_DURATION_MS.extraction);
    expect(hint).toContain("110");
  });

  it("stops implying imminent completion once past typical", () => {
    const hint = durationHint(200_000, TYPICAL_DURATION_MS.extraction);
    expect(hint).toMatch(/longer than usual/i);
    expect(hint).not.toContain("110");
  });

  it("treats exactly-typical as still on track", () => {
    expect(
      durationHint(TYPICAL_DURATION_MS.jdParsing, TYPICAL_DURATION_MS.jdParsing),
    ).toMatch(/usually takes/i);
  });
});
