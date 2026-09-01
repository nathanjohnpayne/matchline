/**
 * The `deriveMatchEvidence` callable's response contract (#441).
 *
 * **Why these three types live here and not beside the logic
 * that produces them.** `functions/src/matching/evidence.ts`
 * imports `score.ts`, which imports `normalize.ts`, which reads
 * the ontology seed files through `node:fs`. The app can import
 * types from the functions package — it sets no `rootDir` and
 * runs `noEmit`, so the TS6059 hazard runs only in the other
 * direction — but it carries no `@types/node`, so a type-only
 * import that drags `node:fs` into the app's program fails to
 * resolve.
 *
 * A leaf module with no imports at all sidesteps that entirely,
 * and keeps the contract declared exactly once: the alternative
 * was a hand-copied union in `src/`, which is the drift #443
 * exists to stop.
 */

/**
 * What we can say about one match's structural evidence.
 *
 * The third state is the whole point. "We could not check this"
 * is not the same claim as "we checked and there is nothing
 * there", and a Gaps view that collapses them either invents a
 * gap the user cannot act on or hides one they need to see.
 */
export type EvidenceVerdict = "evidenced" | "unevidenced" | "unverifiable";

/**
 * Why a pair could not be verified. Carried alongside the verdict
 * so the UI can say something specific rather than a generic
 * shrug, and so tests can assert the reason rather than just the
 * state.
 */
export type UnverifiableReason =
  | "unit_missing"
  | "requirement_missing"
  | "unit_unapproved"
  | "unit_reembed_pending"
  | "unit_embedding_missing"
  | "requirement_embedding_missing";

export interface MatchEvidence {
  readonly verdict: EvidenceVerdict;
  /** Present only when `verdict === "unverifiable"`. */
  readonly reason?: UnverifiableReason;
  /**
   * True when the verdict came from the persisted
   * `structural_evidence` field rather than from derivation. Lets
   * a caller distinguish "the matcher decided this" from "we
   * worked it out on read".
   */
  readonly stored: boolean;
}
