/**
 * Server-side mirror of the CRM types from `src/types/crm.ts`
 * (the frontend types).
 *
 * Same convention as `capability.ts`: the two files declare the
 * same Firestore contract for Application + AssetRef +
 * ValidationFlag. Kept in sync manually until a `shared/`
 * module lands. If you change one, change the other and verify
 * `scripts/ci/check_spec_test_alignment` stays green.
 */

import type { ISOTimestamp, UUID } from "./capability.js";

export type RemotePolicy = "onsite" | "hybrid" | "remote";

/**
 * Server-side mirror of `Role` from `src/types/crm.ts`. The
 * generation pipeline (#120) loads this for the prompt; the
 * matching engine indirectly references via JobRequirementUnit's
 * `role_id`.
 */
export interface Role {
  id: UUID;
  owner_uid: UUID;
  company_id: UUID;
  title: string;
  jd_raw: string;
  jd_url?: string;
  location?: string;
  remote_policy?: RemotePolicy;
  comp_range?: string;
  discovered_at: ISOTimestamp;
}

export type AssetKind = "resume" | "cover_letter" | "outreach";
export type AssetFormat = "pdf" | "docx" | "txt" | "json";

/**
 * See `src/types/crm.ts` for the full docstring. Same shape
 * across summary / bullets / skills / education — the
 * validation orchestrator (#109) iterates them all uniformly.
 *
 * V1 is intentionally flat (no experience-section grouping).
 * cursor's CHANGES_REQUESTED rounds 3 + 4 on PR #122 surfaced
 * the prior over-promise: schema requiring ungrounded section
 * metadata that the data model couldn't validate. Phase 2
 * adds `employer`/`title` to ExperienceUnit and re-introduces
 * section grouping with grounded metadata.
 */
export interface GeneratedItem {
  id: UUID;
  text: string;
  source_unit_ids: UUID[];
}
export type GeneratedSummary = GeneratedItem;
export type GeneratedBullet = GeneratedItem;
export type GeneratedSkill = GeneratedItem;
export type GeneratedEducation = GeneratedItem;

export interface GeneratedAssetContent {
  summary: GeneratedSummary;
  bullets: GeneratedBullet[];
  skills: GeneratedSkill[];
  education?: GeneratedEducation[];
}

export type ValidationFlagStatus = "traced" | "untraceable" | "specificity";

export interface ValidationFlag {
  id: UUID;
  asset_id: UUID;
  bullet_id: UUID;
  claim_id: UUID;
  status: ValidationFlagStatus;
  supporting_unit_id?: UUID;
  matched_pattern?: string;
  rationale: string;
  created_at: ISOTimestamp;
}

export type ValidationStatus = "pending" | "passed" | "failed" | "stale";

export interface AssetRef {
  id: UUID;
  owner_uid: UUID;
  application_id: UUID;
  kind: AssetKind;
  format: AssetFormat;
  storage_path: string;
  generated_content?: GeneratedAssetContent;
  validation_flags?: ValidationFlag[];
  validation_status: ValidationStatus;
  validated_at?: ISOTimestamp;
  /**
   * Generation telemetry, populated by #121's `generateResume`
   * callable from `runGenerationPipeline`'s cumulative
   * counters. Mirror of the same fields on the client-side
   * type. See `src/types/crm.ts` for full docstrings.
   */
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  created_at: ISOTimestamp;
}
