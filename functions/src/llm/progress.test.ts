/**
 * Unit tests for the progress helpers (#428, #436).
 */

import { describe, expect, it, vi } from "vitest";

import { safeProgress } from "./progress.ts";

describe("safeProgress", () => {
  it("forwards events to the reporter", () => {
    const report = vi.fn();
    safeProgress(report)({ stage: "embedding" });
    expect(report).toHaveBeenCalledWith({ stage: "embedding" });
  });

  it("is a no-op when no reporter is given", () => {
    expect(() => safeProgress(undefined)({ stage: "saving" })).not.toThrow();
  });

  it("absorbs a synchronous throw", () => {
    const report = () => {
      throw new Error("sink exploded");
    };
    expect(() => safeProgress(report)({ stage: "saving" })).not.toThrow();
  });

  it("absorbs an ASYNC rejection without an unhandled rejection", async () => {
    // TypeScript lets an async function satisfy `=> void`, so a caller
    // can hand us a reporter that rejects later — outside the
    // synchronous try/catch. The callables' reporter wraps
    // `response.sendChunk`, which returns a promise, so this is the
    // real shape (CodeRabbit P1, #436).
    type Hook = {
      on: (e: string, cb: () => void) => void;
      off: (e: string, cb: () => void) => void;
    };
    const proc = (globalThis as { process?: Hook }).process;
    const unhandled = vi.fn();
    proc?.on("unhandledRejection", unhandled);

    const report = () => Promise.reject(new Error("send failed"));
    expect(() =>
      safeProgress(report as unknown as (e: { stage: "saving" }) => void)({
        stage: "saving",
      }),
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
    proc?.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("leaves a non-thenable return value alone", () => {
    const report = vi.fn(() => 42 as unknown as void);
    expect(() => safeProgress(report)({ stage: "analyzing" })).not.toThrow();
    expect(report).toHaveBeenCalled();
  });
});
