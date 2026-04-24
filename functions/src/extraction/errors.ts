/**
 * Structured extraction failure. Thrown after the retry budget is
 * exhausted with schema-validation or tool-use errors; also thrown on
 * transport failures the SDK can't recover from.
 *
 * The caller (a Firebase callable in `functions/src/callables/`) maps
 * this to a `needs manual review` signal per
 * `specs/matchline.md § Execution targets / Reliability`.
 */

export interface ExtractionAttemptFailure {
  readonly attempt: number;
  readonly kind: "no_tool_use" | "schema_error" | "transport_error";
  readonly message: string;
  /** Populated for schema_error; Zod's formatted issues. */
  readonly zodIssues?: readonly unknown[];
}

export class ExtractionError extends Error {
  readonly failures: readonly ExtractionAttemptFailure[];

  constructor(
    message: string,
    failures: readonly ExtractionAttemptFailure[],
  ) {
    super(message);
    this.name = "ExtractionError";
    this.failures = failures;
  }
}
