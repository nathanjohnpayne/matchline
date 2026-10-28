/**
 * The validation and generation suites (#488).
 *
 * **Validation.** Each subtask is graded in isolation against human (or
 * draft) gold labels, never against another model's output:
 * claim extraction on the item; traceability on each GOLD assertion
 * against the item's cited Units only (the same candidate rule as
 * `validateBullet`); specificity on each gold assertion that carries a
 * specificity label. A whole-asset pass then runs the production
 * orchestrator (`validateAsset`) with in-memory loaders and a no-op
 * persist, graded only on its passed/failed status.
 *
 * **Generation.** Runs `runGenerationPipeline` from frozen approved
 * matches (JD parsing and matching are not re-run), then validates the
 * output with the validator pinned to production defaults — a variant
 * can never grade its own generation. That verdict is reported as the
 * baseline validator's, not as ground truth.
 *
 * Nothing here touches Firestore: every loader is injected.
 *
 * Every prompt that shows the run date (`Today:` in traceability and
 * generation, #485) gets `fixedRunClock` (`FIXED_RUN_DATE`), never the
 * wall clock, so a case's request bodies, and so its replay keys, are
 * the same on every day it runs.
 */

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";

import type { ModelConfig, Stage } from "../../../functions/src/llm/config.ts";
import { runGenerationPipeline, liveApprovedMatchesOf } from "../../../functions/src/generation/pipeline.ts";
import type { ExperienceUnit } from "../../../functions/src/types/capability.ts";
import type { AssetRef, GeneratedAssetContent, GeneratedItem, ValidationStatus } from "../../../functions/src/types/crm.ts";
import { extractClaims, type Claim } from "../../../functions/src/validation/claimExtraction.ts";
import { checkSpecificity, type SpecificityResult } from "../../../functions/src/validation/specificity.ts";
import { checkTraceability, type TraceabilityResult } from "../../../functions/src/validation/traceability.ts";
import { validateAsset, VALIDATION_CONCURRENCY, type ValidationDeps } from "../../../functions/src/validation/validate.ts";

import { describeError } from "../runForFixture.ts";

import {
  EVAL_OWNER_UID,
  FIXED_ISO,
  fixedRunClock,
  toGenerationInputs,
  type LoadedCase,
  type LoadedSnapshot,
} from "./fixtures.ts";
import { startInvocation, stoppedKind, type CallPass, type RunCtx } from "./instrument.ts";
import { assertValidationAtDefaults } from "./overrides.ts";

/**
 * A module's result, or its failure. `stopped` marks a failure that is
 * not the module's own: the run's budget stopped it, or the validation
 * call pool cancelled it after another call failed. Metrics leave
 * stopped verdicts out of their denominators.
 */
export type Verdict<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly stopped?: "budget_reached" | "cancelled" };

export interface CaseResult {
  readonly caseId: string;
  readonly category: string;
  readonly repeat: number;
  readonly skipped?: "budget_reached";
  readonly claims: Verdict<readonly Claim[]> | null;
  readonly traceability: Readonly<Record<string, Verdict<TraceabilityResult>>>;
  readonly specificity: Readonly<Record<string, Verdict<SpecificityResult>>>;
  readonly asset: Verdict<{ readonly status: ValidationStatus; readonly flagCounts: Readonly<Record<string, number>> }> | null;
  /** Wall time of the whole-asset `validateAsset` run (the validation suite's end-to-end span); null when it did not run. */
  readonly assetSpanMs: number | null;
}

export interface FlowSpans {
  readonly generationMs: number | null;
  readonly validationMs: number | null;
  readonly e2eMs: number;
}

export interface FlowResult {
  readonly snapshotId: string;
  readonly repeat: number;
  readonly skipped?: "budget_reached";
  /** Generation returned schema-valid content with only eligible ids. */
  readonly generated: boolean;
  /** Generated AND the baseline validator returned a verdict. */
  readonly completed: boolean;
  readonly attempts: number;
  readonly failureKinds: readonly string[];
  readonly error?: string;
  readonly content: GeneratedAssetContent | null;
  /** The baseline (production-default) validator's verdict on the output; not ground truth. */
  readonly downstream: Verdict<{ readonly status: ValidationStatus; readonly flagCounts: Readonly<Record<string, number>> }> | null;
  readonly spans: FlowSpans | null;
}

/** Run at most `n` tasks at once. */
export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= n) return;
    const start = queue.shift();
    if (start !== undefined) {
      active++;
      start();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** A sleep that ends early (without throwing) once `signal` aborts. */
export function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
}

async function invoke<T>(
  ctx: RunCtx,
  meta: { variant: string; caseId: string; repeat: number; stage: Stage; pass: CallPass; eligibleUnitIds?: ReadonlySet<string> },
  run: (inv: { client: Anthropic; record: ReturnType<typeof startInvocation>["record"]; signal: AbortSignal }) => Promise<T>,
): Promise<Verdict<T>> {
  const inv = startInvocation(ctx, meta);
  try {
    const value = await run(inv);
    inv.finish(true);
    return { ok: true, value };
  } catch (err) {
    const rec = inv.finish(false, err);
    const stopped = stoppedKind(rec);
    return { ok: false, error: describeError(err), ...(stopped !== null && { stopped }) };
  }
}

function combine(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
}

function flagCounts(flags: readonly { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of flags) out[f.status] = (out[f.status] ?? 0) + 1;
  return out;
}

/**
 * `validateAsset` with in-memory loaders and every check routed through
 * its own instrumented invocation.
 */
async function validateInMemory(
  ctx: RunCtx,
  meta: { variant: string; caseId: string; repeat: number; pass: CallPass },
  content: GeneratedAssetContent,
  units: readonly ExperienceUnit[],
): Promise<Verdict<{ status: ValidationStatus; flagCounts: Record<string, number> }>> {
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const assetId = `asset-${meta.caseId}`;
  const asset: AssetRef = {
    id: assetId,
    owner_uid: EVAL_OWNER_UID,
    application_id: `app-${meta.caseId}`,
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content,
    validation_status: "pending",
    created_at: FIXED_ISO,
  };
  // `poolSignal` is the call pool's signal from the module's context: a
  // failure caused by the pool aborting is recorded as `cancelled`.
  const wrap = <A extends unknown[], R>(
    stage: Stage,
    poolSignal: (...args: A) => AbortSignal | undefined,
    call: (inv: { client: Anthropic; record: ReturnType<typeof startInvocation>["record"]; signal: AbortSignal }, ...args: A) => Promise<R>,
  ) =>
    async (...args: A): Promise<R> => {
      const inv = startInvocation(ctx, { ...meta, stage });
      try {
        const value = await call(inv, ...args);
        inv.finish(true);
        return value;
      } catch (err) {
        const signal = poolSignal(...args);
        inv.finish(false, err, signal === undefined ? undefined : { poolSignal: signal });
        throw err;
      }
    };
  const deps: ValidationDeps = {
    loadAsset: async () => ({ asset, content }),
    loadUnits: async (ids) => ids.map((id) => unitsById.get(id)).filter((u): u is ExperienceUnit => u !== undefined),
    persistFlags: async () => {},
    extractClaims: wrap("claim_extraction", (_b, c) => c.signal, (inv, bullet: Parameters<typeof extractClaims>[0], c: Parameters<typeof extractClaims>[1]) =>
      extractClaims(bullet, { ...c, signal: combine(c.signal, inv.signal) }, {
        client: inv.client,
        record: inv.record,
        generateId: (b, i) => `${b}::c${i}`,
      }),
    ),
    checkTraceability: wrap("traceability", (_cl, _u, c) => c.signal, (inv, claim: Claim, cands: readonly ExperienceUnit[], c: Parameters<typeof checkTraceability>[2]) =>
      checkTraceability(claim, cands, { ...c, signal: combine(c.signal, inv.signal) }, { client: inv.client, record: inv.record, clock: fixedRunClock }),
    ),
    checkSpecificity: wrap("specificity", (_cl, c) => c.signal, (inv, claim: Claim, c: Parameters<typeof checkSpecificity>[1]) =>
      checkSpecificity(claim, { ...c, signal: combine(c.signal, inv.signal) }, { client: inv.client, record: inv.record }),
    ),
    generateId: ctx.nextId,
    now: () => FIXED_ISO,
    clockMs: ctx.clock,
  };
  try {
    const result = await validateAsset(
      { ownerUid: EVAL_OWNER_UID, applicationId: `app-${meta.caseId}`, assetId },
      deps,
    );
    return { ok: true, value: { status: result.status, flagCounts: flagCounts(result.flags) } };
  } catch (err) {
    return {
      ok: false,
      error: describeError(err),
      ...(ctx.runAbort.signal.aborted && { stopped: "budget_reached" as const }),
    };
  }
}

const EMPTY_SUMMARY: GeneratedItem = { id: "summary", text: "", source_unit_ids: [] };

/** The one-item asset a case's whole-asset pass validates. */
export function caseContent(lc: LoadedCase): GeneratedAssetContent {
  const item: GeneratedItem = {
    id: lc.case.item.id,
    text: lc.case.item.text,
    source_unit_ids: [...lc.case.item.source_unit_ids],
  };
  switch (lc.case.item.section) {
    case "summary":
      return { summary: item, bullets: [], skills: [] };
    case "skills":
      return { summary: EMPTY_SUMMARY, bullets: [], skills: [item] };
    default:
      return { summary: EMPTY_SUMMARY, bullets: [item], skills: [] };
  }
}

export async function runValidationSuite(
  cases: readonly LoadedCase[],
  variant: string,
  repeat: number,
  ctx: RunCtx,
): Promise<CaseResult[]> {
  const limit = createLimiter(VALIDATION_CONCURRENCY);
  const results: CaseResult[] = [];
  for (const lc of cases) {
    const c = lc.case;
    if (ctx.runAbort.signal.aborted) {
      results.push({ caseId: c.id, category: c.category, repeat, skipped: "budget_reached", claims: null, traceability: {}, specificity: {}, asset: null, assetSpanMs: null });
      continue;
    }
    const meta = { variant, caseId: c.id, repeat };
    const unitsById = new Map(lc.units.map((u) => [u.id, u]));
    const candidates = c.item.source_unit_ids
      .map((id) => unitsById.get(id))
      .filter((u): u is ExperienceUnit => u !== undefined);

    const claimsP = limit(() =>
      invoke(ctx, { ...meta, stage: "claim_extraction", pass: "isolated" }, (inv) =>
        extractClaims(
          { text: c.item.text, source_unit_ids: c.item.source_unit_ids },
          { ownerUid: EVAL_OWNER_UID, assetId: `asset-${c.id}`, bulletId: c.item.id, sectionTitle: c.item.section, signal: inv.signal },
          { client: inv.client, record: inv.record, generateId: (b, i) => `${b}::c${i}` },
        ),
      ),
    );
    const traceP = c.gold.assertions.map((a) =>
      limit(() =>
        invoke(ctx, { ...meta, stage: "traceability", pass: "isolated" }, (inv) =>
          checkTraceability(
            { id: `${c.id}:${a.id}`, bullet_id: c.item.id, text: a.text },
            candidates,
            { ownerUid: EVAL_OWNER_UID, signal: inv.signal },
            { client: inv.client, record: inv.record, clock: fixedRunClock },
          ),
        ),
      ).then((v) => [a.id, v] as const),
    );
    const specP = c.gold.assertions
      .filter((a) => a.specific !== null)
      .map((a) =>
        limit(() =>
          invoke(ctx, { ...meta, stage: "specificity", pass: "isolated" }, (inv) =>
            checkSpecificity(
              { id: `${c.id}:${a.id}`, bullet_id: c.item.id, text: a.text },
              { ownerUid: EVAL_OWNER_UID, signal: inv.signal },
              { client: inv.client, record: inv.record },
            ),
          ),
        ).then((v) => [a.id, v] as const),
      );
    const [claims, trace, spec] = await Promise.all([claimsP, Promise.all(traceP), Promise.all(specP)]);

    let asset: CaseResult["asset"] = null;
    let assetSpanMs: number | null = null;
    if (!ctx.runAbort.signal.aborted) {
      const assetStart = ctx.clock();
      asset = await validateInMemory(ctx, { ...meta, pass: "whole_asset" }, caseContent(lc), lc.units);
      assetSpanMs = ctx.clock() - assetStart;
    }

    results.push({
      caseId: c.id,
      category: c.category,
      repeat,
      claims,
      traceability: Object.fromEntries(trace),
      specificity: Object.fromEntries(spec),
      asset,
      assetSpanMs,
    });
  }
  return results;
}

export async function runGenerationSuite(
  snapshots: readonly LoadedSnapshot[],
  variant: string,
  repeat: number,
  ctx: RunCtx,
  defaults: Readonly<Record<Stage, ModelConfig>>,
): Promise<FlowResult[]> {
  const results: FlowResult[] = [];
  for (const ls of snapshots) {
    const s = ls.snapshot;
    if (ctx.runAbort.signal.aborted) {
      results.push({ snapshotId: s.id, repeat, skipped: "budget_reached", generated: false, completed: false, attempts: 0, failureKinds: [], content: null, downstream: null, spans: null });
      continue;
    }
    const inputs = toGenerationInputs(s, ls.resumeText, ls.jdText);
    const live = liveApprovedMatchesOf(inputs.approvedMatches, inputs.requirements);
    const eligible = new Set(live.map((m) => m.experience_unit_id));
    const flowStart = ctx.clock();

    const inv = startInvocation(ctx, { variant, caseId: s.id, repeat, stage: "generation", pass: "generation", eligibleUnitIds: eligible });
    let content: GeneratedAssetContent | null = null;
    let genRec;
    let error: string | undefined;
    try {
      const result = await runGenerationPipeline(
        { ownerUid: EVAL_OWNER_UID, applicationId: `app-${s.id}` },
        {
          client: inv.client,
          record: inv.record,
          loadInputs: async () => inputs,
          generateId: ctx.nextId,
          sleep: abortableSleep(ctx.runAbort.signal),
          clock: fixedRunClock,
        },
      );
      content = result.content;
      genRec = inv.finish(true);
    } catch (err) {
      genRec = inv.finish(false, err);
      error = describeError(err);
    }
    const genEnd = ctx.clock();

    let downstream: FlowResult["downstream"] = null;
    let validationMs: number | null = null;
    if (content !== null && !ctx.runAbort.signal.aborted) {
      const valStart = ctx.clock();
      try {
        assertValidationAtDefaults(defaults);
        downstream = await validateInMemory(ctx, { variant, caseId: s.id, repeat, pass: "downstream" }, content, inputs.units);
      } catch (err) {
        downstream = { ok: false, error: describeError(err) };
      }
      validationMs = ctx.clock() - valStart;
    }

    results.push({
      snapshotId: s.id,
      repeat,
      generated: content !== null,
      completed: content !== null && downstream !== null && downstream.ok,
      attempts: genRec.attempts,
      failureKinds: genRec.failureKinds,
      ...(error !== undefined && { error }),
      content,
      downstream,
      spans: { generationMs: genEnd - flowStart, validationMs, e2eMs: ctx.clock() - flowStart },
    });
  }
  return results;
}
