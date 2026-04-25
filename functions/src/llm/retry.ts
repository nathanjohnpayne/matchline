/**
 * Exponential-backoff helper for transport-error retries on LLM calls.
 *
 * Why: V1 is single-user low-volume, but Anthropic + OpenAI rate
 * limits CAN trigger on bursty usage (e.g. validating an asset with
 * 10+ bullets fans out N×3 LLM calls in a tight burst). Without
 * backoff, a 429 produces 3 rapid retries that compound the
 * rate-limit window. CodeRabbit flagged the missing backoff on
 * PR #111.
 *
 * Scope: only the *transport-error* branch of each per-call retry
 * loop (extraction/resume.ts, parsing/jd.ts,
 * validation/claimExtraction.ts, validation/traceability.ts) calls
 * into `transportBackoffMs` + `sleep`. Schema-error and
 * no-tool-use failures stay zero-delay — those are content failures
 * the model can correct on the very next attempt; sleeping there
 * just slows the happy retry without addressing any server-side
 * pressure.
 *
 * 429 / 503 detection: Anthropic SDK exposes `err.status` on
 * `APIError`. When the status is 429 (rate-limited) or 503 (server
 * overload), both the base delay and cap are doubled — the
 * server-side window is real, so we sit out longer. Other transport
 * errors (ECONNRESET, ETIMEDOUT, etc.) use the shorter schedule.
 */

const BASE_MS = 500;
const CAP_MS = 5000;
const RATE_LIMIT_BASE_MS = 1000;
const RATE_LIMIT_CAP_MS = 10000;
const JITTER_MS = 250;

/**
 * Compute the backoff in milliseconds for a given retry attempt and
 * the error that triggered it.
 *
 * Schedule (default): `min(500 * 2^attempt, 5000) + random(0..249)`
 * — 500ms, 1s, 2s, 4s, 5s (capped), with up to 250ms uniform jitter
 * to spread out simultaneous burst clients.
 *
 * Schedule (status 429 or 503): `min(1000 * 2^attempt, 10000) +
 * jitter` — doubled base and cap. The server has explicitly told us
 * to slow down; honor it.
 *
 * Returns a non-negative integer. `attempt` is clamped to ≥0 so a
 * bad caller doesn't produce `2^negative` weirdness.
 */
export function transportBackoffMs(attempt: number, err?: unknown): number {
  const status = extractStatus(err);
  const isRateLimited = status === 429 || status === 503;
  const baseMs = isRateLimited ? RATE_LIMIT_BASE_MS : BASE_MS;
  const capMs = isRateLimited ? RATE_LIMIT_CAP_MS : CAP_MS;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = Math.min(baseMs * 2 ** safeAttempt, capMs);
  const jitter = Math.floor(Math.random() * JITTER_MS);
  return exponential + jitter;
}

/**
 * Promise-wrapped `setTimeout`. Centralized here so all four LLM
 * call sites use the same primitive and tests can pin behavior by
 * spying on `setTimeout` once.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}
