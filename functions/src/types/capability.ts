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
