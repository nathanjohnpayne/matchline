/**
 * Structured generation-stage failures. Mirrors the shape of
 * JdParsingError + ClaimExtractionError + others — retry budget
 * exhausted with schema or tool_use errors; transport failures
 * also bubble here.
 *
 * `value_error` is unique to generation: when the LLM emits a
 * `source_unit_ids` value that doesn't reference any Unit the
 * pipeline LOADED, the value is a fabrication the schema can't
 * catch (Zod only validates shape, not value-set membership).
 * The pipeline cross-validates and retries on this kind of
 * error too.
 */

export interface GenerationAttemptFailure {
  readonly attempt: number;
  readonly kind:
    | "no_tool_use"
    | "schema_error"
    | "transport_error"
    | "value_error";
  readonly message: string;
  readonly zodIssues?: readonly unknown[];
}

export class GenerationError extends Error {
  readonly failures: readonly GenerationAttemptFailure[];

  constructor(
    message: string,
    failures: readonly GenerationAttemptFailure[],
  ) {
    super(message);
    this.name = "GenerationError";
    this.failures = failures;
  }
}

/**
 * Thrown when generation is invoked on an Application with no
 * approved Experience Units. A resume can't be grounded on an
 * empty input set; the callable maps this to
 * `failed-precondition` so the editor surface can prompt the
 * user to approve Units before retrying.
 */
export class GenerationNoApprovedUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationNoApprovedUnitsError";
  }
}
