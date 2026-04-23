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
  user_approved: boolean;

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
  experience_unit_id: UUID;
  job_requirement_unit_id: UUID;

  semantic_score: number;
  rule_score: number;
  final_score: number;

  rationale: string;
  surface_evidence: string;

  approved_for_use: boolean;
  user_rejected: boolean;

  created_at: ISOTimestamp;
}

export type NarrativePurpose =
  | "resume_bullet"
  | "resume_summary"
  | "cover_letter_body"
  | "cover_letter_hook"
  | "outreach";

export interface UnitCluster {
  id: UUID;
  application_id: UUID;
  label: string;
  experience_unit_ids: UUID[];
  narrative_purpose: NarrativePurpose;
  generated_text?: string;
}
