/**
 * resume.v2 response contract. The shape is unchanged from v1; only the
 * prompt text changed (#485). Re-exported rather than copied so the two
 * versions cannot diverge, and so a v1 eval override still validates
 * against the right shape.
 */
export {
  GenerationItemV1Schema as GenerationItemV2Schema,
  ResumeGenerationResponseV1Schema as ResumeGenerationResponseV2Schema,
} from "./resume.v1.schema.js";
export type {
  GenerationItemV1 as GenerationItemV2,
  ResumeGenerationResponseV1 as ResumeGenerationResponseV2,
} from "./resume.v1.schema.js";
