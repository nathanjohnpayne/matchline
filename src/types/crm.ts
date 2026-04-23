export type UUID = string;
export type ISOTimestamp = string;
export type ISODate = string;

export type RelationshipType =
  | "recruiter"
  | "hiring_manager"
  | "referral"
  | "peer"
  | "other";

export interface Person {
  id: UUID;
  name: string;
  role: string;
  company_id: UUID;
  relationship_type: RelationshipType;
  last_contacted_at?: ISOTimestamp;
  notes?: string;
}

export type CompanySize = "seed" | "early" | "growth" | "mid" | "enterprise";
export type Priority = "low" | "medium" | "high";

export interface Company {
  id: UUID;
  name: string;
  industry?: string;
  size?: CompanySize;
  priority: Priority;
  url?: string;
  notes?: string;
}

export type RemotePolicy = "onsite" | "hybrid" | "remote";

export interface Role {
  id: UUID;
  company_id: UUID;
  title: string;
  jd_raw: string;
  jd_url?: string;
  location?: string;
  remote_policy?: RemotePolicy;
  comp_range?: string;
  discovered_at: ISOTimestamp;
}

export type ApplicationStage =
  | "saved"
  | "drafting"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export type AssetKind = "resume" | "cover_letter" | "outreach";
export type AssetFormat = "pdf" | "docx" | "txt";

export interface AssetRef {
  id: UUID;
  kind: AssetKind;
  format: AssetFormat;
  storage_path: string;
  created_at: ISOTimestamp;
}

export interface Application {
  id: UUID;
  role_id: UUID;
  stage: ApplicationStage;
  applied_at?: ISOTimestamp;
  last_activity_at: ISOTimestamp;
  generated_assets: AssetRef[];
  approved_unit_ids: UUID[];
}

export type InteractionType = "email" | "call" | "meeting" | "message" | "note";
export type InteractionDirection = "inbound" | "outbound";

export interface Interaction {
  id: UUID;
  person_id: UUID;
  application_id?: UUID;
  type: InteractionType;
  direction: InteractionDirection;
  summary: string;
  occurred_at: ISOTimestamp;
}
