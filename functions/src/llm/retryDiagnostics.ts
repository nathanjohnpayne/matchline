/**
 * Emit a retry-exhaustion failure log before a pipeline gives up.
 *
 * **Why this exists (#426).** Every LLM pipeline in this codebase
 * collects per-attempt failures into a `failures` array, attaches it to
 * a typed error, and the callable forwards it to the browser as
 * `HttpsError.details`. Nothing ever wrote it to Cloud Logging.
 *
 * The cost of that gap was concrete. When both provider API keys turned
 * out to carry a trailing newline, every Anthropic call failed in under
 * a second with a malformed `x-api-key` header. The container logged
 * `Callable request verification passed` and then nothing at all — the
 * three transport errors that explained the whole failure went only to
 * a browser error object that the UI discarded. Diagnosis took hours
 * and needed a local harness, a byte-level secret comparison, and four
 * wrong hypotheses. The answer was sitting in `failures` the entire
 * time.
 *
 * Logging at the throw site rather than in each callable keeps one
 * copy: the pipelines are also driven by the eval harness and by CLI
 * reproductions, and all of those benefit from the same output.
 *
 * **Redaction.** `ownerUid` is deliberately excluded, matching the
 * contract `cost.ts` already follows for its own failure paths — an
 * observability log must not widen PII exposure. Failure messages come
 * from provider SDKs and Zod, not from user content: a `raw_text`
 * fragment can appear in a Zod issue's `path`/`message`, so messages
 * are truncated rather than emitted whole.
 */

import { logger } from "firebase-functions";

/** Cap per-attempt message length so one Zod dump can't flood a log line. */
const MAX_MESSAGE_CHARS = 400;

export interface RetryAttemptFailure {
  readonly attempt: number;
  readonly kind: string;
  readonly message: string;
}

/**
 * Log the per-attempt failure summary for an exhausted retry budget.
 *
 * Never throws: an observability call must not be able to convert a
 * "needs manual review" outcome into an unhandled crash. Mirrors the
 * "telemetry never blocks the caller" invariant in `cost.ts`.
 *
 * @param stage  pipeline label for grep-ability, e.g. `"extraction.resume"`
 * @param model  the model identifier the attempts ran against
 */
export function logRetryExhaustion(
  stage: string,
  model: string,
  failures: readonly RetryAttemptFailure[],
): void {
  try {
    logger.error(`${stage}: retry budget exhausted after ${failures.length} attempt(s)`, {
      stage,
      model,
      // Kinds first and unabridged: `transport_error` on every attempt
      // is the signature of a credential or connectivity fault, while
      // `schema_error` is a prompt or contract fault. That single field
      // separates the two classes at a glance.
      kinds: failures.map((f) => f.kind),
      attempts: failures.map((f) => ({
        attempt: f.attempt,
        kind: f.kind,
        message:
          typeof f.message === "string"
            ? f.message.slice(0, MAX_MESSAGE_CHARS)
            : String(f.message).slice(0, MAX_MESSAGE_CHARS),
      })),
    });
  } catch {
    // Swallow: see the docstring's non-throwing contract. There is no
    // meaningful recovery from a logger failure, and the caller is
    // already on its way to reporting a real error.
  }
}
