/**
 * Per-attempt instrumentation for the subtask suites (#488).
 *
 * Every model call the suites make goes through `instrumentClient`,
 * which wraps the injected client's `messages.create` and records one
 * `CallRecord` per attempt: the settings exactly as sent on the wire,
 * the served model, the outcome class, usage and modeled cost. Each
 * call to a production module (one `extractClaims`, one
 * `checkTraceability`, ...) is an `Invocation`, finished with an
 * `InvocationRecord` that carries the module's own verdict on success
 * or its `failures[].kind` list on a hard failure.
 *
 * Usage records the modules emit are collected in memory, stamped with
 * the run id, and never written: production `recordUsage` is not
 * reachable because every call site injects `record`. They are joined
 * to the wire records afterwards (settings cross-check) as a runtime
 * proof that a module records the `max_tokens` and effort it sent.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";

import type { Stage } from "../../../functions/src/llm/config.ts";
import { anthropicUsageFields, priceUsage, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import { CallPoolAborted } from "../../../functions/src/validation/callPool.ts";

import { describeError } from "../runForFixture.ts";
import { defaultPromptVersion } from "../sweepScope.ts";
import { assertModelMatches, type TokenSourceKind } from "../tokenSource.ts";

import { BudgetReachedError, type BudgetLedger, type Reservation } from "./budget.ts";
import { replayKey, type ReplayStore } from "./replay.ts";

export type CallOutcome =
  | "tool_use"
  | "schema_error"
  | "invented_id"
  | "no_tool_use"
  | "refusal"
  | "transport_error"
  | "aborted"
  | "budget_reached"
  | "unclassified";

export type CallPass = "isolated" | "whole_asset" | "generation" | "downstream";
export type SubtaskSuite = "validation" | "generation";

export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface CallRecord {
  readonly runId: string;
  readonly attemptId: string;
  readonly suite: SubtaskSuite;
  readonly pass: CallPass;
  readonly variant: string;
  readonly caseId: string;
  readonly repeat: number;
  readonly stage: Stage;
  readonly invocationId: string;
  readonly attemptIndex: number;
  readonly requestedModel: string;
  readonly servedModel: string | null;
  readonly servedModelStatus: "ok" | "missing" | "mismatch" | "cli-asserted";
  readonly maxTokens: number;
  readonly toolChoice: "forced" | "auto";
  readonly effort: string | null;
  readonly requestKey: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly outcome: CallOutcome;
  readonly usage: CallUsage | null;
  readonly replayed: boolean;
  readonly replayedFromRunId: string | null;
  readonly tokenFidelity: "metered" | "estimated";
  readonly modeledUsd: number | null;
}

/**
 * Failure kinds that say the invocation never got to finish, rather than
 * that the model failed: `budget_reached` (the run stopped) and
 * `cancelled` (the validation call pool aborted it after ANOTHER call
 * failed). Metrics leave such invocations out of their denominators.
 */
export const STOPPED_KINDS: readonly string[] = Object.freeze(["budget_reached", "cancelled"]);

/** The invocation stopped before it could finish (see `STOPPED_KINDS`). */
export function stoppedKind(i: Pick<InvocationRecord, "ok" | "failureKinds">): "budget_reached" | "cancelled" | null {
  if (i.ok || i.failureKinds.length !== 1) return null;
  const k = i.failureKinds[0]!;
  return k === "budget_reached" || k === "cancelled" ? k : null;
}

export interface InvocationRecord {
  readonly invocationId: string;
  readonly stage: Stage;
  readonly pass: CallPass;
  readonly variant: string;
  readonly caseId: string;
  readonly repeat: number;
  readonly ok: boolean;
  /** Requests sent (or replayed). A refused pre-request budget check is not an attempt. */
  readonly attempts: number;
  readonly failureKinds: readonly string[];
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly error?: string;
}

/** Shared state of one `eval:subtasks` run. */
export interface RunCtx {
  readonly runId: string;
  readonly suite: SubtaskSuite;
  readonly tokenSource: TokenSourceKind;
  readonly cliAdapterVersion: string | null;
  readonly rawClient: Anthropic;
  readonly store: ReplayStore;
  readonly ledger: BudgetLedger;
  readonly runAbort: AbortController;
  readonly clock: () => number;
  readonly nextId: () => string;
  readonly calls: CallRecord[];
  readonly invocations: InvocationRecord[];
  /** Variants whose usage records disagreed with the wire (settings cross-check). */
  readonly settingsMismatches: { variant: string; detail: string }[];
}

export interface InvocationMeta {
  readonly variant: string;
  readonly caseId: string;
  readonly repeat: number;
  readonly stage: Stage;
  readonly pass: CallPass;
  /** For generation: the Unit ids the model may cite; anything else is `invented_id`. */
  readonly eligibleUnitIds?: ReadonlySet<string>;
}

export interface Invocation {
  readonly id: string;
  readonly client: Anthropic;
  readonly record: (u: UsageRecord) => Promise<number>;
  readonly signal: AbortSignal;
  readonly usage: UsageRecord[];
  /**
   * Close the invocation. `poolSignal` is the validation call pool's
   * signal, when the module ran inside `validateAsset`: a failure that
   * comes from that pool aborting (another call failed first) is
   * recorded as `cancelled`, not as this invocation's own failure.
   */
  finish(ok: boolean, err?: unknown, opts?: { readonly poolSignal?: AbortSignal }): InvocationRecord;
}

/** The prompt each stage loads, for outcome classification. */
const STAGE_PROMPT: Partial<Record<Stage, string>> = {
  claim_extraction: "validation/claimExtraction",
  traceability: "validation/traceability",
  specificity: "validation/specificity",
  generation: "generation/resume",
};

export interface Classifier {
  readonly safeParse: (input: unknown) => { success: boolean; data?: unknown };
}

const PROMPTS_ROOT = new URL("../../../functions/src/prompts/", import.meta.url);

/** Where the schema for `promptKey@vN` lives, by the loader's convention. */
export function classifierSchemaPath(classifierKey: string): string | null {
  const m = /^([a-z]+)\/([A-Za-z]+)@(v[1-9][0-9]*)$/.exec(classifierKey);
  if (m === null) return null;
  return fileURLToPath(new URL(`${m[1]}/${m[2]}.${m[3]}.schema.ts`, PROMPTS_ROOT));
}

const classifierCache = new Map<string, Promise<Classifier | null>>();

/**
 * The tool-input schema for `promptKey@vN`: the module's single
 * `*ResponseV<N>Schema` export, imported from
 * `functions/src/prompts/<stage>/<name>.vN.schema.ts` (the convention
 * `loadPromptWithSchema` uses). Loaded once and cached; null when the
 * file is missing or does not export exactly one such schema. Keyed on
 * the version whose schema the module imports (the `PROMPT_CONFIG`
 * default; see `defaultPromptVersion`), never a prompt override: an
 * override only runs once `assertPromptSchemasCompatible` has shown
 * that it enforces the same schema. Nothing is listed by hand, so a
 * default that moves to a new version with a schema file needs no edit
 * here.
 */
export function loadClassifier(classifierKey: string): Promise<Classifier | null> {
  const cached = classifierCache.get(classifierKey);
  if (cached !== undefined) return cached;
  const loading = (async (): Promise<Classifier | null> => {
    const path = classifierSchemaPath(classifierKey);
    if (path === null || !existsSync(path)) return null;
    const version = classifierKey.slice(classifierKey.lastIndexOf("@v") + 2);
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    const exportName = new RegExp(`ResponseV${version}Schema$`);
    const found = Object.entries(mod).filter(
      ([name, v]) => exportName.test(name) && typeof (v as Partial<Classifier> | null)?.safeParse === "function",
    );
    return found.length === 1 ? (found[0]![1] as Classifier) : null;
  })();
  classifierCache.set(classifierKey, loading);
  return loading;
}

/** `promptKey@version` of the schema the stage's module enforces. */
export function classifierKeyFor(stage: Stage): string | null {
  const key = STAGE_PROMPT[stage];
  if (key === undefined) return null;
  return `${key}@${defaultPromptVersion(key)}`;
}

/**
 * `promptKey@version` keys whose enforced schema has no loadable
 * classifier (refused before a run). Also warms the cache, so the run
 * classifies every attempt from schemas loaded at pre-flight.
 */
export async function missingClassifiers(promptKeys: readonly string[]): Promise<string[]> {
  const keys = promptKeys.map((k) => `${k}@${defaultPromptVersion(k)}`);
  const loaded = await Promise.all(keys.map((k) => loadClassifier(k)));
  return keys.filter((_, i) => loaded[i] === null);
}

function citedIds(data: unknown): string[] {
  const d = data as { summary?: { source_unit_ids?: string[] }; bullets?: { source_unit_ids?: string[] }[]; skills?: { source_unit_ids?: string[] }[]; education?: { source_unit_ids?: string[] }[] };
  const items = [d.summary, ...(d.bullets ?? []), ...(d.skills ?? []), ...(d.education ?? [])];
  return items.flatMap((i) => i?.source_unit_ids ?? []);
}

export function classifyMessage(
  message: Anthropic.Messages.Message,
  classifier: Classifier | null,
  eligibleUnitIds?: ReadonlySet<string>,
): CallOutcome {
  if (message.stop_reason === "refusal") return "refusal";
  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (toolUse === undefined || toolUse.type !== "tool_use") return "no_tool_use";
  if (classifier === null) return "unclassified";
  const parsed = classifier.safeParse(toolUse.input);
  if (!parsed.success) return "schema_error";
  if (eligibleUnitIds !== undefined && citedIds(parsed.data).some((id) => !eligibleUnitIds.has(id))) {
    return "invented_id";
  }
  return "tool_use";
}

export function servedModelStatus(
  tokenSource: TokenSourceKind,
  requested: string,
  served: string | undefined | null,
): CallRecord["servedModelStatus"] {
  if (tokenSource !== "api") return "cli-asserted";
  if (typeof served !== "string" || served.length === 0) return "missing";
  try {
    assertModelMatches(requested, [served]);
    return "ok";
  } catch {
    return "mismatch";
  }
}

function usageOf(message: Anthropic.Messages.Message): CallUsage {
  return {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
  };
}

/** Modeled cost of one response, or null when no rate prices it. */
export function modeledCost(requested: string, message: Anthropic.Messages.Message): number | null {
  try {
    return priceUsage({
      stage: "eval",
      provider: "anthropic",
      model: requested,
      latencyMs: 0,
      ...anthropicUsageFields(message),
    }).costUsd;
  } catch {
    return null;
  }
}

interface WireBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly tool_choice?: { readonly type: string };
  readonly output_config?: { readonly effort?: string };
  readonly system?: unknown;
  readonly messages: unknown;
  readonly tools?: unknown;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError");
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || isAbortError(err);
}

/**
 * Open one invocation of a production module. The returned client is
 * instrumented; `record` collects the module's usage records; `signal`
 * is the run-level abort signal, to pass as the module's `ctx.signal`.
 */
export function startInvocation(ctx: RunCtx, meta: InvocationMeta): Invocation {
  const id = `${ctx.runId}/${meta.variant}/${meta.caseId}/r${meta.repeat}/${meta.stage}/i${ctx.nextId()}`;
  const startedAtMs = ctx.clock();
  const usage: UsageRecord[] = [];
  const myCalls: CallRecord[] = [];
  let attemptIndex = 0;
  const runSignal = ctx.runAbort.signal;

  const create = async (body: WireBody, opts?: { signal?: AbortSignal; timeout?: number }): Promise<Anthropic.Messages.Message> => {
    const index = attemptIndex++;
    const started = ctx.clock();
    const key = replayKey({ tokenSource: ctx.tokenSource, cliAdapterVersion: ctx.cliAdapterVersion, repeat: meta.repeat, body });
    const base = {
      runId: ctx.runId,
      attemptId: `${id}/a${index}`,
      suite: ctx.suite,
      pass: meta.pass,
      variant: meta.variant,
      caseId: meta.caseId,
      repeat: meta.repeat,
      stage: meta.stage,
      invocationId: id,
      attemptIndex: index,
      requestedModel: body.model,
      maxTokens: body.max_tokens,
      toolChoice: body.tool_choice?.type === "tool" ? ("forced" as const) : ("auto" as const),
      effort: body.output_config?.effort ?? null,
      requestKey: key,
      tokenFidelity: ctx.tokenSource === "api" ? ("metered" as const) : ("estimated" as const),
    };
    const push = (rest: Omit<CallRecord, keyof typeof base>): void => {
      const rec: CallRecord = { ...base, ...rest };
      ctx.calls.push(rec);
      myCalls.push(rec);
    };
    const failed = (outcome: CallOutcome): Omit<CallRecord, keyof typeof base> => ({
      servedModel: null,
      servedModelStatus: ctx.tokenSource === "api" ? "missing" : "cli-asserted",
      startedAtMs: started,
      endedAtMs: ctx.clock(),
      outcome,
      usage: null,
      replayed: false,
      replayedFromRunId: null,
      modeledUsd: null,
    });

    if (runSignal.aborted) {
      push(failed("budget_reached"));
      throw new BudgetReachedError();
    }

    const stored = ctx.store.get(meta.stage, key);
    let message: Anthropic.Messages.Message;
    let replayedFrom: string | null = null;
    let reservation: Reservation | null = null;
    if (stored !== null) {
      message = stored.message;
      replayedFrom = stored.producedByRunId;
    } else {
      try {
        reservation = ctx.ledger.reserve(body);
      } catch (err) {
        push(failed("budget_reached"));
        throw err;
      }
      const signals = [opts?.signal, runSignal].filter((s): s is AbortSignal => s !== undefined);
      try {
        message = await ctx.rawClient.messages.create(
          body as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
          { ...opts, signal: AbortSignal.any(signals) },
        );
      } catch (err) {
        // No response, no spend: free this request's hold on the budget.
        ctx.ledger.release(reservation);
        push(
          failed(
            err instanceof BudgetReachedError
              ? "budget_reached"
              : isAbort(err, opts?.signal) || runSignal.aborted
                ? "aborted"
                : "transport_error",
          ),
        );
        throw err;
      }
    }

    const ended = ctx.clock();
    const stageKey = classifierKeyFor(meta.stage);
    const classifier = stageKey === null ? null : await loadClassifier(stageKey);
    const cost = modeledCost(body.model, message);
    if (replayedFrom === null) {
      // An unpriceable response (cost null) settles at its worst case.
      ctx.ledger.settle(reservation!, cost);
      ctx.store.put(meta.stage, key, {
        message,
        producedByRunId: ctx.runId,
        producedAt: new Date().toISOString(),
        latencyMs: ended - started,
      });
    }
    push({
      servedModel: typeof message.model === "string" && message.model.length > 0 ? message.model : null,
      servedModelStatus: servedModelStatus(ctx.tokenSource, body.model, message.model),
      startedAtMs: started,
      endedAtMs: ended,
      outcome: classifyMessage(message, classifier, meta.eligibleUnitIds),
      usage: usageOf(message),
      replayed: replayedFrom !== null,
      replayedFromRunId: replayedFrom,
      modeledUsd: cost,
    });
    return message;
  };

  const client = { messages: { create } } as unknown as Anthropic;
  const record = collectingRecord(ctx.runId, usage);

  return {
    id,
    client,
    record,
    signal: runSignal,
    usage,
    finish(ok: boolean, err?: unknown, opts?: { readonly poolSignal?: AbortSignal }): InvocationRecord {
      const failures = (err as { failures?: { kind?: unknown }[] } | undefined)?.failures;
      const pool = opts?.poolSignal;
      // Cancelled by the pool after another call failed: the error is an
      // abort, the pool's skip, or the pool's reason (the OTHER call's
      // error, rethrown by `throwIfAborted`), or this invocation's own
      // last request ended aborted. The run-level budget stop is not a
      // cancellation.
      const cancelled =
        !ok &&
        !runSignal.aborted &&
        pool?.aborted === true &&
        (err instanceof CallPoolAborted ||
          isAbortError(err) ||
          err === pool.reason ||
          myCalls[myCalls.length - 1]?.outcome === "aborted");
      const rec: InvocationRecord = {
        invocationId: id,
        stage: meta.stage,
        pass: meta.pass,
        variant: meta.variant,
        caseId: meta.caseId,
        repeat: meta.repeat,
        ok,
        attempts: myCalls.filter((c) => c.outcome !== "budget_reached").length,
        failureKinds: ok
          ? []
          : cancelled
            ? ["cancelled"]
            : Array.isArray(failures)
              ? failures.map((f) => (typeof f.kind === "string" ? f.kind : "unknown"))
              : err instanceof BudgetReachedError || runSignal.aborted
                ? ["budget_reached"]
                : ["thrown"],
        startedAtMs: startedAtMs,
        endedAtMs: ctx.clock(),
        ...(err !== undefined && { error: describeError(err) }),
      };
      ctx.invocations.push(rec);
      for (const detail of crossCheckSettings(usage, myCalls)) {
        ctx.settingsMismatches.push({ variant: meta.variant, detail });
      }
      return rec;
    },
  };
}

/**
 * A `record` for the modules: stamps the run id (so the latency report
 * ignores these rows) and keeps the record in memory. Never writes.
 */
export function collectingRecord(runId: string, sink: UsageRecord[]): (u: UsageRecord) => Promise<number> {
  return async (u) => {
    sink.push({ ...u, runId });
    return 0;
  };
}

/**
 * Join each usage record to the wire record of the same attempt and
 * report any `max_tokens` or effort that differs. Every module makes
 * exactly one `create` per loop attempt, so `attempt === attemptIndex`.
 */
export function crossCheckSettings(usage: readonly UsageRecord[], calls: readonly CallRecord[]): string[] {
  const out: string[] = [];
  for (const u of usage) {
    const call = calls.find((c) => c.attemptIndex === u.attempt);
    if (call === undefined) {
      out.push(`usage record for attempt ${String(u.attempt)} has no matching request`);
      continue;
    }
    if (u.maxTokens !== call.maxTokens) {
      out.push(`${call.attemptId}: recorded maxTokens ${String(u.maxTokens)} but sent ${call.maxTokens}`);
    }
    if ((u.effort ?? null) !== call.effort) {
      out.push(`${call.attemptId}: recorded effort ${String(u.effort)} but sent ${String(call.effort)}`);
    }
  }
  return out;
}
