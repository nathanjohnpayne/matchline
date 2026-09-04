/**
 * Progress events emitted by long-running callables (#428).
 *
 * **Why this exists.** Extraction on a real résumé measured **108.6s**
 * against a `specs/matchline.md` p95 target of 20s, and for all of it
 * the UI showed a 2px indeterminate bar and the word "Extracting…".
 * The most likely user action at 45 seconds is a reload, which
 * abandons a call that was going to succeed and pays the Anthropic
 * cost twice.
 *
 * **Why real events rather than a client-side timer.** A timer driven
 * off typical durations is cheap and dishonest: it claims "Saving"
 * while attempt 2 is still running, and it cannot show a retry at all
 * — which is the single most useful thing to surface, because a retry
 * is currently indistinguishable from a hang and it predicts the
 * "needs manual review" outcome. Both SDKs already support streaming
 * (`CallableResponse.sendChunk` on `firebase-functions` v2,
 * `HttpsCallable.stream` on `@firebase/functions`); it was simply
 * unused.
 *
 * **Emission is best-effort by contract.** `sendChunk` resolves `false`
 * for a non-streaming request rather than throwing, so a pipeline can
 * emit unconditionally and an old client is unaffected. Nothing here
 * is allowed to fail a call that would otherwise succeed — see
 * `safeProgress`.
 *
 * The vocabulary is mirrored on the client in
 * `src/services/progress.ts`, which cannot import this module
 * (separate package, separate `node_modules`).
 * `tests/progress-contract.test.ts` pins the two together.
 */

/**
 * Stages a caller can be told about. Deliberately coarse: these are
 * the boundaries the pipeline genuinely crosses, not a simulation of
 * fine-grained motion.
 *
 * - `analyzing` — the LLM call (extraction or JD parsing).
 * - `embedding` — batch embeddings over the returned units.
 * - `saving`    — the atomic Firestore write. *
 * - `retrying`   — an attempt failed; waiting out the backoff before
 *                  the next one. Its own stage because the sleep can be
 *                  long (a 429 carries `retry-after`) and without it the
 *                  UI keeps claiming to be reading, which is exactly the
 *                  apparent-hang this feature removes (#436).
 */
export const PROGRESS_STAGES = [
  "analyzing",
  "retrying",
  "embedding",
  "saving",
] as const;

export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export interface ProgressEvent {
  readonly stage: ProgressStage;
  /**
   * 1-based attempt number, present on `analyzing` and `retrying` —
   * the two stages that carry retry metadata, per
   * `specs/matchline.md` § Streaming progress. A value above 1 means
   * the previous attempt failed and is being retried — the fact that
   * makes a long wait legible rather than alarming.
   */
  readonly attempt?: number;
  /** Total attempts the retry budget allows, so the UI can say "2 of 3". */
  readonly maxAttempts?: number;
}

/** Sink a pipeline calls to report progress. */
export type ProgressReporter = (event: ProgressEvent) => void;

/**
 * Wrap a reporter so it can never disturb the pipeline.
 *
 * Progress is a reporting concern, exactly like the cost telemetry in
 * `cost.ts`, and inherits the same invariant: a broken sink must not
 * convert a successful extraction into a failure. `sendChunk` can
 * reject on a network error, and the client may have disconnected
 * mid-call — neither is a reason to abandon work already paid for.
 */
export function safeProgress(
  report: ProgressReporter | undefined,
): ProgressReporter {
  if (report === undefined) return () => {};
  return (event) => {
    try {
      // TypeScript allows an async function to satisfy a `=> void`
      // type — the return is simply ignored — so a caller can hand us
      // a reporter that rejects LATER, outside this try/catch. That is
      // not hypothetical: the callables' reporter wraps
      // `response.sendChunk`, which returns a promise. Absorb a
      // thenable result as well as a synchronous throw, or the
      // rejection escapes as an unhandled one and can terminate an
      // otherwise successful call on Node 20 (CodeRabbit P1, #436).
      // `PromiseLike` guarantees `then`, not `catch`, so casting to
      // `Promise` and calling `.catch` would itself throw on a thenable
      // that implements only `then` — inside the helper whose whole
      // job is to never throw. `Promise.resolve` adopts any thenable
      // and hands back a real promise (CodeRabbit Minor, #457).
      const result = report(event) as unknown;
      // `object` is not the only thenable shape: a *function* can carry
      // a `then` method too, and `Promise.resolve` adopts it just the
      // same. Testing only for "object" skipped those, leaving a
      // rejecting callable thenable unhandled — the exact failure this
      // helper exists to prevent (CodeRabbit, #457).
      if (
        (typeof result === "object" || typeof result === "function") &&
        result !== null &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Intentionally silent: a failed progress emission is not worth
      // a log line on every attempt, and the call continues.
    }
  };
}
