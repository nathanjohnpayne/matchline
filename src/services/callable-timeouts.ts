/**
 * Per-callable client-side deadlines, in milliseconds.
 *
 * Mirror of `functions/src/callables/timeouts.ts`. The client cannot
 * import that table — `functions/` is a separate package with its own
 * `node_modules` and module resolution — so the relationship between
 * the two is enforced by `tests/callable-timeout-budget.test.ts`,
 * which is the only tsconfig project that spans both.
 *
 * **Why these are not the default (#422).** `httpsCallable` defaults
 * to a 70,000 ms client timeout (`@firebase/functions` `callAtURL`:
 * `options.timeout || 70000`). Every LLM-backed callable in this app
 * can run for minutes. Raising only the server budgets would have
 * relocated #422's failure rather than fixed it: the client would
 * abort at 70s and surface `deadline-exceeded` instead of `internal`.
 *
 * **The ordering rule: client > server, always.** Whichever side
 * gives up first decides what the user sees. If the client aborts,
 * the SDK synthesizes its own error and the server's structured
 * `HttpsError` — including the `failed-precondition` retry
 * diagnostics the extraction and parsing pipelines attach — is thrown
 * away. Holding every client deadline strictly above its server
 * budget means a real server verdict always wins the race, and the
 * client deadline is only a backstop for a connection that hangs past
 * the point where Cloud Run should have returned something.
 *
 * `generateResume` is the cautionary case: #124 set its server budget
 * to 90s without touching the client, leaving the client to abort
 * first for every call that ran past 70s. The test enforces the
 * ordering so that inversion cannot recur.
 *
 * Each value is its server budget plus a 30s margin for Cloud Run's
 * own teardown-and-respond tail.
 */
export const CALLABLE_TIMEOUT_MS = {
  extractFromResume: 570_000,
  parseJobRequirements: 330_000,
  generateResume: 330_000,
  validateAsset: 330_000,
  reembedExperienceUnit: 150_000,
  runMatching: 150_000,
} as const;

export type CallableName = keyof typeof CALLABLE_TIMEOUT_MS;

/**
 * Build the options bag for `httpsCallable`. Call sites read as
 * `httpsCallable(client, "name", callableOptions("name"))`, which
 * keeps the callable's name and its deadline adjacent and makes a
 * missing deadline visible at the call site rather than silently
 * falling back to the SDK default.
 */
export function callableOptions(name: CallableName): { timeout: number } {
  return { timeout: CALLABLE_TIMEOUT_MS[name] };
}
