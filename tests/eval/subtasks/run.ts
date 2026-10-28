/**
 * `npm run eval:subtasks` — generation and validation-subtask suites
 * (#488, #489).
 *
 *   npm run eval:subtasks -- --suite validation|generation
 *       [--case <id>]... [--samples N] [--prompt <stage>/<name>=vN]...
 *       [--variant '<label>:model.<stage>=<id>,effort.<stage>=<level>,prompt.<stage>/<name>=vN']...
 *       [--token-source api|claude-cli] [--dry-run] [--max-usd <n>]
 *       [--replay | --no-cache] [--report-json <path>]
 *
 * A separate entry point from `npm run eval`, so the corpus report and
 * its CI no-keys path stay byte-for-byte unchanged. See
 * `tests/eval/README.md` § Generation and validation-subtask suites.
 *
 * Order of gates, each before any request: flags and variants parse;
 * fixtures load and match the label lock; every variant resolves under
 * its overrides (an unsupported effort refuses here) and the overrides
 * are proven removed; the plan and projection print (`--dry-run` stops
 * here, with no keys and no client); then keys, `--max-usd` and the
 * monthly caps are checked.
 */

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { anthropicForCli } from "../../../functions/src/llm/anthropic.ts";
import { VALIDATION_STAGES, type ModelConfig, type Stage } from "../../../functions/src/llm/config.ts";
import { zodToToolSchema } from "../../../functions/src/llm/zodToolSchema.ts";
import { canonicalJson } from "../../../functions/src/validation/attestation.ts";
import { VALIDATION_CONCURRENCY } from "../../../functions/src/validation/validate.ts";

import { writePrivateFile } from "../fitBrief/run.ts";
import { checkCaps, DEFAULT_CAPS, shouldBlock } from "../projection.ts";
import {
  cacheDiscriminatorsFor,
  offlineOnlyClient,
  parsePromptOverrides,
  parseSamples,
  parseTokenSource,
} from "../run.ts";
import {
  assertModelsPriced,
  assertPromptSchemasCompatible,
  assertPromptsExist,
  assertVariantsCallable,
  parseVariants,
  type SweepVariant,
} from "../sweep.ts";
import { SWEEP_SCOPES, type SweepScope } from "../sweepScope.ts";
import { claudeCliClient, type TokenSourceKind } from "../tokenSource.ts";

import { BudgetLedger } from "./budget.ts";
import {
  checkLabelLock,
  FixtureError,
  FIXTURES_ROOT,
  loadGenerationSnapshots,
  loadLabelLock,
  loadValidationCases,
  lockedFiles,
  sha256Hex,
  type LoadedCase,
  type LoadedSnapshot,
  type LoadedSuiteFixtures,
} from "./fixtures.ts";
import { CLASSIFIERS, type RunCtx, type SubtaskSuite } from "./instrument.ts";
import {
  assertionCovered,
  assetMetrics,
  costMetrics,
  coverageMetrics,
  generationMetrics,
  schemaByStage,
  specificityMetrics,
  traceabilityMetrics,
  variantValidity,
  wallTime,
} from "./metrics.ts";
import { snapshotDefaults, withVariantOverrides, type ResolvedVariant } from "./overrides.ts";
import { planGeneration, planValidation, project, type PlannedRequest } from "./plan.ts";
import { ReplayStore, type ReplayMode } from "./replay.ts";
import {
  CAVEAT,
  formatSubtaskReport,
  labelStatus,
  type CaseDetail,
  type RunRecord,
  type VariantRecord,
} from "./report.ts";
import { runGenerationSuite, runValidationSuite, type CaseResult, type FlowResult } from "./suites.ts";

const VALUE_FLAGS = ["--suite", "--case", "--samples", "--prompt", "--variant", "--token-source", "--max-usd", "--report-json"];
const BOOLEAN_FLAGS = ["--dry-run", "--replay", "--no-cache"];

export class UsageError extends Error {}

/** Refuse any flag this command does not know, so a typo never silently changes a paid run. */
export function assertKnownSubtaskFlags(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.includes(name)) {
      if (eq === -1) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) throw new UsageError(`${name} requires a value`);
        i++;
      }
    } else if (BOOLEAN_FLAGS.includes(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
    } else {
      throw new UsageError(`unknown flag ${JSON.stringify(name)}. Known: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].join(", ")}`);
    }
  }
}

function values(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) out.push(argv[++i]!);
    else if (arg.startsWith(`${flag}=`)) out.push(arg.slice(flag.length + 1));
  }
  return out;
}

export interface ParsedArgs {
  readonly suite: SubtaskSuite;
  readonly caseIds: readonly string[] | undefined;
  readonly samples: number;
  readonly basePrompts: Readonly<Record<string, string>>;
  readonly variants: readonly SweepVariant[];
  readonly tokenSource: TokenSourceKind;
  readonly dryRun: boolean;
  readonly maxUsd: number | null;
  readonly cacheMode: ReplayMode;
  readonly reportJson: string | null;
}

export function parseSubtaskArgs(argv: readonly string[]): ParsedArgs {
  assertKnownSubtaskFlags(argv);
  const suites = values(argv, "--suite");
  if (suites.length !== 1 || (suites[0] !== "validation" && suites[0] !== "generation")) {
    throw new UsageError("--suite validation|generation is required, once");
  }
  const suite = suites[0];
  const scope = SWEEP_SCOPES[suite];
  const tokenSource = parseTokenSource(argv);
  const samples = parseSamples(argv);
  const basePrompts = parsePromptOverrides(argv);
  for (const key of Object.keys(basePrompts)) {
    if (!scope.promptKeys.includes(key)) {
      throw new UsageError(`--prompt ${key} is not exercised by suite ${suite}. Prompt keys: ${scope.promptKeys.join(", ")}.`);
    }
  }
  const variants = parseVariants(argv, tokenSource, scope);
  if (variants.some((v) => v.label === "baseline")) {
    throw new UsageError(`--variant label "baseline" is reserved for the implicit no-override variant`);
  }
  const maxRaw = values(argv, "--max-usd");
  let maxUsd: number | null = null;
  if (maxRaw.length > 0) {
    const n = Number(maxRaw[maxRaw.length - 1]);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--max-usd must be a positive number (got ${maxRaw.join(", ")})`);
    maxUsd = n;
  }
  const replay = argv.includes("--replay");
  const noCache = argv.includes("--no-cache");
  if (replay && noCache) throw new UsageError("--replay and --no-cache are mutually exclusive");
  const caseIds = values(argv, "--case");
  const reportJson = values(argv, "--report-json");
  return {
    suite,
    caseIds: caseIds.length > 0 ? caseIds : undefined,
    samples,
    basePrompts,
    variants,
    tokenSource,
    dryRun: argv.includes("--dry-run"),
    maxUsd,
    cacheMode: replay ? "replay" : noCache ? "bypass" : "fresh",
    reportJson: reportJson.length > 0 ? reportJson[reportJson.length - 1]! : null,
  };
}

export interface SubtaskDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  /** Builds the live client; never called on a dry run. */
  readonly clientFactory: (tokenSource: TokenSourceKind) => Anthropic;
  readonly fixturesRoot?: string;
  readonly replayDir?: string;
  readonly clock?: () => number;
  readonly now?: () => Date;
  readonly git?: () => { sha: string | null; dirty: boolean | null };
  readonly writeFile?: (path: string, data: string) => void;
}

export function newRunId(now: Date): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `eval-${iso}-${randomBytes(3).toString("hex")}`;
}

function defaultGit(): { sha: string | null; dirty: boolean | null } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

const BASELINE: SweepVariant = Object.freeze({ label: "baseline", models: {}, promptVersions: {} });

/** sha256 of each tool schema the suite's modules enforce, by `promptKey@version`. */
function schemaHashes(suite: SubtaskSuite): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, schema] of Object.entries(CLASSIFIERS)) {
    if (suite === "validation" && key.startsWith("generation/")) continue;
    out[key] = sha256Hex(canonicalJson(zodToToolSchema(schema as Parameters<typeof zodToToolSchema>[0])));
  }
  return out;
}

function verdictLabel(v: { ok: boolean; value?: { supports?: boolean; specific?: boolean } } | undefined, field: "supports" | "specific"): string {
  if (v === undefined) return "-";
  if (!v.ok) return "err";
  return v.value?.[field] ? "yes" : "no";
}

function caseDetails(cases: readonly LoadedCase[], results: readonly CaseResult[]): CaseDetail[] {
  const byId = new Map(cases.map((c) => [c.case.id, c.case]));
  return results.map((r) => {
    const c = byId.get(r.caseId)!;
    if (r.skipped !== undefined) {
      return { caseId: r.caseId, category: r.category, repeat: r.repeat, covered: "skipped", traceability: "-", specificity: "-", asset: r.skipped };
    }
    const claims = r.claims?.ok === true ? r.claims.value.map((x) => x.text) : [];
    const covered = c.gold.assertions.filter((a) => assertionCovered(a, claims)).length;
    return {
      caseId: r.caseId,
      category: r.category,
      repeat: r.repeat,
      covered: r.claims?.ok === false ? "extraction failed" : `${covered}/${c.gold.assertions.length}`,
      traceability: c.gold.assertions
        .map((a) => `${a.id}:${verdictLabel(r.traceability[a.id] as never, "supports")}/${a.supported ? "yes" : "no"}`)
        .join(" "),
      specificity: c.gold.assertions
        .filter((a) => a.specific !== null)
        .map((a) => `${a.id}:${verdictLabel(r.specificity[a.id] as never, "specific")}/${a.specific ? "yes" : "no"}`)
        .join(" ") || "-",
      asset: r.asset === null ? "not run" : r.asset.ok ? `${r.asset.value.status} (expected ${c.gold.expected_asset_status})` : "errored",
    };
  });
}

function snapshotDetail(f: FlowResult): string {
  if (f.skipped !== undefined) return `skipped: ${f.skipped}`;
  if (!f.generated) return `not generated after ${f.attempts} attempt(s): ${f.failureKinds.join(", ") || f.error || "unknown"}`;
  const down = f.downstream === null ? "not run" : f.downstream.ok ? f.downstream.value.status : `errored (${f.downstream.error})`;
  return `generated in ${f.attempts} attempt(s); baseline validator: ${down}`;
}

export async function main(argv: readonly string[], deps: SubtaskDeps): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseSubtaskArgs(argv);
  } catch (err) {
    deps.stderr(`eval:subtasks: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const scope: SweepScope = SWEEP_SCOPES[args.suite];
  const clock = deps.clock ?? Date.now;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const runId = newRunId(startedAt);

  // 1. Pre-flights that need the filesystem, then fixtures and the label lock.
  let fixtures: LoadedSuiteFixtures<LoadedCase> | LoadedSuiteFixtures<LoadedSnapshot>;
  try {
    assertPromptsExist(args.variants, args.basePrompts);
    assertModelsPriced(args.variants);
    assertPromptSchemasCompatible(args.variants, args.basePrompts, undefined, scope);
    assertVariantsCallable(args.variants, scope);
    const opts = { ...(deps.fixturesRoot !== undefined && { root: deps.fixturesRoot }), ...(args.caseIds !== undefined && { ids: args.caseIds }) };
    fixtures = args.suite === "validation" ? loadValidationCases(opts) : loadGenerationSnapshots(opts);
    const problems = checkLabelLock(loadLabelLock(deps.fixturesRoot), lockedFiles(deps.fixturesRoot));
    if (problems.length > 0) throw new FixtureError(`label lock mismatch:\n  ${problems.join("\n  ")}`);
    if (fixtures.items.length === 0) throw new FixtureError("no fixtures to run");
  } catch (err) {
    deps.stderr(`eval:subtasks: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // 2. Resolve every variant under its overrides (proves restore; refuses unsupported effort) and plan it.
  const variants = [BASELINE, ...args.variants];
  const defaults: Readonly<Record<Stage, ModelConfig>> = snapshotDefaults();
  const resolvedByLabel = new Map<string, ResolvedVariant>();
  const planRows: PlannedRequest[] = [];
  try {
    for (const v of variants) {
      const { value, resolved } = await withVariantOverrides(v, scope, args.basePrompts, async (resolved) =>
        args.suite === "validation"
          ? planValidation(fixtures.items as readonly LoadedCase[], resolved, args.samples)
          : planGeneration(fixtures.items as readonly LoadedSnapshot[], resolved, defaults, args.samples),
      );
      resolvedByLabel.set(v.label, resolved);
      planRows.push(...value);
    }
  } catch (err) {
    deps.stderr(`eval:subtasks: variant refused before any request: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const plan = project(planRows);
  const metered = args.tokenSource === "api";
  const capChecks = checkCaps(
    { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 },
    { anthropicUsd: metered ? plan.worstCaseUsd : 0, openaiUsd: 0, firebaseUsd: 0 },
    DEFAULT_CAPS,
  );

  const files = fixtures.files;
  const primary =
    args.suite === "validation"
      ? (fixtures.items as readonly LoadedCase[]).map((c) => ({ id: c.case.id, path: c.file.path, derivedFrom: c.case.source.derived_from }))
      : (fixtures.items as readonly LoadedSnapshot[]).map((s) => ({ id: s.snapshot.id, path: s.file.path, derivedFrom: null }));
  const primaryFiles = (fixtures.items as readonly { file: { review_status: string } }[]).map((i) => i.file);

  const store = new ReplayStore({ mode: args.cacheMode, ...(deps.replayDir !== undefined && { dir: deps.replayDir }) });
  const runAbort = new AbortController();
  const ledger = new BudgetLedger({ maxUsd: metered ? args.maxUsd : null, abort: runAbort });

  const record = (variantRecords: VariantRecord[], dryRun: boolean, calls: RunCtx["calls"], invocations: RunCtx["invocations"]): RunRecord => ({
    schema_version: 1,
    runId,
    suite: args.suite,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    dryRun,
    git: (deps.git ?? defaultGit)(),
    tokenSource: args.tokenSource,
    tokenFidelity: metered ? "metered" : "estimated",
    cacheMode: args.cacheMode,
    samples: args.samples,
    labels: { status: labelStatus(primaryFiles), fixtureSetHash: fixtures.fixtureSetHash, files, primary },
    schemas: schemaHashes(args.suite),
    variants: variantRecords,
    guards: {
      maxUsd: args.maxUsd,
      projected: { expectedUsd: plan.expectedUsd, worstCaseUsd: plan.worstCaseUsd, requests: plan.requests },
      capChecks,
      spentUsd: ledger.spentUsd,
      budgetReached: runAbort.signal.aborted,
    },
    plan,
    invocations,
    calls,
    caveat: CAVEAT,
  });

  const emptyVariant = (label: string): VariantRecord => ({
    label,
    validity: "valid",
    resolved: resolvedByLabel.get(label)!,
    servedModels: {},
    concurrency: VALIDATION_CONCURRENCY,
    budgetMs: null,
    metrics: null,
    wallTime: null,
    usage: null,
    notes: [],
  });

  const emit = (r: RunRecord): void => {
    deps.stdout(formatSubtaskReport(r));
    if (args.reportJson !== null) (deps.writeFile ?? writePrivateFile)(args.reportJson, JSON.stringify(r, null, 2) + "\n");
  };

  // 3. Dry run: plan only. No key, no client.
  if (args.dryRun) {
    emit(record(variants.map((v) => emptyVariant(v.label)), true, [], []));
    return 0;
  }

  // 4-6. Keys, bound, caps.
  const haveKey = (deps.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
  if (metered && !haveKey && args.cacheMode !== "replay") {
    deps.stderr("eval:subtasks: set ANTHROPIC_API_KEY or use --dry-run");
    return 2;
  }
  if (metered && haveKey && args.maxUsd === null) {
    deps.stderr(`eval:subtasks: a live api run needs --max-usd (worst case $${plan.worstCaseUsd.toFixed(2)}); post the projection on #495 first`);
    return 2;
  }
  if (metered && haveKey && args.maxUsd !== null && plan.worstCaseUsd > args.maxUsd) {
    deps.stderr(`eval:subtasks: worst-case projection $${plan.worstCaseUsd.toFixed(2)} exceeds --max-usd $${args.maxUsd.toFixed(2)}; refusing before any request`);
    return 1;
  }
  if (shouldBlock(capChecks)) {
    deps.stderr("eval:subtasks: projection exceeds a monthly cap; refusing before any request");
    return 1;
  }

  // 7. Run.
  const rawClient =
    metered && !haveKey
      ? offlineOnlyClient<Anthropic>("Anthropic", "ANTHROPIC_API_KEY")
      : deps.clientFactory(args.tokenSource);
  let seq = 0;
  const ctx: RunCtx = {
    runId,
    suite: args.suite,
    tokenSource: args.tokenSource,
    cliAdapterVersion: cacheDiscriminatorsFor(args.tokenSource)?.cliAdapter ?? null,
    rawClient,
    store,
    ledger,
    runAbort,
    clock,
    nextId: () => String(seq++),
    calls: [],
    invocations: [],
    settingsMismatches: [],
  };

  const variantRecords: VariantRecord[] = [];
  for (const v of variants) {
    const caseResults: CaseResult[] = [];
    const flowResults: FlowResult[] = [];
    const notes: string[] = [];
    let preflightFailed = false;
    try {
      for (let repeat = 0; repeat < args.samples; repeat++) {
        await withVariantOverrides(v, scope, args.basePrompts, async () => {
          if (args.suite === "validation") {
            caseResults.push(...(await runValidationSuite(fixtures.items as readonly LoadedCase[], v.label, repeat, ctx)));
          } else {
            flowResults.push(...(await runGenerationSuite(fixtures.items as readonly LoadedSnapshot[], v.label, repeat, ctx, defaults)));
          }
        });
      }
    } catch (err) {
      preflightFailed = true;
      notes.push(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const calls = ctx.calls.filter((c) => c.variant === v.label);
    const invocations = ctx.invocations.filter((i) => i.variant === v.label);
    const mismatches = ctx.settingsMismatches.filter((m) => m.variant === v.label);
    for (const m of mismatches) notes.push(`settings mismatch: ${m.detail}`);
    const servedModels: Record<string, string[]> = {};
    for (const c of calls) {
      if (c.servedModel === null) continue;
      const list = (servedModels[c.stage] ??= []);
      if (!list.includes(c.servedModel)) list.push(c.servedModel);
    }
    const budgetReached = caseResults.some((r) => r.skipped !== undefined) || flowResults.some((f) => f.skipped !== undefined) || runAbort.signal.aborted;
    const validity = variantValidity({ calls, settingsMismatches: mismatches.length, preflightFailed, budgetReached });
    let metrics: VariantRecord["metrics"];
    let completedFlows: number;
    let e2e: number[] | null = null;
    if (args.suite === "validation") {
      const cases = (fixtures.items as readonly LoadedCase[]).map((c) => c.case);
      const isolated = { inv: invocations.filter((i) => i.pass === "isolated" || i.pass === "whole_asset"), calls };
      metrics = {
        kind: "validation",
        coverage: coverageMetrics(cases, caseResults),
        schema: schemaByStage(isolated.inv, isolated.calls, VALIDATION_STAGES),
        traceability: traceabilityMetrics(cases, caseResults),
        specificity: specificityMetrics(cases, caseResults),
        asset: assetMetrics(cases, caseResults),
        perCase: caseDetails(fixtures.items as readonly LoadedCase[], caseResults),
      };
      completedFlows = caseResults.filter((r) => r.asset?.ok === true).length;
    } else {
      const snaps = new Map(
        (fixtures.items as readonly LoadedSnapshot[]).map((s) => [
          s.snapshot.id,
          {
            snapshot: s.snapshot,
            traces: s.snapshot.source.expected_traces === null ? null : traceList(s.snapshot.source.expected_traces, deps.fixturesRoot),
          },
        ]),
      );
      metrics = {
        kind: "generation",
        generation: generationMetrics(flowResults, snaps, calls),
        schema: schemaByStage(invocations, calls, ["generation", ...VALIDATION_STAGES]),
        perSnapshot: flowResults.map((f) => ({ snapshotId: f.snapshotId, repeat: f.repeat, detail: snapshotDetail(f) })),
      };
      completedFlows = flowResults.filter((f) => f.completed).length;
      e2e = flowResults.filter((f) => f.spans !== null).map((f) => f.spans!.e2eMs);
    }
    variantRecords.push({
      ...emptyVariant(v.label),
      validity,
      servedModels,
      metrics,
      wallTime: wallTime(calls, args.suite === "validation" ? VALIDATION_STAGES : ["generation", ...VALIDATION_STAGES], e2e),
      usage: costMetrics(calls, completedFlows),
      notes,
    });
  }

  const finalRecord = record(variantRecords, false, ctx.calls, ctx.invocations);
  emit(finalRecord);

  // 8. Exit code.
  const baselineInvalid = variantRecords[0]!.validity !== "valid";
  const allInvalid = variantRecords.every((v) => v.validity !== "valid");
  if (runAbort.signal.aborted) {
    deps.stderr("eval:subtasks: budget reached; remaining work was skipped");
    return 1;
  }
  if (baselineInvalid || allInvalid) return 1;
  return 0;
}

function traceList(relPath: string, root: string | undefined): { source_unit_ids: readonly string[] }[] {
  const text = readFixture(relPath, root);
  return (JSON.parse(text) as { expected_traces: { source_unit_ids: string[] }[] }).expected_traces;
}

function readFixture(relPath: string, root: string | undefined): string {
  return readFileSync(join(root ?? FIXTURES_ROOT, relPath), "utf8");
}

const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: (s) => console.log(s),
    stderr: (s) => console.error(s),
    clientFactory: (kind) => (kind === "claude-cli" ? claudeCliClient() : anthropicForCli()),
  })
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error("eval:subtasks failed:", err);
      process.exit(2);
    });
}
