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

  it("adopts a thenable that implements only `then`", async () => {
    // `PromiseLike` guarantees `then`, not `catch`. The previous
    // implementation cast to `Promise` and called `.catch` directly,
    // which throws a TypeError on this shape. The surrounding
    // try/catch swallowed it, so nothing appeared to break — but the
    // rejection handler was never attached, which is the whole point
    // of the helper. Asserting "does not throw" would therefore pass
    // against the bug; assert the thenable is actually adopted, i.e.
    // that `then` gets called with a rejection handler (#457).
    const then = vi.fn(
      (_ok: (v: unknown) => void, _err: (e: unknown) => void) => {},
    );
    const report = vi.fn(() => ({ then }) as unknown as void);

    safeProgress(report)({ stage: "analyzing" });

    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    expect(typeof then.mock.calls[0]![1]).toBe("function");
  });

  it("adopts a callable thenable (a function carrying `then`)", async () => {
    // A function can implement `then` too, and `Promise.resolve` adopts
    // it identically. A guard testing only for `typeof === "object"`
    // skipped these, leaving a rejecting callable thenable unhandled
    // (CodeRabbit, #457).
    const then = vi.fn(
      (_ok: (v: unknown) => void, _err: (e: unknown) => void) => {},
    );
    const callable = Object.assign(() => {}, { then });
    const report = vi.fn(() => callable as unknown as void);

    safeProgress(report)({ stage: "analyzing" });

    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    expect(typeof then.mock.calls[0]![1]).toBe("function");
  });
});
