/**
 * Structured validation-stage failures. Mirrors the shape of
 * JdParsingError + ExtractionError — retry budget exhausted with
 * schema or tool_use errors; transport failures also bubble here.
 *
 * One error class per concrete failure surface so callers can
 * disambiguate (the validation orchestrator will catch each
 * separately and write distinct flag records).
 */

export interface ValidationAttemptFailure {
  readonly attempt: number;
  readonly kind: "no_tool_use" | "schema_error" | "transport_error";
  readonly message: string;
  readonly zodIssues?: readonly unknown[];
}

export class ClaimExtractionError extends Error {
  readonly failures: readonly ValidationAttemptFailure[];

  constructor(
    message: string,
    failures: readonly ValidationAttemptFailure[],
  ) {
    super(message);
    this.name = "ClaimExtractionError";
    this.failures = failures;
  }
}

export class TraceabilityCheckError extends Error {
  readonly failures: readonly ValidationAttemptFailure[];

  constructor(
    message: string,
    failures: readonly ValidationAttemptFailure[],
  ) {
    super(message);
    this.name = "TraceabilityCheckError";
    this.failures = failures;
  }
}
