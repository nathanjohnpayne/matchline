/**
 * traceability.v2 response contract: the shape is unchanged from v1;
 * only the prompt text changed (#485). Re-exported rather than copied
 * so the two versions cannot diverge, and so a v1 eval override still
 * validates against the right shape.
 */
export { TraceabilityResponseV1Schema as TraceabilityResponseV2Schema } from "./traceability.v1.schema.js";
export type { TraceabilityResponseV1 as TraceabilityResponseV2 } from "./traceability.v1.schema.js";
