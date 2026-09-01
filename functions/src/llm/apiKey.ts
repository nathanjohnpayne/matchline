/**
 * API-key normalization for every LLM provider client.
 *
 * **Why this exists (#426).** Both `ANTHROPIC_API_KEY` and
 * `OPENAI_API_KEY` in `matchline-dev` were stored with a trailing
 * newline — 109 raw bytes against 108 stripped, the classic result of
 * `echo "$key" | gcloud secrets create --data-file=-`. Secret Manager
 * mounts the raw bytes into the container's environment, so the SDK
 * sent `x-api-key: sk-ant-…\n`, which is a malformed HTTP header. Every
 * Anthropic call failed in under a second, all three retry attempts
 * burned instantly, and the user saw "Extraction failed after retries;
 * needs manual review."
 *
 * That failure was expensive to find for two reasons worth recording:
 *
 * 1. **It is invisible to shell-based verification.** Reading the same
 *    secret with `$(gcloud secrets versions access …)` strips the
 *    trailing newline in command substitution, so a local reproduction
 *    using "the same key" succeeds while production fails. The bug
 *    hides from the most natural way to test for it.
 * 2. **Nothing logged it.** Transport failures are collected into the
 *    error's `failures` array and never written to Cloud Logging (also
 *    fixed in #426), so the container recorded no reason at all.
 *
 * The secret has since been rewritten cleanly, but a value arriving
 * from a secret store is outside this codebase's control and can be
 * re-contaminated by any future rotation typed with `echo`. Normalizing
 * at the single point where a key becomes a client is the durable fix:
 * it cannot regress the way a one-off secret rewrite can.
 *
 * Trimming a credential is safe — no provider issues keys with
 * meaningful leading or trailing whitespace, and a key that only
 * differs by surrounding whitespace is the same key.
 */

/**
 * Trim surrounding whitespace from a provider API key.
 *
 * **Deliberately does not throw on an empty result.** An earlier draft
 * did, and the generation pipeline's tests caught why that is wrong:
 * `runGenerationPipeline` constructs its client on its first line,
 * *before* `loadInputs` runs. Throwing here would mean an
 * application-not-found or no-approved-Units failure surfaces as a
 * credential error — replacing an accurate diagnosis with a
 * misleading one, which is the exact failure mode this PR exists to
 * remove. Client construction is too early a point to adjudicate
 * configuration.
 *
 * An empty key is not left undiagnosed, though: it yields a 401 on
 * every attempt, and `logRetryExhaustion` now writes `kinds:
 * ["transport_error", ...]` to Cloud Logging at the point the retry
 * budget is exhausted. That is where a credential fault belongs —
 * attributed to the call that actually failed.
 *
 * @param raw the value as read from the secret store or environment
 */
export function normalizeApiKey(raw: string | undefined): string {
  return (raw ?? "").trim();
}
