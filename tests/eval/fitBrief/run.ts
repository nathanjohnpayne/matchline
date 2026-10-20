/**
 * `npm run eval:fit-brief` — private fit-brief eval (#495 Phase 3).
 *
 *   MATCHLINE_PRIVATE_CORPUS=/path/outside/this/repo \
 *   ANTHROPIC_API_KEY=... \
 *   npm run eval:fit-brief -- --model claude-sonnet-5-5 --max-usd 10 [options]
 *
 * Options:
 *   --model <id>          generator model (required)
 *   --effort <level>      generator effort (5.5 models)
 *   --judge-model <id>    default claude-opus-5-5
 *   --judge-effort <lvl>  default high
 *   --evidence resume|units
 *                         resume: brief reads the canonical résumé (+ inventory).
 *                         units: brief reads Experience Units extracted from the
 *                         résumé by the current extraction pin.
 *   --split dev|test|all  default dev
 *   --samples <n>         briefs per pair, default 1
 *   --max-usd <n>         spend bound for this invocation (required unless --dry-run)
 *   --out <dir>           private output dir, default ~/.matchline/eval-private/fit-brief/<run-id>
 *   --dry-run             validate corpus, paths and models; print the plan; no API calls
 *
 * Prints aggregates only. Per-pair briefs, judgements and scores go to
 * --out, which must be outside this repository.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";

import { extractFromResume } from "../../../functions/src/extraction/resume.ts";
import { anthropicForCli } from "../../../functions/src/llm/anthropic.ts";
import { priceUsage, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import { isEffort, profileFor, type Effort } from "../../../functions/src/llm/modelProfile.ts";
import { rateFor } from "../../../functions/src/llm/rates.ts";
import {
  generateFitBrief,
  type FitBriefInput,
  type FitBriefResult,
} from "../../../functions/src/generation/fitBrief.ts";

import { assertOutsideRepo, loadCorpus, type CorpusPair, type FitBriefCorpus } from "./corpus.ts";
import { judgeBrief, type JudgeResult } from "./judge.ts";
import {
  aggregate,
  checkEvidence,
  formatAggregate,
  scoreBrief,
  type BriefScore,
} from "./score.ts";

export interface FitBriefEvalOptions {
  readonly model: string;
  readonly effort?: Effort;
  readonly judgeModel: string;
  readonly judgeEffort?: Effort;
  readonly evidence: "resume" | "units";
  readonly split: "dev" | "test" | "all";
  readonly samples: number;
  readonly maxUsd: number;
  readonly outDir: string;
  readonly runId: string;
}

/**
 * Throws `BudgetReachedError` once the run's spend bound is reached. Each
 * dependency must call it before every paid request, retries included —
 * `guardClient` does this for a real Anthropic client (Codex P1 on #581:
 * stage-level checks let retries inside a stage overrun the bound).
 */
export type BudgetGuard = () => void;

type RecordUsageFn = (u: UsageRecord) => Promise<number>;

export interface FitBriefEvalDeps {
  readonly generate: (input: FitBriefInput, record: RecordUsageFn, guard: BudgetGuard) => Promise<FitBriefResult>;
  readonly judge: (args: Parameters<typeof judgeBrief>[0], record: RecordUsageFn, guard: BudgetGuard) => Promise<JudgeResult>;
  /**
   * Only called for --evidence units. Returns one evidence line per Unit:
   * its verbatim text plus its date range, so tenure stays visible.
   */
  readonly extractUnits: (resumeText: string, record: RecordUsageFn, guard: BudgetGuard) => Promise<string[]>;
  readonly writeFile?: (path: string, data: string) => void;
}

/**
 * Raised instead of making a paid request once the bound is reached.
 * Carries HTTP-style status 402 so the stages' retry loops treat it as
 * non-retryable rather than backing off and trying again.
 */
export class BudgetReachedError extends Error {
  readonly status = 402;
  constructor() {
    super("Spend bound reached; no further paid requests.");
    this.name = "BudgetReachedError";
  }
}

/** Wrap a client so every `messages.create` checks the budget first. */
export function guardClient(client: Anthropic, guard: BudgetGuard): Anthropic {
  const create = client.messages.create.bind(client.messages);
  return {
    ...client,
    messages: {
      ...client.messages,
      create: ((...args: Parameters<typeof create>) => {
        // Reject rather than throw, like any other failed request.
        try {
          guard();
        } catch (err) {
          return Promise.reject(err);
        }
        return create(...args);
      }) as typeof create,
    },
  } as Anthropic;
}

export interface FitBriefEvalOutcome {
  readonly report: string;
  readonly spentUsd: number;
  readonly incomplete: boolean;
  readonly rows: readonly { readonly split: string; readonly score: BriefScore | null }[];
}

/**
 * Refuse, before any spend, a model with no rate or request profile, or
 * an effort the model does not accept.
 */
export function preflight(options: Pick<FitBriefEvalOptions, "model" | "effort" | "judgeModel" | "judgeEffort">): void {
  for (const [role, model, effort] of [
    ["--model", options.model, options.effort],
    ["--judge-model", options.judgeModel, options.judgeEffort],
  ] as const) {
    rateFor(model);
    const profile = profileFor(model);
    if (effort !== undefined && !profile.efforts.includes(effort)) {
      throw new Error(`${role} ${model} does not accept effort ${effort}.`);
    }
  }
}

/**
 * The pairs a run covers. Throws on an empty selection (Codex P1 on
 * #581): a zero-row report that exits 0 would read as a passing run.
 */
export function selectPairs(corpus: FitBriefCorpus, split: FitBriefEvalOptions["split"]): CorpusPair[] {
  const pairs = corpus.pairs.filter((p) => split === "all" || p.split === split);
  if (pairs.length === 0) {
    throw new Error(`The manifest has no pairs in split "${split}"; nothing to evaluate.`);
  }
  return pairs;
}

/** The effort a model is actually sent: the explicit one, else its profile default. */
export function resolvedEffort(model: string, effort: Effort | undefined): Effort | undefined {
  return effort ?? profileFor(model).defaultEffort;
}

export async function runFitBriefEval(
  corpus: FitBriefCorpus,
  options: FitBriefEvalOptions,
  deps: FitBriefEvalDeps,
): Promise<FitBriefEvalOutcome> {
  // Owner-only: these files hold the private corpus's briefs and quotes.
  // `mode` applies only when a file is created, so a file reused from an
  // earlier run is chmod-ed too (Codex P2, #581).
  const writeFile =
    deps.writeFile ??
    ((p: string, d: string) => {
      writeFileSync(p, d, { mode: 0o600 });
      chmodSync(p, 0o600);
    });
  let spentUsd = 0;
  const record = async (usage: UsageRecord): Promise<number> => {
    try {
      const { costUsd } = priceUsage(usage);
      spentUsd += costUsd;
      return costUsd;
    } catch {
      return 0;
    }
  };
  const overBudget = () => spentUsd >= options.maxUsd;
  const guard: BudgetGuard = () => {
    if (overBudget()) throw new BudgetReachedError();
  };
  const pairs = selectPairs(corpus, options.split);
  let incomplete = false;
  const generatorEffort = resolvedEffort(options.model, options.effort);
  const judgeEffort = resolvedEffort(options.judgeModel, options.judgeEffort);
  const report = (rows: readonly { split: string; score: BriefScore | null }[]) =>
    formatAggregate(aggregate(rows), {
      model: options.model,
      ...(generatorEffort !== undefined && { effort: generatorEffort }),
      judgeModel: options.judgeModel,
      ...(judgeEffort !== undefined && { judgeEffort }),
      evidenceMode: options.evidence,
      spentUsd,
      maxUsd: options.maxUsd,
      incomplete,
    });

  // A bound already reached (for example --max-usd 0) must stop before
  // the first paid call, including units-mode extraction (Codex P2, #581).
  if (overBudget()) {
    incomplete = true;
    return { report: report([]), spentUsd, incomplete, rows: [] };
  }

  // The canonical résumé and inventory are the grounding authority for
  // both gates in every mode (Codex P1 on #581): Units are what the
  // generator reads in units mode, never what certifies a claim, so an
  // extraction error cannot launder an unsupported claim through the gates.
  const sources = [corpus.resumeText, ...(corpus.inventoryText ? [corpus.inventoryText] : [])];
  let generatorEvidence = corpus.resumeText;
  if (options.evidence === "units") {
    let lines: string[];
    try {
      lines = await deps.extractUnits(corpus.resumeText, record, guard);
    } catch (err) {
      if (!(err instanceof BudgetReachedError) && !overBudget()) throw err;
      incomplete = true;
      return { report: report([]), spentUsd, incomplete, rows: [] };
    }
    generatorEvidence = lines.map((l) => `- ${l}`).join("\n");
  }

  const rows: { split: string; score: BriefScore | null }[] = [];
  let index = 0;
  for (const pair of pairs) {
    for (let sample = 0; sample < options.samples; sample++) {
      if (overBudget()) {
        incomplete = true;
        break;
      }
      index += 1;
      // The manifest already restricts ids, but this entry point is exported;
      // never let an id shape the path (CodeRabbit on #581).
      const safeId = pair.id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
      const file = join(options.outDir, `${String(index).padStart(3, "0")}-${safeId}-s${sample}.json`);
      let generated: FitBriefResult | undefined;
      try {
        generated = await deps.generate(
          {
            jdText: pair.jdText,
            resumeText: generatorEvidence,
            // Kept in both modes so the comparison changes only the résumé's
            // representation, not the facts available (Codex P2, #581).
            ...(corpus.inventoryText !== undefined && { inventoryText: corpus.inventoryText }),
            ...(corpus.claimRulesText !== undefined && { claimRulesText: corpus.claimRulesText }),
          },
          record,
          guard,
        );
        // Recheck before the second paid stage (Codex P1 on #581): a
        // generation that reaches the bound must not start the judge.
        if (overBudget()) {
          incomplete = true;
          writeFile(
            file,
            JSON.stringify(
              { pair: pair.id, split: pair.split, sample, brief: generated.brief, unjudged: "spend bound reached" },
              null,
              2,
            ),
          );
          break;
        }
        const judgement = await deps.judge(
          {
            jdText: pair.jdText,
            referenceText: pair.referenceText,
            generated: generated.brief,
            sourcesText: sources.join("\n\n"),
            ...(corpus.claimRulesText !== undefined && { claimRulesText: corpus.claimRulesText }),
          },
          record,
          guard,
        );
        const evidence = checkEvidence(generated.brief, sources);
        const score = scoreBrief({ evidence, judge: judgement, generatedVerdict: generated.brief.verdict });
        rows.push({ split: pair.split, score });
        writeFile(
          file,
          JSON.stringify(
            { pair: pair.id, split: pair.split, sample, brief: generated.brief, evidence, judgement, score },
            null,
            2,
          ),
        );
      } catch (err) {
        // The bound stopped a request mid-stage: the sample is unfinished,
        // not failed, and nothing after it may run.
        const stoppedByBound = err instanceof BudgetReachedError || overBudget();
        if (stoppedByBound) incomplete = true;
        else rows.push({ split: pair.split, score: null });
        writeFile(
          file,
          JSON.stringify(
            {
              pair: pair.id,
              split: pair.split,
              sample,
              // Keep a paid-for brief when only the judge failed.
              ...(generated !== undefined && { brief: generated.brief }),
              error: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        );
        if (stoppedByBound) break;
      }
    }
    if (incomplete) break;
  }

  return { report: report(rows), spentUsd, incomplete, rows };
}

// -- CLI ---------------------------------------------------------------------

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  }
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

const KNOWN_FLAGS = new Set([
  "--model", "--effort", "--judge-model", "--judge-effort", "--evidence",
  "--split", "--samples", "--max-usd", "--out", "--dry-run",
]);

/** Boolean flags take no value; `--dry-run=true` is rejected, not silently ignored (Codex P2, #581). */
const BOOLEAN_FLAGS = new Set(["--dry-run"]);

export function parseArgs(argv: readonly string[], now: Date = new Date()): FitBriefEvalOptions & { dryRun: boolean } {
  for (const a of argv) {
    const name = a.split("=")[0]!;
    if (a.startsWith("--") && !KNOWN_FLAGS.has(name)) {
      throw new Error(`Unknown flag ${a}`);
    }
    if (BOOLEAN_FLAGS.has(name) && a !== name) {
      throw new Error(`${name} takes no value (got ${a})`);
    }
  }
  const model = flag(argv, "--model");
  if (!model) throw new Error("--model is required");
  const effortRaw = flag(argv, "--effort");
  const judgeModel = flag(argv, "--judge-model") ?? "claude-opus-5-5";
  // Default the judge to high effort only when its model takes effort, so a
  // judge such as claude-sonnet-4-6 stays usable (Codex P2, #581). An
  // unprofiled judge is left for preflight to reject.
  let judgeEffortDefault: string | undefined;
  try {
    judgeEffortDefault = profileFor(judgeModel).efforts.includes("high") ? "high" : undefined;
  } catch {
    judgeEffortDefault = undefined;
  }
  const judgeEffortRaw = flag(argv, "--judge-effort") ?? judgeEffortDefault;
  for (const [n, v] of [["--effort", effortRaw], ["--judge-effort", judgeEffortRaw]] as const) {
    if (v !== undefined && !isEffort(v)) throw new Error(`${n} must be low|medium|high|xhigh|max`);
  }
  const evidence = flag(argv, "--evidence") ?? "resume";
  if (evidence !== "resume" && evidence !== "units") throw new Error("--evidence must be resume|units");
  const split = flag(argv, "--split") ?? "dev";
  if (split !== "dev" && split !== "test" && split !== "all") throw new Error("--split must be dev|test|all");
  const samples = Number(flag(argv, "--samples") ?? "1");
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  const dryRun = argv.includes("--dry-run");
  const maxUsdRaw = flag(argv, "--max-usd");
  if (!dryRun && maxUsdRaw === undefined) throw new Error("--max-usd is required for a paid run");
  const maxUsd = Number(maxUsdRaw ?? "0");
  if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("--max-usd must be a non-negative number");
  const runId = `fit-brief-${now.toISOString().replace(/[:.]/g, "-")}`;
  return {
    model,
    ...(effortRaw !== undefined && { effort: effortRaw as Effort }),
    judgeModel,
    ...(judgeEffortRaw !== undefined && { judgeEffort: judgeEffortRaw as Effort }),
    evidence,
    split,
    samples,
    maxUsd,
    outDir: flag(argv, "--out") ?? join(homedir(), ".matchline", "eval-private", "fit-brief", runId),
    runId,
    dryRun,
  };
}

/**
 * One evidence line per Unit: its verbatim text plus its date range.
 * Dates can live only in `date_range`, and a brief judges tenure (Codex
 * P2 on #581). Other structured fields are omitted on purpose: units mode
 * tests the Units' text and dates, not the full record.
 */
export function unitEvidenceLine(u: { raw_text: string; date_range?: { start: string; end?: string } }): string {
  return u.date_range ? `${u.raw_text} [${u.date_range.start}–${u.date_range.end ?? "present"}]` : u.raw_text;
}

function effortLabel(effort: Effort | undefined): string {
  return effort === undefined ? "" : ` (effort ${effort})`;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const corpusDir = process.env.MATCHLINE_PRIVATE_CORPUS;
  if (!corpusDir) throw new Error("Set MATCHLINE_PRIVATE_CORPUS to the private corpus directory.");
  const corpus = loadCorpus(corpusDir);
  assertOutsideRepo(options.outDir, "--out");
  preflight(options);
  const pairs = selectPairs(corpus, options.split);
  const calls = pairs.length * options.samples;
  console.log(
    `${calls} brief(s): ${pairs.length} ${options.split} pair(s) × ${options.samples} sample(s); ` +
      `generator ${options.model}${effortLabel(resolvedEffort(options.model, options.effort))}, ` +
      `judge ${options.judgeModel}${effortLabel(resolvedEffort(options.judgeModel, options.judgeEffort))}, ` +
      `evidence ${options.evidence}. ` +
      `Output: ${options.outDir}`,
  );
  if (options.dryRun) return 0;

  mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const client: Anthropic = anthropicForCli();
  const outcome = await runFitBriefEval(corpus, options, {
    generate: (input, record, guard) =>
      generateFitBrief(input, {
        model: options.model,
        ...(options.effort !== undefined && { effort: options.effort }),
        client: guardClient(client, guard),
        record,
        runId: options.runId,
      }),
    judge: (args, record, guard) =>
      judgeBrief(args, {
        client: guardClient(client, guard),
        model: options.judgeModel,
        ...(options.judgeEffort !== undefined && { effort: options.judgeEffort }),
        record,
        runId: options.runId,
      }),
    extractUnits: async (resumeText, record, guard) =>
      (
        await extractFromResume(
          resumeText,
          { ownerUid: "eval-fit-brief" },
          { client: guardClient(client, guard), record },
        )
      ).map(unitEvidenceLine),
  });
  console.log(outcome.report);
  // Nonzero when the run stopped early or any sample could not be
  // evaluated (an invalid key, a judge failing every request), so
  // automation never reads failures as a pass (Codex P2, #581).
  return outcome.incomplete || outcome.rows.some((r) => r.score === null) ? 1 : 0;
}

const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Corpus errors can carry pair ids, manifest paths or manifest text;
      // keep them off stdout unless asked (Codex P2, #581).
      const detail = err instanceof Error ? err.message : String(err);
      if (process.env.FIT_BRIEF_VERBOSE === "1") {
        console.error("fit-brief eval failed:", detail);
      } else {
        console.error(
          `fit-brief eval failed (${err instanceof Error ? err.name : "error"}). ` +
            "Details are withheld because they can quote the private corpus; rerun with FIT_BRIEF_VERBOSE=1 to see them.",
        );
      }
      process.exit(2);
    });
}
