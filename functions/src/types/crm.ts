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

export type AssetKind = "resume" | "cover_letter" | "outreach";
export type AssetFormat = "pdf" | "docx" | "txt" | "json";

export interface GeneratedBullet {
  id: UUID;
  text: string;
  source_unit_ids: UUID[];
}

export interface GeneratedExperienceSection {
  title: string;
  company: string;
  date_range?: string;
  bullets: GeneratedBullet[];
}

export interface GeneratedSummary {
  id: UUID;
  text: string;
  source_unit_ids: UUID[];
}

export interface GeneratedAssetContent {
  summary: GeneratedSummary;
  experience: GeneratedExperienceSection[];
  skills: string[];
  education?: string[];
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
  created_at: ISOTimestamp;
}
