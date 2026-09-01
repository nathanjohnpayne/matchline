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
 * a browser error object that the UI discarded.
 *
 * Logging at the throw site rather than in each callable keeps one
 * copy: the pipelines are also driven by the eval harness and by CLI
 * reproductions, and all of those benefit from the same output.
 *
 * ## Redaction: fixed fields only, never provider or validator text
 *
 * This module emits **no free-form message from any provider or from
 * Zod.** That is a hard rule, and an earlier draft of it — truncating
 * messages to 400 characters — was wrong in a way worth recording,
 * because truncation reads like redaction and is not.
 *
 * Zod v4's `error.message` is the JSON serialization of the issue list.
 * For a `.strict()` object — which every prompt-response schema here is
 * — a hallucinated property name produces an `unrecognized_keys` issue
 * whose `keys` array carries that name verbatim, at the *front* of the
 * message. Since the model is transcribing a résumé or a job
 * description, those names can be user content. Observed directly
 * while reviewing this file:
 *
 * ```
 * [{ "code": "unrecognized_keys",
 *    "keys": ["Led Disney launch on Vega OS (Kepler)", "hire@example.com"],
 *    ... }]
 * ```
 *
 * A leading 400-character slice preserves that intact. Provider
 * transport errors carry the same hazard: a 4xx body can echo request
 * content back.
 *
 * So the log carries only values drawn from fixed vocabularies:
 *
 * - `kind` — the pipeline's own enum (`transport_error`, `schema_error`,
 *   `no_tool_use`, `max_tokens_exceeded`, `value_error`).
 * - `status` — an HTTP status parsed out of a transport message, as a
 *   number. Nothing else from that string is kept.
 * - `issues` — Zod issue `code`s and `path`s. Paths are schema-authored
 *   field names and array indices, never model output; `keys` and
 *   `message` are dropped. Path elements are additionally filtered
 *   against a conservative identifier pattern, so a schema that later
 *   grows a `z.record()` cannot start leaking through this field.
 *
 * That loses nothing operationally. `kinds` alone separates a
 * credential or connectivity fault (all `transport_error`) from a
 * prompt or contract fault (`schema_error`), and `status: 401` names a
 * credential problem outright — a faster diagnosis than the truncated
 * message it replaces.
 *
 * `ownerUid` is excluded, matching the contract `cost.ts` follows for
 * its own failure paths. Codex P1 on PR #427.
 */

import { logger } from "firebase-functions";

/** Cap on issues logged per attempt, so one bad response can't flood a line. */
const MAX_ISSUES_PER_ATTEMPT = 12;

/**
 * Schema-authored identifier shape. Anything outside it is replaced,
 * so a future `z.record()` key cannot ride out through `path`.
 */
const SAFE_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Leading HTTP status in a provider SDK error message — the SDK
 * formats these as `"401 {...}"`. Anchored, so a digit appearing later
 * in an echoed body cannot match.
 */
const LEADING_HTTP_STATUS = /^\s*([1-5]\d{2})\b/;

export interface RetryAttemptFailure {
  readonly attempt: number;
  readonly kind: string;
  readonly message?: string;
  readonly zodIssues?: readonly unknown[];
}

interface SafeIssue {
  readonly code: string;
  readonly path: string;
}

function safePath(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .map((seg) => {
      if (typeof seg === "number") return String(seg);
      if (typeof seg === "string" && SAFE_PATH_SEGMENT.test(seg)) return seg;
      // Model-controlled or otherwise unrecognized: keep the position,
      // drop the value.
      return "*";
    })
    .join(".");
}

function safeIssues(raw: readonly unknown[] | undefined): SafeIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ISSUES_PER_ATTEMPT).map((issue) => {
    const i = issue as { code?: unknown; path?: unknown };
    return {
      code: typeof i?.code === "string" ? i.code : "unknown",
      path: safePath(i?.path),
    };
  });
}

function httpStatus(message: string | undefined): number | undefined {
  if (typeof message !== "string") return undefined;
  const m = LEADING_HTTP_STATUS.exec(message);
  return m ? Number(m[1]) : undefined;
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
    const list = Array.isArray(failures) ? failures : [];
    logger.error(`${stage}: retry budget exhausted after ${list.length} attempt(s)`, {
      stage,
      model,
      // Kinds first and unabridged: all-`transport_error` is the
      // signature of a credential or connectivity fault, while
      // `schema_error` is a prompt or contract fault. That single
      // field separates the two classes at a glance.
      kinds: list.map((f) => f?.kind ?? "unknown"),
      attempts: list.map((f) => {
        const status = httpStatus(f?.message);
        const issues = safeIssues(f?.zodIssues);
        return {
          attempt: f?.attempt,
          kind: f?.kind ?? "unknown",
          ...(status !== undefined && { status }),
          ...(issues.length > 0 && { issues }),
        };
      }),
    });
  } catch {
    // Swallow: see the non-throwing contract above. There is no
    // meaningful recovery from a logger failure, and the caller is
    // already on its way to reporting a real error.
  }
}
