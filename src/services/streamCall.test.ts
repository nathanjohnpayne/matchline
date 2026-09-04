/**
 * Unit tests for `invokeStreaming` (#428).
 *
 * Each case corresponds to a Codex finding on PR #436 — the first
 * version of the streaming path had all three defects.
 */

import { FunctionsError, type HttpsCallable } from "firebase/functions";
import { describe, expect, it, vi } from "vitest";

import { invokeStreaming } from "./streamCall.ts";

type Fn = HttpsCallable<{ x: number }, { ok: boolean }, unknown>;

/** Build a fake callable whose stream and data promise we control. */
function fakeFn(opts: {
  chunks?: unknown[];
  streamError?: unknown;
  dataError?: unknown;
  data?: { ok: boolean };
  onSignal?: (s: AbortSignal | undefined) => void;
}): Fn {
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const c of opts.chunks ?? []) yield c;
      if (opts.streamError !== undefined) throw opts.streamError;
    },
  };
  const fn = (() => {
    throw new Error("non-streaming path not used in these tests");
  }) as unknown as Fn;
  (fn as unknown as { stream: unknown }).stream = vi.fn(
    async (_data: unknown, o?: { signal?: AbortSignal }) => {
      opts.onSignal?.(o?.signal);
      return {
        stream,
        data:
          opts.dataError !== undefined
            ? Promise.reject(opts.dataError)
            : Promise.resolve(opts.data ?? { ok: true }),
      };
    },
  );
  return fn;
}

describe("invokeStreaming", () => {
  it("forwards recognized progress events and resolves the final data", async () => {
    const onProgress = vi.fn();
    const result = await invokeStreaming(
      fakeFn({
        chunks: [
          { stage: "analyzing", attempt: 1, maxAttempts: 3 },
          { stage: "embedding" },
        ],
        data: { ok: true },
      }),
      { payload: { x: 1 }, timeoutMs: 1000, onProgress },
    );
    expect(result).toEqual({ ok: true });
    expect(onProgress.mock.calls.map(([e]) => e.stage)).toEqual([
      "analyzing",
      "embedding",
    ]);
  });

  it("drops unrecognized chunks rather than reporting them", async () => {
    // The deployed function is not necessarily the version this client
    // was built against (#422).
    const onProgress = vi.fn();
    await invokeStreaming(
      fakeFn({ chunks: [{ stage: "reticulating" }, "garbage", null] }),
      { payload: { x: 1 }, timeoutMs: 1000, onProgress },
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("does not leave the data promise unhandled when the stream throws", async () => {
    // Codex P2: `data` and `stream` reject independently. Awaiting
    // `data` only after the loop leaves it unobserved for the duration
    // of the failure, emitting an unhandled rejection alongside the
    // error the route already handles.
    // `process` is not in this project's `types` (vite/client only),
    // so reach the Node hook through globalThis rather than widening
    // the tsconfig for one test.
    type RejectionHook = {
      on: (e: string, cb: () => void) => void;
      off: (e: string, cb: () => void) => void;
    };
    const proc = (globalThis as { process?: RejectionHook }).process;
    const unhandled = vi.fn();
    proc?.on("unhandledRejection", unhandled);
    const boom = new Error("stream died");
    await expect(
      invokeStreaming(
        fakeFn({ streamError: boom, dataError: new Error("data died") }),
        { payload: { x: 1 }, timeoutMs: 1000, onProgress: vi.fn() },
      ),
    ).rejects.toThrow("stream died");
    // Give the microtask queue a turn: an unhandled rejection is
    // reported asynchronously, so asserting immediately would pass
    // even without the fix.
    await new Promise((r) => setTimeout(r, 20));
    proc?.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("propagates a data-promise rejection to the caller", async () => {
    await expect(
      invokeStreaming(fakeFn({ dataError: new Error("server said no") }), {
        payload: { x: 1 },
        timeoutMs: 1000,
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow("server said no");
  });

  it("passes an AbortSignal so the #424 budget still applies", async () => {
    // HttpsCallableStreamOptions has no `timeout` and streamAtURL races
    // nothing, so without this the streaming path has no deadline.
    let seen: AbortSignal | undefined;
    await invokeStreaming(fakeFn({ onSignal: (s) => (seen = s) }), {
      payload: { x: 1 },
      timeoutMs: 1000,
      onProgress: vi.fn(),
    });
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it("relabels a self-imposed timeout as deadline-exceeded, not cancelled", async () => {
    // Codex P2: the SDK maps ANY abort to functions/cancelled, so our
    // own deadline would render "That request was cancelled" instead of
    // the timeout copy built for these long calls in #424/#426.
    const cancelled = new FunctionsError("cancelled", "Request was cancelled.");
    const fn = fakeFn({});
    (fn as unknown as { stream: unknown }).stream = vi.fn(
      async (_d: unknown, o?: { signal?: AbortSignal }) => {
        await new Promise((r) => setTimeout(r, 30));
        if (o?.signal?.aborted) throw cancelled;
        return { stream: { async *[Symbol.asyncIterator]() {} }, data: Promise.resolve({ ok: true }) };
      },
    );
    await expect(
      invokeStreaming(fn, { payload: { x: 1 }, timeoutMs: 1, onProgress: vi.fn() }),
    ).rejects.toMatchObject({ code: "functions/deadline-exceeded" });
  });

  it("does not relabel a cancellation we did not cause", async () => {
    // A real user-initiated cancel, or any other failure, must keep its
    // own identity — the timer merely happening to run is not license
    // to rewrite an error.
    const cancelled = new FunctionsError("cancelled", "Request was cancelled.");
    await expect(
      invokeStreaming(fakeFn({ streamError: cancelled }), {
        payload: { x: 1 },
        timeoutMs: 60_000,
        onProgress: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "functions/cancelled" });
  });

  it("leaves a non-cancellation error untouched even after a timeout", async () => {
    const other = new FunctionsError("internal", "internal");
    const fn = fakeFn({});
    (fn as unknown as { stream: unknown }).stream = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw other;
    });
    await expect(
      invokeStreaming(fn, { payload: { x: 1 }, timeoutMs: 1, onProgress: vi.fn() }),
    ).rejects.toMatchObject({ code: "functions/internal" });
  });
});

describe("invokeStreaming onProgress isolation (#436)", () => {
  it("does not let a throwing callback fail the call", async () => {
    // The spec guarantees a broken sink cannot decide the outcome of a
    // paid operation. That was implemented server-side and missing here.
    const result = await invokeStreaming(
      fakeFn({ chunks: [{ stage: "embedding" }], data: { ok: true } }),
      {
        payload: { x: 1 },
        timeoutMs: 1000,
        onProgress: () => {
          throw new Error("sink exploded");
        },
      },
    );
    expect(result).toEqual({ ok: true });
  });

  it("does not let an async rejecting callback emit an unhandled rejection", async () => {
    type Hook = {
      on: (e: string, cb: () => void) => void;
      off: (e: string, cb: () => void) => void;
    };
    const proc = (globalThis as { process?: Hook }).process;
    const unhandled = vi.fn();
    proc?.on("unhandledRejection", unhandled);

    const result = await invokeStreaming(
      fakeFn({ chunks: [{ stage: "saving" }], data: { ok: true } }),
      {
        payload: { x: 1 },
        timeoutMs: 1000,
        onProgress: (() => Promise.reject(new Error("async sink"))) as unknown as (
          e: unknown,
        ) => void,
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    proc?.off("unhandledRejection", unhandled);
    expect(result).toEqual({ ok: true });
    expect(unhandled).not.toHaveBeenCalled();
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

    await invokeStreaming(
      fakeFn({ chunks: [{ stage: "analyzing" }], data: { ok: true } }),
      {
        payload: { x: 1 },
        timeoutMs: 1000,
        onProgress: report as unknown as (e: unknown) => void,
      },
    );

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

    await invokeStreaming(
      fakeFn({ chunks: [{ stage: "analyzing" }], data: { ok: true } }),
      {
        payload: { x: 1 },
        timeoutMs: 1000,
        onProgress: report as unknown as (e: unknown) => void,
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledTimes(1);
    expect(typeof then.mock.calls[0]![1]).toBe("function");
  });
});
