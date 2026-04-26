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
 * A fact-bearing item the validator can check — same shape
 * across `summary`, each `skills` entry, each `education`
 * entry, and each `bullets` entry: a stable id + the prose
 * the user sees + the `source_unit_ids` the generator
 * grounded it on.
 *
 * The validation orchestrator (#109) iterates summary +
 * bullets + skills + education uniformly. Cursor caught
 * prior versions that bypassed validation: `summary` as a
 * plain string (Codex P1 round 1 on #117), `skills` /
 * `education` as plain string arrays (cursor round 2 on
 * #117), and experience-section `title` / `company` as
 * ungrounded metadata that the data model couldn't validate
 * (cursor rounds 3 + 4 on #122). The current shape is
 * "everything fact-bearing is a GeneratedItem" — no
 * structural escape hatches.
 *
 * Four named aliases below make the use-site clearer; the
 * underlying shape is the same.
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

/**
 * Generated resume content. V1 is intentionally flat —
 * `bullets[]` is a single list, NOT grouped by experience
 * section. Section grouping (employer + title + date_range
 * headers) lands in V2/Phase 2 once `ExperienceUnit` gains
 * structured `employer`/`title` fields the validator can
 * cross-check. cursor's CHANGES_REQUESTED rounds 3 + 4 on
 * #122 surfaced the prior over-promise: schema requiring
 * ungrounded section metadata that the data model couldn't
 * validate.
 *
 * The Application Editor (#24) renders the bullets as a
 * single chronological list for V1; Phase 2 introduces
 * section grouping when there's an honest grounding source.
 */
export interface GeneratedAssetContent {
  summary: GeneratedSummary;
  bullets: GeneratedBullet[];
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
