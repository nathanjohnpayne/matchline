/**
 * Per-callable wall-clock budgets, in seconds.
 *
 * **Why this table exists (#422).** Firebase Functions v2 defaults
 * `timeoutSeconds` to 60. Every LLM-backed callable in this app runs
 * a `MAX_ATTEMPTS = 3` retry loop around an Anthropic call, and #145
 * raised the per-attempt output budget to 16,384 tokens in both
 * `extraction/resume.ts` and `parsing/jd.ts`. A single full-length
 * attempt already exceeds 60s; three do so several times over.
 *
 * When a call outlives its budget, Cloud Run kills the container
 * mid-request. The terminated response never carries the CORS headers
 * the callable protocol needs, so the browser's `fetch` rejects and
 * `@firebase/functions` reports a bare `internal` with no diagnostic.
 * That is the failure #422 reported from `/onboarding` and, with the
 * same signature, from the Role Detail JD parse.
 *
 * **Why one table instead of a literal per call site.** These numbers
 * are only meaningful relative to each other and to the client-side
 * deadlines in `src/services/callable-timeouts.ts`. Scattering six
 * literals across six files is how the original drift happened:
 * `generateResume` got a considered 90s in #124 while every sibling
 * silently kept the 60s default, and nothing connected the two sides.
 * `tests/callable-timeout-budget.test.ts` pins this table against its
 * client-side mirror.
 *
 * **Sizing.** Each budget covers a realistic worst case for that
 * callable's pipeline, not its p50. They are deliberately generous:
 * the cost of an over-long budget is a user waiting on a call that
 * was going to fail anyway, while the cost of a short one is the
 * undiagnosable `internal` this table exists to eliminate. Cloud Run
 * bills wall-clock, but only for calls that actually run long, and
 * V1's single-user volume makes that immaterial against the budget
 * caps in `specs/matchline.md § Execution targets`.
 *
 * Note that `specs/matchline.md` still lists an 8s/20s p50/p95 target
 * for extraction. The implementation has long since outgrown that
 * number — see the `MAX_OUTPUT_TOKENS` rationale in
 * `extraction/resume.ts`. These budgets describe what the code does
 * today; reconciling the spec target is separate work.
 */
export const CALLABLE_TIMEOUT_SECONDS = {
  /**
   * Heaviest call in the app. 3 Anthropic attempts at 16,384 output
   * tokens, and `extraction/resume.ts` records that a 9k-character
   * resume serializes to ~10-12k output tokens — a multi-minute
   * single attempt. Then batch embeddings and a Firestore commit.
   *
   * 540s covers a full-length first attempt plus one full-length
   * retry with room for the embed + persist tail. A pathological run
   * that burns all three attempts at the ceiling can still exceed
   * it; that is a deliberate trade against making a user wait ~13
   * minutes to be told extraction failed.
   */
  extractFromResume: 540,

  /**
   * Same 3 × 16,384 shape as extraction, but on Haiku
   * (`modelFor("requirement_parsing")`) and against a JD, which
   * yields far fewer Units than a resume. Faster model, smaller
   * output — but demonstrably past 60s in practice, which is what
   * the second half of #422 reported.
   */
  parseJobRequirements: 300,

  /**
   * Was 90s (#124), chosen against the PRD's 20s p95 target with
   * headroom for the 3-attempt retry budget. Raised for two reasons:
   * the p95 target has proven optimistic across every other LLM
   * stage, and 90s sat ABOVE the client SDK's 70s default, so the
   * client aborted first and the server's structured error was
   * discarded. See the client mirror for that ordering rule.
   */
  generateResume: 300,

  /**
   * Runs several Sonnet passes per invocation — claim extraction,
   * then traceability and specificity over the extracted claims —
   * each with its own 3-attempt budget. The most call-fan-out of any
   * stage even though each individual response is small.
   */
  validateAsset: 300,

  /**
   * One OpenAI embedding call plus an atomic Firestore update. No
   * Anthropic retry loop, so this is fast — the raise over the
   * default is headroom for a slow embeddings response, not for a
   * long pipeline.
   */
  reembedExperienceUnit: 120,

  /**
   * No LLM call at all: pure cosine math over already-persisted
   * embeddings, then a transactional replace. Wall clock scales with
   * (approved Units × Requirements), so the budget covers a large
   * corpus rather than a slow dependency.
   */
  runMatching: 120,
} as const;

export type CallableName = keyof typeof CALLABLE_TIMEOUT_SECONDS;
