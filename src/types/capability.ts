import type { ISODate, ISOTimestamp, UUID } from "./crm.ts";

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

export interface ExperienceUnit {
  id: UUID;
  /**
   * Firebase Auth UID of the document's owner. Stamped by the service
   * layer on write; enforced by `firestore.rules`. See sub-issue #59
   * for the `ownerScope()` helper threading.
   */
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
   * Tri-state approval surface. The combination of `user_approved`,
   * `rejected`, and `flagged` encodes the four states the Unit Review
   * UI exposes (approved / pending / rejected / flagged):
   *
   *   - approved → `user_approved: true`, others false/unset
   *   - pending → `user_approved: false`, others false/unset
   *   - rejected → `user_approved: false`, `rejected: true`
   *   - flagged → `user_approved: false`, `flagged: true`
   *
   * Use the `flagsForApprovalState()` helper in
   * `src/services/experienceUnits-state.ts` to derive the combination
   * from a single state name — never set the flags individually from
   * a route, or the four states drift out of sync. Issue #82 exercises
   * the rejected-exclusion guarantee end-to-end.
   */
  user_approved: boolean;
  /** True when the user has explicitly rejected this Unit. Excluded from matching. */
  rejected?: boolean;
  /**
   * True when the user has flagged this Unit for later review.
   * Exclusive-with-approved by design: flagging forces
   * `user_approved: false` via `flagsForApprovalState()` — "I want
   * a second look at this" implies "don't use it for matching
   * yet." If a future requirement needs flagged-AND-approved, add
   * a new field rather than widening this one.
   */
  flagged?: boolean;

  /**
   * True when a write has invalidated the stored `embedding` (currently:
   * any mutation to `raw_text` or `normalized_summary`). Cleared by the
   * re-embed callable in `functions/src/callables/reembedExperienceUnit.ts`
   * (sub-issue #84) once the embedding is regenerated.
   */
  reembed_pending?: boolean;

  date_range?: DateRange;

  /** Embedding of normalized_summary; length depends on the model in use. */
  embedding?: number[];

  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
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
  /** See ExperienceUnit.owner_uid. */
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

export interface UnitMatch {
  id: UUID;
  /** See ExperienceUnit.owner_uid. */
  owner_uid: UUID;
  experience_unit_id: UUID;
  job_requirement_unit_id: UUID;
  /**
   * Denormalized from `jobRequirementUnits.role_id` — the
   * canonical relationship is Match → Requirement → Role, but
   * the Matches tab (#21) reads matches scoped by Role and
   * the matching pipeline (#99) atomic-replaces by Role. A
   * direct `where("role_id", "==", roleId)` is dramatically
   * simpler than chunked join-via-Requirements with
   * Firestore's `in`-clause limit. The pipeline owns the
   * write side; readers must NEVER mutate role_id directly
   * (re-running matching is the only way it changes, since
   * a Requirement's role_id can't change either — Requirements
   * are scoped at parse time).
   */
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
   * it; reader falls back to a "breakdown unavailable"
   * placeholder. One rerun of the matching pipeline heals
   * the corpus.
   */
  components?: ScoreComponents;

  rationale: string;
  surface_evidence: string;

  approved_for_use: boolean;
  user_rejected: boolean;

  created_at: ISOTimestamp;
}

/**
 * The 7 weighted sub-components that contribute to a
 * UnitMatch's `rule_score`. Mirrors `ScoreComponents` in
 * `functions/src/matching/score.ts`; declared here so the
 * client + server share the contract. Each value in [0, 1].
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

export type NarrativePurpose =
  | "resume_bullet"
  | "resume_summary"
  | "cover_letter_body"
  | "cover_letter_hook"
  | "outreach";

export interface UnitCluster {
  id: UUID;
  /** See ExperienceUnit.owner_uid. */
  owner_uid: UUID;
  application_id: UUID;
  label: string;
  experience_unit_ids: UUID[];
  narrative_purpose: NarrativePurpose;
  generated_text?: string;
}
