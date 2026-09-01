/**
 * Server-side mirror of the ExperienceUnit shape from
 * `src/types/capability.ts` (the frontend types).
 *
 * Kept in sync manually until a `shared/` module lands. The two
 * files must agree on the document shape — they're both declarations
 * of the same Firestore contract. If you change one, change the
 * other and verify `scripts/ci/check_spec_test_alignment` stays
 * green.
 *
 * Why duplicate: tsconfig isolates `src/` (frontend) from
 * `functions/src/` (backend) — each package has its own rootDir.
 * A cross-package import triggers TS6059. Alternatives (widening
 * rootDir, path mapping to a sibling package) add deployment
 * complexity for a handful of small type files. Duplicate + drift
 * guard is the pragmatic compromise at V1 scale.
 */

export type UUID = string;
export type ISOTimestamp = string;
export type ISODate = string;

export type UnitSourceType = "resume" | "linkedin" | "long_form" | "manual";

export type UnitType =
  | "project"
  | "achievement"
  | "ownership"
  | "skill_demo"
  | "leadership"
  | "technical_decision";

export type EvidenceType = "verified" | "inferred" | "user_confirmed";

export type MetricDirection = "up" | "down";
export type MetricConfidence = "high" | "medium" | "low";

export interface Metric {
  claim: string;
  value?: number;
  unit?: string;
  direction?: MetricDirection;
  confidence: MetricConfidence;
}

export interface DateRange {
  start: ISODate;
  end?: ISODate;
}

export type RequirementCategory =
  | "skill"
  | "tool"
  | "domain"
  | "experience_level"
  | "scope"
  | "soft_skill"
  | "credential";

export type SeniorityLevel =
  | "junior"
  | "mid"
  | "senior"
  | "staff"
  | "principal"
  | "director";

export type RequirementSource =
  | "responsibilities"
  | "qualifications"
  | "nice_to_have"
  | "description";

export type RequirementPriority = "high" | "medium" | "low";

export interface JobRequirementUnit {
  id: UUID;
  owner_uid: UUID;
  role_id: UUID;
  raw_text: string;
  normalized_requirement: string;
  category: RequirementCategory;

  keywords: string[];
  tools: string[];
  domains: string[];
  seniority_level?: SeniorityLevel;

  priority: RequirementPriority;
  must_have: boolean;

  extracted_from: RequirementSource;

  embedding?: number[];
}

export interface ExperienceUnit {
  id: UUID;
  owner_uid: UUID;
  source_type: UnitSourceType;
  source_ref: string;
  raw_text: string;
  normalized_summary: string;
  unit_type: UnitType;

  skills: string[];
  tools: string[];
  domains: string[];
  seniority_signals: string[];
  scope_signals: string[];
  business_outcomes: string[];
  metrics: Metric[];

  evidence_type: EvidenceType;
  confidence_score: number;

  /**
   * Tri-state approval surface. See `src/types/capability.ts` for the
   * full table — these three fields together encode approved / pending
   * / rejected / flagged. The flag combination is set via
   * `flagsForApprovalState()` in
   * `src/services/experienceUnits-state.ts`; the same helper would be
   * mirrored here if a server-side state flip lands (sub-issue #82
   * confirms the rejected-exclusion query path).
   */
  user_approved: boolean;
  rejected?: boolean;
  flagged?: boolean;

  /**
   * True when a write has invalidated the stored embedding. Cleared by
   * `functions/src/callables/reembedExperienceUnit.ts` (sub-issue #84)
   * after the embedding is regenerated.
   */
  reembed_pending?: boolean;

  date_range?: DateRange;

  embedding?: number[];

  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

/**
 * Server-side mirror of UnitMatch. See `src/types/capability.ts`
 * for the canonical type. The matching pipeline (#99) writes
 * this; the Matches tab (#21) reads it.
 *
 * `role_id` is denormalized from the Match's Requirement so the
 * Matches-tab + pipeline-replace queries can scope by Role
 * without joining through Requirements.
 */
export interface UnitMatch {
  id: UUID;
  owner_uid: UUID;
  experience_unit_id: UUID;
  job_requirement_unit_id: UUID;
  role_id: UUID;

  semantic_score: number;
  rule_score: number;
  final_score: number;

  /**
   * The 7 weighted sub-components that produce `rule_score`.
   * Persisted alongside the score so the Matches tab's
   * sub-score breakdown tooltip (#21 / sub-issue #131) can
   * render without re-computing. Each value is in [0, 1];
   * `rule_score = Σ(component × weight)` with weights from
   * `WEIGHTS` in `functions/src/matching/score.ts`.
   *
   * Optional because pre-#131 matches in storage won't have
   * it; the matching pipeline's carry-forward (cursor #133
   * r2) doesn't reach into this field, but every NEW match
   * persisted post-#131 includes it. Reader-side: fall back
   * to `undefined` and skip the breakdown for legacy rows
   * (one rerun heals the corpus).
   */
  components?: ScoreComponents;

  /**
   * True when the Requirement constrained at least one
   * structural axis that the engine could actually evaluate —
   * skill / tool / domain vocabulary that survives
   * canonicalization, a ladder-mapped `seniority_level`, or a
   * scope-category Requirement with canonicalizable keywords.
   *
   * False means every structural axis fell back to a
   * no-constraint default, so `final_score` rests on semantics
   * plus ~0.425 of unearned neutral credit. `computeGaps`
   * refuses to treat such a match as covering a must-have; the
   * match still renders and still ranks, per the spec non-goal
   * "does not hide low-quality matches."
   *
   * Optional for the same reason as `components`: rows written
   * before this field existed won't have it. Readers treat
   * `undefined` as "legacy, don't block", but note that legacy
   * rows are NOT inherently safe — the pre-#430 rule paid the
   * same neutral when both sides canonicalized to empty. The
   * allowance holds because `shouldAutoTriggerMatching` reruns
   * matching whenever a loaded match lacks the field, so
   * opening the Role backfills it (no LLM call needed).
   */
  structural_evidence?: boolean;

  rationale: string;
  surface_evidence: string;

  approved_for_use: boolean;
  user_rejected: boolean;

  created_at: ISOTimestamp;
}

/**
 * The 7 weighted sub-components that contribute to a
 * UnitMatch's `rule_score`. Mirrors `ScoreComponents` in
 * `functions/src/matching/score.ts` (the canonical source);
 * declared here so the client + server share a contract for
 * the field. Each value in [0, 1].
 */
export interface ScoreComponents {
  readonly semantic_similarity: number;
  readonly skill_overlap: number;
  readonly domain_overlap: number;
  readonly tool_overlap: number;
  readonly seniority_alignment: number;
  readonly scope_alignment: number;
  readonly recency: number;
}
