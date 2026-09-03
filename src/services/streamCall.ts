/**
 * Shared plumbing for streaming callable invocations (#428).
 *
 * Both streaming call sites — extraction and JD parsing — need the same
 * three non-obvious behaviours, and Codex found all three missing from
 * the first version on PR #436. Duplicating them across two wrappers
 * would mean fixing each twice, so they live here once.
 *
 * ## 1. The `data` promise needs a handler immediately
 *
 * `fn.stream()` returns `{ stream, data }` as two independently
 * rejectable promises. On an `HttpsError`, a network failure, or a
 * timeout the SDK rejects *both*. The natural shape —
 *
 * ```ts
 * for await (const chunk of stream) { … }
 * return await data;      // never reached when the iterator throws
 * ```
 *
 * — leaves `data` unhandled for exactly the duration of the failure,
 * so every failed streaming call also emitted an unhandled rejection
 * in the browser *in addition to* the error the route handled
 * correctly. Attaching a handler before consuming the stream closes
 * that.
 *
 * ## 2. A self-imposed deadline must not read as a cancellation
 *
 * `HttpsCallableStreamOptions` has no `timeout`, and `streamAtURL`
 * races nothing — it passes only `options.signal` to `fetch`. So the
 * budget from #424 has to be re-supplied as an `AbortSignal`. But the
 * SDK maps *any* abort to `functions/cancelled`:
 *
 * ```js
 * if (e instanceof Error && e.name === 'AbortError') {
 *   const error = new FunctionsError('cancelled', 'Request was cancelled.');
 * ```
 *
 * which would show the user "That request was cancelled" — as though
 * they had done something — instead of the timeout copy and
 * remediation that #424 and #426 specifically built for these long
 * calls. Since we own the signal, we know which aborts were ours, and
 * translate those back to `deadline-exceeded`.
 *
 * ## 3. Unknown chunks are dropped, not rendered
 *
 * The deployed function is not necessarily the version the client was
 * built against; #422 made that concrete.
 */

import { FunctionsError, type HttpsCallable } from "firebase/functions";

import { parseProgressEvent, type ProgressEvent } from "./progress.ts";

export interface StreamCallOptions<Req> {
  readonly payload: Req;
  /** Client deadline in ms, from `callable-timeouts.ts`. */
  readonly timeoutMs: number;
  readonly onProgress: (event: ProgressEvent) => void;
}

export async function invokeStreaming<Req, Res>(
  fn: HttpsCallable<Req, Res, unknown>,
  { payload, timeoutMs, onProgress }: StreamCallOptions<Req>,
): Promise<Res> {
  const controller = new AbortController();
  // Our own flag rather than reading `controller.signal.reason`: the
  // caller could also abort for its own reasons in future, and only a
  // timeout should be reported as one.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const { stream, data } = await fn.stream(payload, {
      signal: controller.signal,
    });

    // Attached BEFORE the loop — see (1) above. This marks `data` as
    // observed so a rejection never surfaces as an unhandled one; it
    // does not swallow anything, because `await data` below still
    // rejects and delivers the error to the caller.
    data.catch(() => {});

    for await (const chunk of stream) {
      const event = parseProgressEvent(chunk);
      if (event !== null) onProgress(event);
    }

    return await data;
  } catch (err) {
    throw timedOut ? asDeadlineExceeded(err) : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-label an abort we caused as a deadline rather than a
 * cancellation, so the surface renders the timeout copy built for
 * these calls. Anything that is not the SDK's cancellation is passed
 * through untouched — a real failure must not be relabelled just
 * because the timer happened to be running.
 */
function asDeadlineExceeded(err: unknown): unknown {
  const code = (err as FunctionsError | undefined)?.code;
  if (code !== "functions/cancelled" && code !== "cancelled") return err;
  return new FunctionsError(
    "deadline-exceeded",
    "deadline-exceeded",
  );
}
