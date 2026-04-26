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
  /**
   * Firebase Auth UID of the document's owner. Stamped by the service
   * layer on write; enforced by `firestore.rules`. See sub-issue #59
   * for the `ownerScope()` helper threading.
   */
  owner_uid: UUID;
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
  /** See Person.owner_uid. */
  owner_uid: UUID;
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
  /** See Person.owner_uid. */
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

export type ApplicationStage =
  | "saved"
  | "drafting"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export type AssetKind = "resume" | "cover_letter" | "outreach";
export type AssetFormat = "pdf" | "docx" | "txt" | "json";

/**
 * Generated asset content. The structured output of #22's
 * resume-generation pipeline. Defined here (in shared types)
 * because the validation orchestrator (#109) reads this shape
 * BEFORE generation lands — the orchestrator + the generator
 * are co-designed against this contract.
 *
 * Each bullet carries `id` + `source_unit_ids[]`. The id lets
 * the validation layer key flag records on it (claims belong
 * to bullets); the source_unit_ids drive per-bullet
 * traceability — the validator only checks claims against
 * Units the generator says it grounded on.
 */
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

/**
 * A fact-bearing item the validator can check — same shape
 * across `summary`, each `skills` entry, and each `education`
 * entry: a stable id + the prose the user sees + the
 * `source_unit_ids` the generator grounded it on.
 *
 * The validation orchestrator (#109) iterates summary + bullets
 * + skills + education uniformly. Cursor caught a prior version
 * where `skills: string[]` and `education?: string[]` were
 * plain string arrays and bypassed validation entirely — a
 * fabricated skill or education entry could ship with
 * `validation_status: "passed"` as long as summary + bullets
 * cleared. Codex P1 round 1 caught the same gap for `summary`.
 *
 * Three named aliases below make the use-site clearer; the
 * underlying shape is the same.
 */
export interface GeneratedItem {
  id: UUID;
  text: string;
  source_unit_ids: UUID[];
}
export type GeneratedSummary = GeneratedItem;
export type GeneratedSkill = GeneratedItem;
export type GeneratedEducation = GeneratedItem;

export interface GeneratedAssetContent {
  summary: GeneratedSummary;
  experience: GeneratedExperienceSection[];
  skills: GeneratedSkill[];
  education?: GeneratedEducation[];
}

/**
 * Per-claim validation flag. Produced by the orchestrator
 * (#109) when a claim fails traceability or specificity, OR
 * when a claim passes both (status=`traced`) and the editor
 * surface shows the trace lineage on hover.
 */
export type ValidationFlagStatus = "traced" | "untraceable" | "specificity";

export interface ValidationFlag {
  id: UUID;
  asset_id: UUID;
  bullet_id: UUID;
  claim_id: UUID;
  status: ValidationFlagStatus;
  /** Set when traceability returned a Unit (status=`traced`). */
  supporting_unit_id?: UUID;
  /** Set when status=`specificity` AND deny-list matched. */
  matched_pattern?: string;
  rationale: string;
  created_at: ISOTimestamp;
}

/**
 * Asset-level validation status. The Application Editor (#24)
 * blocks export when status === `failed`. `pending` means
 * validation hasn't run yet; `stale` means the asset content
 * changed since the last run (the editor flips to stale on
 * any post-validation edit).
 */
export type ValidationStatus = "pending" | "passed" | "failed" | "stale";

export interface AssetRef {
  id: UUID;
  /** See Person.owner_uid. */
  owner_uid: UUID;
  /** Parent Application — needed for cross-tenant scope checks. */
  application_id: UUID;
  kind: AssetKind;
  format: AssetFormat;
  /** Storage path for binary formats (pdf/docx); empty for json. */
  storage_path: string;
  /**
   * Structured generated content. Populated by #22 for json-
   * format assets. Optional because pre-validation assets in
   * legacy data might not have it; in practice #22 always
   * stamps it.
   */
  generated_content?: GeneratedAssetContent;
  /**
   * Per-claim flags from the most recent validation run.
   * Replaced wholesale on each `validateAsset()` call (mirrors
   * the replace-by-(role,owner) pattern from #99). Includes
   * `status: "traced"` flags for claims that passed both checks
   * — the editor uses them for hover-trace UX.
   */
  validation_flags?: ValidationFlag[];
  validation_status: ValidationStatus;
  /** Set on validateAsset's last successful completion. */
  validated_at?: ISOTimestamp;
  created_at: ISOTimestamp;
}

export interface Application {
  id: UUID;
  /** See Person.owner_uid. */
  owner_uid: UUID;
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
  /** See Person.owner_uid. */
  owner_uid: UUID;
  person_id: UUID;
  application_id?: UUID;
  type: InteractionType;
  direction: InteractionDirection;
  summary: string;
  occurred_at: ISOTimestamp;
}
