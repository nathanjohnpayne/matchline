/**
 * Curated list of vague phrasings that defeat fact-checking.
 *
 * The specificity check (sub-issue #108 of #23) flags claims
 * that contain these phrases as `specific: false` without any
 * LLM call — deterministic, free, microseconds-fast. The LLM
 * fallback only runs for claims that escape the deny-list.
 *
 * Adding entries doesn't require code changes elsewhere — the
 * checker iterates this array. Each entry includes a comment
 * explaining what makes the phrasing vague, plus a one-line
 * "what specific would look like" example. Entries are case-
 * insensitive substring matches.
 *
 * Why these specific phrases (not exhaustive — V1 starter list):
 *   1. They appear in resume tropes regardless of role.
 *   2. They survive traceability (the user did "collaborate" in
 *      some Unit somewhere) but tell the reader nothing.
 *   3. The validator can dismiss them on shape alone, freeing
 *      LLM-budget for the harder case (specific-but-suspect).
 *
 * Adding entries: keep them lowercase (matcher lowercases
 * inputs); prefer multi-word phrases (single words like "drove"
 * over-flag); include a comment with the rationale.
 */

export interface DenyListEntry {
  /** Substring to match against the lowercased claim text. */
  readonly pattern: string;
  /** Why this phrase is vague — surfaces as the flag rationale. */
  readonly reason: string;
  /** Example of what specific would look like — surfaces as guidance. */
  readonly suggested_specific?: string;
}

export const SPECIFICITY_DENY_LIST: readonly DenyListEntry[] = Object.freeze([
  {
    pattern: "collaborated cross-functionally",
    reason:
      "'Collaborated cross-functionally' is generic — every PM does this. " +
      "The reader can't tell what was specifically collaborated on.",
    suggested_specific:
      "Name the function (engineering, design, data) and what shipped (\"Worked with engineering to ship X\").",
  },
  {
    pattern: "cross-functional collaboration",
    reason:
      "Generic gerund form of 'collaborated cross-functionally' — same generic problem in noun form.",
    suggested_specific:
      "Name the function and the deliverable.",
  },
  {
    pattern: "drove results",
    reason:
      "'Drove results' is the canonical empty PM phrase — supports nothing falsifiable.",
    suggested_specific:
      "Name the result (\"drove a 30% retention lift\", \"shipped X to N users\").",
  },
  {
    pattern: "delivered impact",
    reason:
      "'Impact' is unmeasurable as written — the reader can't tell what was actually delivered.",
    suggested_specific:
      "Name the metric and direction (\"reduced churn by X%\", \"increased throughput by Y\").",
  },
  {
    pattern: "leveraged data",
    reason:
      "'Leveraged data' is a verb that adds no information — every product decision uses data in some sense.",
    suggested_specific:
      "Name the data source and the decision (\"used Amplitude funnel data to prioritize X\").",
  },
  {
    pattern: "data-driven decision",
    reason:
      "Trope phrasing; tells the reader the user values data but not what they did with it.",
    suggested_specific: "Name the specific decision and its data backing.",
  },
  {
    pattern: "moved the needle",
    reason:
      "Pure idiom — meaningless without a metric.",
    suggested_specific:
      "Name the needle (\"moved retention from X% to Y%\").",
  },
  {
    pattern: "synergy",
    reason:
      "'Synergy' / 'synergized' / 'synergies' — corporate-speak with no falsifiable content.",
    suggested_specific:
      "Name what was actually combined and what changed because of it.",
  },
  {
    pattern: "best-in-class",
    reason:
      "'Best-in-class' is a self-assigned superlative; the reader has no way to verify.",
    suggested_specific:
      "Cite the benchmark or comparison (\"top 3 by X metric vs. competitors\").",
  },
  {
    pattern: "world-class",
    reason:
      "'World-class' — same shape as 'best-in-class', same problem.",
    suggested_specific:
      "Cite the comparison or measurement.",
  },
  {
    pattern: "owned strategy",
    reason:
      "'Owned strategy' (alone) — strategy for what? The verb asserts ownership but the object is missing.",
    suggested_specific:
      "Name the product surface or business area whose strategy was owned.",
  },
  {
    pattern: "thought leadership",
    reason:
      "'Thought leadership' is unmeasurable — the reader can't tell what the user actually thought or led.",
    suggested_specific:
      "Cite a specific artifact or initiative the thought-leadership produced.",
  },
]);
