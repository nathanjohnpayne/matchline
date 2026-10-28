/**
 * Record shapes for `--record` (per-flow recorder) and the pure
 * functions that build and read them.
 *
 * One `FlowRecord` per (variant, cell, sample) flow, one JSON line each
 * in `<dir>/flows.jsonl`; one `InvocationRecord` per run in
 * `<dir>/invocation.json`. `analyze.ts` reads them back.
 *
 * ## Derived per-call fields
 *
 * The pipeline does not expose a stop reason per call: extraction and
 * JD parsing record usage before they inspect `stop_reason`, and
 * `UsageRecord` has no field for it. Changing that is out of scope for
 * the harness, so each recorded call carries flags derived from what is
 * recorded:
 *
 * - `truncated`: `maxTokens` is set and `outputTokens >= maxTokens`, or
 *   the stage's thrown `failures` name a `max_tokens_exceeded` at that
 *   attempt.
 * - `retry`: `attempt > 0`. A transport error records no usage but still
 *   advances `attempt`, so the call after it counts as a retry.
 * - `refusal`: the stage's thrown `failures` name a `refusal` at that
 *   attempt. Observable only when the flow failed, since `failures` is
 *   thrown only on exhaustion or refusal.
 *
 * Pure: no I/O.
 */

import { z } from "zod";

import type { UsageRecord } from "../../functions/src/llm/cost.ts";

import type { FlowTrace, TraceStep } from "./flowTrace.ts";
import type { RunForFixtureResult } from "./runForFixture.ts";

export const FLOW_RECORD_SCHEMA_VERSION = 1;

/** What one LLM stage was asked to run with, captured at flow time. */
export interface StageConfig {
  readonly provider: string;
  /** Requested model (override or config.ts default). */
  readonly model: string;
  /** Effort override in force for the stage, or null when none was set. */
  readonly effortRequested: string | null;
  /**
   * Effort the request carried: the override, else the model profile's
   * default. Null when nothing is sent, which includes every subscription
   * CLI token source (they drop `output_config`).
   */
  readonly effortSent: string | null;
  /** Resolved prompt version, e.g. "v1". */
  readonly promptVersion: string;
  /** Version plus a hash of the prompt text (`promptFingerprint`). */
  readonly promptFingerprint: string;
}

export type StageConfigs = Readonly<Record<string, StageConfig>>;

export interface RecordedCall extends UsageRecord {
  readonly step: TraceStep;
  readonly replayed: boolean;
  readonly truncated: boolean;
  readonly retry: boolean;
  readonly refusal: boolean;
}

export interface FlowError {
  /** Last `failures[].kind` when the stage threw one, else the error name. */
  readonly kind: string;
  readonly name: string | null;
  readonly message: string;
  /** Step that was running when the flow threw. */
  readonly step: string | null;
}

export interface FlowRecord {
  readonly schemaVersion: number;
  readonly invocationId: string;
  /** Sweep variant label, or "default" outside a sweep. */
  readonly variant: string;
  /**
   * Token source the flow ran under: the variant's own when it set one,
   * else the command's. Optional only so records written before it
   * existed still parse.
   */
  readonly tokenSource?: string;
  readonly stages: StageConfigs;
  readonly embeddingModel: string;
  readonly resumeId: string;
  readonly jdId: string;
  /** `<resumeId>__<jdId>`, the labeled cell. */
  readonly cell: string;
  /** 0-based sample index within (variant, cell). */
  readonly sampleIndex: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly error: FlowError | null;
  /** Null when the flow failed (the result reports 0 there). */
  readonly extractionAccuracy: number | null;
  readonly matchAccuracy: number | null;
  /** From the saved Units/Requirements, so known even when a later stage failed. */
  readonly extractedUnitCount: number | null;
  readonly parsedRequirementCount: number | null;
  readonly parsedMustHaveCount: number | null;
  readonly matchCount: number | null;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly stepCacheHits: Readonly<Record<string, boolean>>;
  readonly calls: readonly RecordedCall[];
  /** The failing stage's `failures` array, as thrown; null when none. */
  readonly failures: readonly unknown[] | null;
  /** Units exactly as extraction returned them; null when extraction did not return. */
  readonly units: readonly Record<string, unknown>[] | null;
  /** Requirements exactly as parsing returned them; null when parsing did not return. */
  readonly requirements: readonly Record<string, unknown>[] | null;
  readonly costUsd: number;
  readonly modeledCostUsd: number;
}

export interface VariantDescription {
  readonly label: string;
  readonly tokenSource: string;
  /** What the command line asked for (explicit overrides only). */
  readonly requested: {
    readonly models: Readonly<Record<string, unknown>>;
    readonly efforts: Readonly<Record<string, string>>;
    readonly promptVersions: Readonly<Record<string, string>>;
  };
  /** Every sweepable knob as it resolved while the variant ran; set when the run finishes. */
  readonly resolved?: {
    readonly models: Readonly<Record<string, unknown>>;
    readonly efforts: Readonly<Record<string, string>>;
    readonly promptVersions: Readonly<Record<string, string>>;
  };
  /** Outside a sweep: the stage configuration captured when the run started. */
  readonly stages?: StageConfigs;
}

export interface InvocationRecord {
  readonly schemaVersion: number;
  readonly invocationId: string;
  readonly headSha: string | null;
  /** True when the working tree had uncommitted changes; null when unknown. */
  readonly dirty: boolean | null;
  readonly argv: readonly string[];
  readonly tokenSource: string;
  readonly cacheMode: string;
  readonly samples: number;
  readonly mode: string;
  readonly promptOverrides: Readonly<Record<string, string>>;
  readonly variants: readonly VariantDescription[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly flowCount: number;
  /**
   * Set when a write to the record directory failed mid-run: recording
   * stopped there and the run went on unrecorded.
   */
  readonly recordingError?: string;
}

export interface FlowContext {
  readonly invocationId: string;
  readonly variant: string;
  readonly tokenSource?: string;
  readonly stages: StageConfigs;
  readonly embeddingModel: string;
  readonly resumeId: string;
  readonly jdId: string;
  readonly sampleIndex: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export function cellId(resumeId: string, jdId: string): string {
  return `${resumeId}__${jdId}`;
}

interface FailureEntry {
  readonly attempt?: unknown;
  readonly kind?: unknown;
}

function failureKindsAt(
  failures: readonly unknown[] | undefined,
  attempt: number | undefined,
): Set<string> {
  const kinds = new Set<string>();
  if (failures === undefined || attempt === undefined) return kinds;
  for (const f of failures as readonly FailureEntry[]) {
    if (f?.attempt === attempt && typeof f.kind === "string") kinds.add(f.kind);
  }
  return kinds;
}

/** Add the derived `truncated` / `retry` / `refusal` flags to one traced call. */
export function deriveCall(
  call: FlowTrace["calls"][number],
  failedStep: string | undefined,
  failures: readonly unknown[] | undefined,
): RecordedCall {
  const { usage } = call;
  const kinds =
    !call.replayed && failedStep === call.step ? failureKindsAt(failures, usage.attempt) : new Set<string>();
  return {
    step: call.step,
    replayed: call.replayed,
    ...usage,
    truncated:
      (usage.maxTokens !== undefined && usage.outputTokens >= usage.maxTokens) ||
      kinds.has("max_tokens_exceeded"),
    retry: (usage.attempt ?? 0) > 0,
    refusal: kinds.has("refusal"),
  };
}

/** Drop an embedding vector if a stage ever returns one; everything else is kept. */
function withoutEmbedding(item: unknown): Record<string, unknown> {
  if (typeof item !== "object" || item === null) return { value: item };
  const { embedding: _embedding, ...rest } = item as Record<string, unknown>;
  return rest;
}

/** Build the JSON line for one flow from its context, result and trace. */
export function buildFlowRecord(
  ctx: FlowContext,
  result: RunForFixtureResult,
  trace: FlowTrace,
): FlowRecord {
  const units = trace.units?.map(withoutEmbedding) ?? null;
  const requirements = trace.requirements?.map(withoutEmbedding) ?? null;
  return {
    schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
    invocationId: ctx.invocationId,
    variant: ctx.variant,
    ...(ctx.tokenSource !== undefined && { tokenSource: ctx.tokenSource }),
    stages: ctx.stages,
    embeddingModel: ctx.embeddingModel,
    resumeId: ctx.resumeId,
    jdId: ctx.jdId,
    cell: cellId(ctx.resumeId, ctx.jdId),
    sampleIndex: ctx.sampleIndex,
    startedAt: ctx.startedAt,
    finishedAt: ctx.finishedAt,
    latencyMs: result.latencyMs,
    ok: result.ok,
    error: result.ok
      ? null
      : {
          kind: trace.errorKind ?? "error",
          name: trace.errorName ?? null,
          message: result.error ?? "",
          step: trace.failedStep ?? null,
        },
    extractionAccuracy: result.ok ? result.extractionAccuracy : null,
    matchAccuracy: result.ok ? result.matchAccuracy : null,
    extractedUnitCount: units?.length ?? null,
    parsedRequirementCount: requirements?.length ?? null,
    parsedMustHaveCount: requirements === null ? null : requirements.filter((r) => r.must_have === true).length,
    matchCount: result.ok ? result.matchCount : null,
    cacheHits: result.cacheHits,
    cacheMisses: result.cacheMisses,
    stepCacheHits: { ...trace.stepCacheHits },
    calls: trace.calls.map((c) => deriveCall(c, trace.failedStep, trace.failures)),
    failures: trace.failures ?? null,
    units,
    requirements,
    costUsd: result.costUsd,
    modeledCostUsd: result.modeledCostUsd,
  };
}

const CallSchema = z
  .object({
    step: z.string(),
    replayed: z.boolean(),
    stage: z.string(),
    model: z.string(),
    provider: z.enum(["anthropic", "openai"]),
    latencyMs: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    truncated: z.boolean(),
    retry: z.boolean(),
    refusal: z.boolean(),
  })
  .passthrough();

const FlowSchema = z
  .object({
    schemaVersion: z.literal(FLOW_RECORD_SCHEMA_VERSION),
    invocationId: z.string(),
    variant: z.string().min(1),
    stages: z.record(z.string(), z.unknown()),
    resumeId: z.string().min(1),
    jdId: z.string().min(1),
    cell: z.string().min(1),
    sampleIndex: z.number().int().nonnegative(),
    ok: z.boolean(),
    error: z.object({ kind: z.string(), message: z.string() }).passthrough().nullable(),
    extractionAccuracy: z.number().nullable(),
    matchAccuracy: z.number().nullable(),
    extractedUnitCount: z.number().nullable(),
    parsedRequirementCount: z.number().nullable(),
    parsedMustHaveCount: z.number().nullable(),
    calls: z.array(CallSchema),
    units: z.array(z.record(z.string(), z.unknown())).nullable(),
    requirements: z.array(z.record(z.string(), z.unknown())).nullable(),
    costUsd: z.number(),
    modeledCostUsd: z.number(),
  })
  .passthrough();

/**
 * Parse a `flows.jsonl` file. Blank lines are skipped; a malformed line
 * throws with `<source>:<line>` so a damaged record is never read as
 * missing data.
 */
export function parseFlowsJsonl(text: string, source: string): FlowRecord[] {
  const out: FlowRecord[] = [];
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source}:${i + 1}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const parsed = FlowSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${source}:${i + 1}: not a flow record (${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"})`,
      );
    }
    out.push(parsed.data as unknown as FlowRecord);
  }
  return out;
}
