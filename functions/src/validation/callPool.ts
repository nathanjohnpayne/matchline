/**
 * Bounded pool for the validation orchestrator's model calls (#619,
 * #491).
 *
 * Validation makes one claim-extraction call per item, then a
 * traceability call and (if it traces) a specificity call per claim.
 * Run one at a time, a normal résumé's ~100 calls outlived the
 * callable's 300 s budget: #616's timed run was killed after 92 calls
 * and persisted nothing. The pool lets independent calls overlap while
 * capping how many are in flight, across items AND claims, so the cap
 * is the real bound on simultaneous provider demand. The
 * traceability-before-specificity dependency is the caller's: it
 * awaits one before submitting the other.
 *
 * Two ways the pool stops starting work:
 *   - **Failure.** The first task that rejects aborts the pool; tasks
 *     still queued reject with `CallPoolAborted` instead of spending
 *     calls on a validation that is already going to throw. Calls
 *     already in flight finish.
 *   - **Deadline.** A task due to start at or past `deadlineAtMs`
 *     rejects with `ValidationDeadlineExceeded` and aborts the pool, so
 *     the orchestrator throws a structured error before the platform
 *     kills the request (which the client only sees as a dropped
 *     connection).
 *
 * Queued tasks start in submission order.
 */

/** Hard ceiling on `concurrency`, whatever a caller asks for. */
export const MAX_VALIDATION_CONCURRENCY = 16;

export interface CallPoolOptions {
  /** Maximum tasks in flight; an integer in 1..MAX_VALIDATION_CONCURRENCY. */
  readonly concurrency: number;
  /** Epoch ms after which no new task starts. Omit for no deadline. */
  readonly deadlineAtMs?: number;
  readonly clockMs?: () => number;
}

export interface CallPool {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks that have started, for the deadline error's detail. */
  readonly started: number;
}

/** A queued task skipped because an earlier task failed. */
export class CallPoolAborted extends Error {
  constructor() {
    super("Skipped: an earlier validation call failed.");
    this.name = "CallPoolAborted";
  }
}

export class ValidationDeadlineExceeded extends Error {
  readonly callsStarted: number;

  constructor(callsStarted: number) {
    super(
      `Validation ran out of time after starting ${callsStarted} model calls; no verdict was persisted.`,
    );
    this.name = "ValidationDeadlineExceeded";
    this.callsStarted = callsStarted;
  }
}

export function createCallPool(options: CallPoolOptions): CallPool {
  const { concurrency } = options;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_VALIDATION_CONCURRENCY
  ) {
    throw new RangeError(
      `Validation concurrency must be an integer from 1 to ${MAX_VALIDATION_CONCURRENCY}; got ${concurrency}.`,
    );
  }
  const clockMs = options.clockMs ?? Date.now;
  const queue: Array<() => void> = [];
  let active = 0;
  let started = 0;
  let abortError: Error | undefined;

  const next = (): void => {
    while (active < concurrency && queue.length > 0) {
      queue.shift()!();
    }
  };

  return {
    get started() {
      return started;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          if (abortError !== undefined) {
            reject(new CallPoolAborted());
            return;
          }
          if (options.deadlineAtMs !== undefined && clockMs() >= options.deadlineAtMs) {
            abortError = new ValidationDeadlineExceeded(started);
            reject(abortError);
            return;
          }
          active++;
          started++;
          // Wrapped so a task that throws synchronously still settles
          // through the pool instead of escaping it.
          new Promise<T>((r) => r(task())).then(
            (value) => {
              active--;
              resolve(value);
              next();
            },
            (err: unknown) => {
              active--;
              abortError ??= err instanceof Error ? err : new Error(String(err));
              reject(err);
              next();
            },
          );
        });
        next();
      });
    },
  };
}

/**
 * Wait for every promise to settle, then return the values in order,
 * or throw the first real failure in input order. `CallPoolAborted`
 * rejections are consequences of another failure, never the cause,
 * so they are only thrown when nothing else failed.
 *
 * Waiting for everything (rather than `Promise.all`'s first rejection)
 * means no call is still running, or recording usage, after the
 * orchestrator has thrown.
 */
export async function settleInOrder<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(promises);
  const failures = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
  if (failures.length > 0) {
    throw failures.find((err) => !(err instanceof CallPoolAborted)) ?? failures[0];
  }
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}
