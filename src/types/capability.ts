/**
 * Frontend view of the capability contracts.
 *
 * The Firestore document shapes are **declared once** in
 * `functions/src/types/capability.ts` and re-exported here, so the two
 * packages cannot drift. They previously did: each copy documented
 * invariants the other could not see. See issue #443.
 *
 * The re-export is type-only, so it is erased before bundling — no
 * functions code reaches the client. The import direction is
 * deliberate and only works this way round: the functions package
 * sets `rootDir: "src"`, so it cannot import from here without
 * breaking its `main: lib/index.js` entry point, whereas this package
 * has no `rootDir` and runs `noEmit`.
 *
 * `UUID` / `ISOTimestamp` / `ISODate` are NOT re-exported: on the app
 * side those belong to `./crm.ts`, and re-exporting them here would
 * collide in `src/types/index.ts`, which star-exports both modules.
 *
 * Types below the re-export are app-only view models. They never
 * describe a Firestore document, so they stay local.
 */

export type {
  DateRange,
  EvidenceType,
  ExperienceUnit,
  JobRequirementUnit,
  Metric,
  MetricConfidence,
  MetricDirection,
  RequirementCategory,
  RequirementPriority,
  RequirementSource,
  ScoreComponents,
  SeniorityLevel,
  UnitMatch,
  UnitSourceType,
  UnitType,
} from "../../functions/src/types/capability.ts";

import type { UUID } from "./crm.ts";

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
