/**
 * Per-flow trace collector for `--record` (per-flow recorder).
 *
 * `runForFixture` already holds every per-call `UsageRecord`, the
 * extracted Units and the parsed Requirements in memory, then returns
 * only summed cost and end-to-end latency. A decision rule that needs
 * per-call retries, truncations, per-stage latency or the saved Units
 * cannot be computed from that summary.
 *
 * A caller that wants the detail passes a fresh `FlowTrace` as
 * `RunForFixtureDeps.trace`; `runForFixture` fills it through the small
 * hooks below and its result object stays unchanged. Without a trace
 * every hook is a no-op, so runs without `--record` behave exactly as
 * before.
 *
 * Pure: no I/O.
 */

import type { UsageRecord } from "../../functions/src/llm/cost.ts";

/**
 * The step a call served. `embedding` is split in two because the flow
 * embeds the Units and then the Requirements under the same stage name.
 * Any stage the orchestrator adds later is recorded under its own name.
 */
export type TraceStep =
  | "extraction"
  | "unit_embedding"
  | "requirement_parsing"
  | "requirement_embedding"
  | "matching"
  | "scoring"
  | (string & {});

export interface TracedCall {
  readonly step: TraceStep;
  /**
   * True when the usage was replayed from the stage cache rather than
   * measured in this run. A replayed record keeps the ORIGINAL call's
   * latency and attempt number.
   */
  readonly replayed: boolean;
  readonly usage: UsageRecord;
}

export interface FlowTrace {
  readonly calls: TracedCall[];
  /** Units exactly as extraction returned them (before embedding). */
  units?: readonly unknown[];
  /** Requirements exactly as parsing returned them (before embedding). */
  requirements?: readonly unknown[];
  /** Whether each step was served from the stage cache. */
  readonly stepCacheHits: Record<string, boolean>;
  /**
   * The step running now. Set when a stage starts, cleared when it
   * returns, and set to `matching` / `scoring` by the orchestrator before
   * those non-LLM steps, so a throw is never charged to the last stage
   * that happened to start.
   */
  currentStep?: TraceStep;
  failedStep?: TraceStep;
  /** Last `failures[].kind` when the error carried one, else the error's name. */
  errorKind?: string;
  errorName?: string;
  /** The stage's `failures` array, as thrown (ExtractionError / JdParsingError). */
  failures?: readonly unknown[];
  /**
   * Every failed attempt a stage reported through its per-attempt hook,
   * recovered or not (#656): step, attempt, kind and Zod issue codes and
   * paths only. Today only JD parsing reports here.
   */
  readonly attemptFailures?: TracedAttemptFailure[];
}

/** One failed attempt as a stage's hook reported it. No message or model output. */
export interface TracedAttemptFailure {
  readonly step: TraceStep;
  readonly attempt: number;
  readonly kind: string;
  readonly issues?: readonly { readonly code: string; readonly path: readonly (string | number)[] }[];
}

export function newFlowTrace(): FlowTrace {
  return { calls: [], stepCacheHits: {}, attemptFailures: [] };
}

/** Name the step a stage call serves, and remember it as the current step. */
export function traceStepFor(trace: FlowTrace | undefined, stage: string): TraceStep {
  let step: TraceStep = stage;
  if (stage === "embedding") {
    step = trace?.requirements === undefined ? "unit_embedding" : "requirement_embedding";
  }
  if (trace !== undefined) trace.currentStep = step;
  return step;
}

/** A stage returned: nothing is running until the next step starts. */
export function traceStepDone(trace: FlowTrace | undefined): void {
  if (trace !== undefined) trace.currentStep = undefined;
}

/** Name a non-LLM step (matching, scoring) the flow is entering. */
export function traceEnterStep(trace: FlowTrace | undefined, step: TraceStep): void {
  if (trace !== undefined) trace.currentStep = step;
}

export function traceCall(
  trace: FlowTrace | undefined,
  step: TraceStep,
  usage: UsageRecord,
  replayed: boolean,
): void {
  trace?.calls.push({ step, replayed, usage });
}

export function traceCacheOutcome(trace: FlowTrace | undefined, step: TraceStep, hit: boolean): void {
  if (trace !== undefined) trace.stepCacheHits[step] = hit;
}

/** Keep the value a stage returned when it is the Units or the Requirements. */
export function traceValue(trace: FlowTrace | undefined, stage: string, value: unknown): void {
  if (trace === undefined || !Array.isArray(value)) return;
  if (stage === "extraction") trace.units = value;
  else if (stage === "requirement_parsing") trace.requirements = value;
}

/**
 * Keep one failed attempt a stage reported (#656). Only the attempt,
 * kind and each issue's code and path are copied, whatever else the
 * caller's object carries.
 */
export function traceAttemptFailure(
  trace: FlowTrace | undefined,
  step: TraceStep,
  failure: {
    readonly attempt: number;
    readonly kind: string;
    readonly issues?: readonly { readonly code: string; readonly path: readonly (string | number)[] }[];
  },
): void {
  if (trace?.attemptFailures === undefined) return;
  trace.attemptFailures.push({
    step,
    attempt: failure.attempt,
    kind: failure.kind,
    ...(failure.issues !== undefined &&
      failure.issues.length > 0 && {
        issues: failure.issues.map((i) => ({ code: i.code, path: [...i.path] })),
      }),
  });
}

/** Record why the flow failed. Never throws, whatever was thrown. */
export function traceFailure(trace: FlowTrace | undefined, err: unknown): void {
  if (trace === undefined) return;
  if (trace.currentStep !== undefined) trace.failedStep = trace.currentStep;
  const name = err instanceof Error ? err.name : undefined;
  if (name !== undefined) trace.errorName = name;
  const failures =
    typeof err === "object" && err !== null ? (err as { failures?: unknown }).failures : undefined;
  if (Array.isArray(failures)) {
    trace.failures = failures;
    const last = failures.at(-1) as { kind?: unknown } | undefined;
    if (typeof last?.kind === "string") {
      trace.errorKind = last.kind;
      return;
    }
  }
  trace.errorKind = name ?? "error";
}
