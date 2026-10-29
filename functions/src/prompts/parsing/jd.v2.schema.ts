/**
 * jd.v2 response contract. The shape is unchanged from v1; only the
 * prompt text changed (#656). Re-exported rather than copied so the two
 * versions cannot diverge, and so a v2 eval override validates against
 * exactly the shape production enforces.
 */
export {
  JdParsingResponseV1Schema as JdParsingResponseV2Schema,
  ParsedRequirementV1Schema as ParsedRequirementV2Schema,
} from "./jd.v1.schema.js";
export type {
  JdParsingResponseV1 as JdParsingResponseV2,
  ParsedRequirementV1 as ParsedRequirementV2,
} from "./jd.v1.schema.js";
