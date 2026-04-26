/**
 * Structured JD-parsing failure. Mirrors ExtractionError — retry
 * budget exhausted with schema or tool_use errors; transport
 * failures also bubble here.
 */

export interface JdParsingAttemptFailure {
  readonly attempt: number;
  readonly kind:
    | "no_tool_use"
    | "schema_error"
    | "transport_error"
    /**
     * Anthropic returned `stop_reason: "max_tokens"` — the model
     * hit the output-token budget mid-tool-call and the
     * `tool_use.input` came back truncated. Mirrors the same kind
     * on `ExtractionAttemptFailure`; see extraction/errors.ts.
     */
    | "max_tokens_exceeded";
  readonly message: string;
  readonly zodIssues?: readonly unknown[];
}

export class JdParsingError extends Error {
  readonly failures: readonly JdParsingAttemptFailure[];

  constructor(
    message: string,
    failures: readonly JdParsingAttemptFailure[],
  ) {
    super(message);
    this.name = "JdParsingError";
    this.failures = failures;
  }
}
