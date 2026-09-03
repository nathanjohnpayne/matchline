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
 * "Slow down" status detection: Anthropic SDK exposes `err.status`
 * on `APIError`. When the status indicates the server is rate-
 * limiting us or is overloaded — `429`, `502`, `503`, `504`, or
 * Anthropic's documented `529 "Overloaded"` — both the base delay
 * and the cap are doubled. Other transport errors (ECONNRESET,
 * ETIMEDOUT, raw network failures) use the shorter schedule.
 *
 * **Server-supplied retry hints (#114).** Anthropic returns a
 * `retry-after` header on `429` (RFC 7231: integer seconds OR
 * HTTP-date) and `anthropic-ratelimit-{requests,tokens}-reset` ISO
 * 8601 timestamps on rate-limit responses. `extractRetryAfterMs`
 * pulls those from the error and `transportBackoffMs` uses
 * `max(headerHint, exponential)` so the hint elevates the delay
 * but a missing or malformed header silently falls through to the
 * exponential schedule. `max` (not override) keeps jitter on every
 * path, which still matters under bursty fan-out.
 */

const BASE_MS = 500;
const CAP_MS = 5000;
const RATE_LIMIT_BASE_MS = 1000;
const RATE_LIMIT_CAP_MS = 10000;
const JITTER_MS = 250;

/**
 * Node's `setTimeout` clamps delays larger than the int32 ceiling
 * (2,147,483,647 ms — about 24.85 days) down to **1 ms**, which
 * triggers an immediate retry instead of the long backoff the
 * caller asked for. CodeRabbit Critical on PR #144: a malicious
 * or buggy `retry-after: <distant-future-HTTP-date>` header could
 * weaponize that quirk into a tight retry loop, exactly the burst
 * we're trying to dampen. Cap header-elevated delays here so the
 * helper never returns more than `setTimeout` can faithfully honor.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * HTTP statuses where the server (or an upstream proxy) is asking
 * us to slow down. Anthropic-specific: `529` is their documented
 * "Overloaded" code. The proxy codes `502` / `504` are included
 * because they're functionally equivalent to "service is sick,
 * back off" — distinct from a flat-out network failure.
 */
const SLOW_DOWN_STATUSES: ReadonlySet<number> = new Set([
  429, 502, 503, 504, 529,
]);

/**
 * Compute the backoff in milliseconds for a given retry attempt and
 * the error that triggered it.
 *
 * Schedule (default): `min(500 * 2^attempt, 5000) + random(0..249)`
 * — 500ms, 1s, 2s, 4s, 5s (capped), with up to 250ms uniform jitter
 * to spread out simultaneous burst clients.
 *
 * Schedule ("slow down" statuses 429/502/503/504/529):
 * `min(1000 * 2^attempt, 10000) + jitter` — doubled base and cap.
 * The server has explicitly told us to slow down; honor it.
 *
 * **Server hint (#114).** If the error carries a parseable
 * `retry-after` or `anthropic-ratelimit-*-reset` header, the
 * computed delay is `max(headerHint, exponential)` so the server's
 * reset window elevates the delay (e.g. 30-second `retry-after`
 * dominates the 1-second exponential) without ever shortening it
 * below the exponential floor. Missing/malformed headers silently
 * fall through.
 *
 * Returns a non-negative integer. `attempt` is clamped to ≥0 so a
 * bad caller doesn't produce `2^negative` weirdness, and a
 * non-finite `attempt` (`NaN`/`±Infinity`) falls back to attempt 0
 * so it can't propagate a `NaN` delay into `setTimeout` (which
 * treats non-finite delays as 1ms → a tight retry storm).
 */
export function transportBackoffMs(attempt: number, err?: unknown): number {
  const status = extractStatus(err);
  const slowDown = status !== undefined && SLOW_DOWN_STATUSES.has(status);
  const baseMs = slowDown ? RATE_LIMIT_BASE_MS : BASE_MS;
  const capMs = slowDown ? RATE_LIMIT_CAP_MS : CAP_MS;
  const safeAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  const exponential = Math.min(baseMs * 2 ** safeAttempt, capMs);
  const jitter = Math.floor(Math.random() * JITTER_MS);
  // Server-supplied hint elevates the delay; jitter still applies
  // on top so two burst clients with the same hint don't retry on
  // the same millisecond. Cap the final value at `MAX_TIMER_DELAY_MS`
  // so a header-supplied far-future timestamp can't get clamped by
  // `setTimeout` to 1 ms and trigger a tight retry storm.
  const headerHint = extractRetryAfterMs(err);
  const elevated = Math.max(exponential, headerHint ?? 0);
  return Math.min(elevated + jitter, MAX_TIMER_DELAY_MS);
}

/**
 * Promise-wrapped `setTimeout`. Centralized here so all four LLM
 * call sites use the same primitive and tests can pin behavior by
 * spying on `setTimeout` once.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Abort-aware: a transport failure can carry a long `retry-after`,
  // and an unconditional wait keeps the callable alive through it even
  // though the caller has gone and the next attempt will be skipped
  // anyway. Resolves (rather than rejecting) on abort so the retry loop
  // handles cancellation in one place — its pre-attempt check — instead
  // of needing a second path here (CodeRabbit P1, #436).
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * Pull a parseable retry-after hint (in milliseconds, relative to
 * `now`) from a transport error's response headers. Returns `null`
 * when no usable header is present so the caller can silently fall
 * through to the exponential schedule.
 *
 * Header strategy:
 *
 * 1. **`retry-after`** — RFC 7231 §7.1.3 (integer delta-seconds OR
 *    RFC 1123 HTTP-date). Anthropic returns this on `429`. When
 *    parseable, this is the canonical hint and wins outright.
 * 2. **`anthropic-ratelimit-requests-reset` +
 *    `anthropic-ratelimit-tokens-reset`** — ISO 8601 timestamps.
 *    Anthropic exposes these separately because the request-rate
 *    and token-rate windows can reset at *different* times. When
 *    both are present, take the **max** — retrying before the
 *    later one resets just burns the next attempt on another 429.
 *    Codex P2 on PR #144.
 *
 * Negative deltas (header timestamp in the past — clock skew or
 * stale cached error) are dropped so the exponential schedule
 * doesn't get pinned at 0.
 *
 * Both upper- and lower-case header keys are accepted because the
 * Anthropic SDK and Node `fetch` differ on canonicalization, and
 * test harnesses commonly construct plain objects with whatever
 * casing the author typed.
 *
 * **Side-effect free** — `now` defaults to `Date.now()` but can be
 * injected for deterministic testing.
 */
export function extractRetryAfterMs(
  err: unknown,
  now: number = Date.now(),
): number | null {
  const headers = extractHeaders(err);
  if (!headers) return null;

  // 1. `retry-after`: delta-seconds OR HTTP-date. Canonical hint —
  // when parseable it wins outright.
  const retryAfter = headers["retry-after"];
  if (typeof retryAfter === "string" && retryAfter.length > 0) {
    const ms = parseRetryAfter(retryAfter, now);
    if (ms !== null && ms >= 0) return ms;
  }

  // 2. Fall back to anthropic-ratelimit-{requests,tokens}-reset.
  // The two windows reset independently — take the max of any
  // parseable values so we wait long enough that BOTH limits
  // have reset before retrying. Codex P2 on PR #144.
  const candidates: number[] = [];
  for (const key of [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
  ] as const) {
    const value = headers[key];
    if (typeof value === "string" && value.length > 0) {
      const ms = parseIsoOffsetMs(value, now);
      if (ms !== null && ms >= 0) candidates.push(ms);
    }
  }
  if (candidates.length > 0) return Math.max(...candidates);

  return null;
}

/**
 * Lift `err.headers` to a lowercase-keyed Record. Returns `null`
 * when the field is absent or not a plain object. Handles two
 * shapes the Anthropic SDK has used historically:
 *
 * - Plain `Record<string, string>` (current SDK).
 * - Web `Headers` instance (older transport paths) — has
 *   `.entries()` returning lowercase keys per the Fetch spec.
 *
 * Anything else (string, number, null) yields `null` so the caller
 * falls through cleanly.
 */
function extractHeaders(err: unknown): Record<string, string> | null {
  if (!err || typeof err !== "object" || !("headers" in err)) return null;
  const raw = (err as { headers: unknown }).headers;
  if (!raw || typeof raw !== "object") return null;

  // Web Headers instance: prefer .entries() so we get the spec-
  // compliant lowercase keys.
  if (
    "entries" in raw &&
    typeof (raw as { entries: unknown }).entries === "function"
  ) {
    const out: Record<string, string> = {};
    try {
      for (const [k, v] of (raw as Headers).entries()) {
        if (typeof v === "string") out[k.toLowerCase()] = v;
      }
      return out;
    } catch {
      // Fall through to plain-object handling.
    }
  }

  // Plain object: lowercase the keys defensively.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Parse `retry-after` per RFC 7231 §7.1.3:
 *
 * - delta-seconds: a non-negative integer (e.g. `"30"`). Returned
 *   as ms.
 * - HTTP-date: RFC 1123 format
 *   (`"Wed, 21 Oct 2015 07:28:00 GMT"`). Parsed via `Date.parse`
 *   (which handles RFC 1123 / 2822). Returned as offset-ms from
 *   `now`.
 *
 * Returns `null` for unparseable values. Fractional or negative
 * delta-seconds are rejected (RFC requires non-negative integer).
 */
function parseRetryAfter(value: string, now: number): number | null {
  const trimmed = value.trim();

  // delta-seconds form: digits only.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return null;
  }

  // HTTP-date form: defer to Date.parse, which handles RFC 1123
  // (and is permissive enough to accept RFC 850 and asctime forms
  // we'd see in the wild).
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return ts - now;
  }
  return null;
}

/**
 * Parse an ISO 8601 timestamp and return the offset in ms from
 * `now`. Returns `null` for unparseable values.
 */
function parseIsoOffsetMs(value: string, now: number): number | null {
  const ts = Date.parse(value.trim());
  if (Number.isFinite(ts)) {
    return ts - now;
  }
  return null;
}
