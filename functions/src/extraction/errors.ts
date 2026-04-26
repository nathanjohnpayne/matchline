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
  readonly kind:
    | "no_tool_use"
    | "schema_error"
    | "transport_error"
    /**
     * Anthropic returned `stop_reason: "max_tokens"` — the model
     * hit the output-token budget mid-tool-call and the
     * `tool_use.input` came back truncated (typically `{}`). Without
     * this kind, the downstream Zod parse fails with a misleading
     * "units: required" error that obscures the real cause and
     * burns the retry budget on a problem retries can't fix.
     */
    | "max_tokens_exceeded";
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
