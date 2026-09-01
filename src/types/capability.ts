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

  /**
   * True when THIS PAIR scored above zero on at least one axis
   * the Requirement actually constrains — canonicalizable
   * skill / tool / domain vocabulary, a ladder-mapped
   * `seniority_level` the Unit also carries a mapped signal
   * for, or a scope-category Requirement with canonicalizable
   * keywords.
   *
   * **It is a property of the pair, not of the Requirement.**
   * `false` therefore covers two distinct situations, and
   * consumers must not read it as only the first:
   *   1. the Requirement constrains nothing evaluable, so every
   *      structural axis fell back to a no-constraint default; or
   *   2. it constrains something and this Unit scored 0.0 on all
   *      of them — an evaluated mismatch.
   * Either way `final_score` rests on semantics plus unearned
   * neutral credit, which is why `computeGaps` refuses to let
   * such a match cover a must-have. The match still ranks and
   * still renders.
   *
   * Optional because rows written before this field existed
   * won't have it. Readers treat `undefined` as "legacy, don't
   * block", but legacy rows are NOT inherently safe — the
   * pre-#430 rule paid the same neutral when both sides
   * canonicalized to empty. The allowance holds because the
   * Role Detail auto-trigger reruns matching whenever a loaded
   * match lacks the field (no LLM call needed), and is
   * withdrawn if that backfill fails.
   */
  structural_evidence?: boolean;
  /**
   * Per-axis applicability for THIS pair: which axes did the
   * engine actually evaluate?
   *
   * `false` on an axis means its value in `components` is a
   * no-constraint neutral rather than a measurement — the
   * Requirement named nothing the canonical vocabulary
   * recognizes, or (for seniority and recency) the Unit carries
   * no mapped signal / no usable date. Readers MUST NOT present
   * such a component as a score: the breakdown tooltip renders
   * it as unavailable, because "0.50 x 0.20 = 0.100" tells the
   * user they achieved 50% overlap on a comparison that never
   * happened.
   *
   * Optional for the same reason as `components` — legacy rows
   * predate it. A reader without it MUST fall back to
   * presenting no per-axis claim: pre-#430 components contain
   * the very neutrals this flag suppresses (both-empty Jaccard
   * stored 0.5; unconstrained seniority and scope stored 1.0),
   * so assuming "measured" for legacy data reintroduces the bug.
   */
  component_applicability?: Readonly<Record<keyof ScoreComponents, boolean>>;

  rationale: string;
  surface_evidence: string;

  approved_for_use: boolean;
  user_rejected: boolean;

  /**
   * Id of the matching run that wrote this row.
   *
   * `replaceMatchesForRole()` rewrites every match under a fresh
   * document id, so "an id I haven't seen" looked like a way for
   * a client to recognise its own replacement. It isn't: a
   * CONCURRENT run — the same Role open in a second tab —
   * produces unseen ids too, so the first run's snapshot
   * satisfies the second tab's test while its own request is
   * still pending. That tab re-enables approvals early and a
   * click after the second commit targets a deleted document.
   *
   * The run id is issued server-side and returned by the
   * callable, so a client can correlate a snapshot with the
   * request it actually made. Codex P2 on #438.
   *
   * Optional: rows written before this field existed lack it,
   * and readers must not treat its absence as a match.
   */
  run_id?: string;

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
