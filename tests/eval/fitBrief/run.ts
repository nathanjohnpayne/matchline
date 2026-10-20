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

import { mkdirSync, writeFileSync } from "node:fs";
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

export interface FitBriefEvalDeps {
  readonly generate: (input: FitBriefInput, record: (u: UsageRecord) => Promise<number>) => Promise<FitBriefResult>;
  readonly judge: (
    args: Parameters<typeof judgeBrief>[0],
    record: (u: UsageRecord) => Promise<number>,
  ) => Promise<JudgeResult>;
  /** Only called for --evidence units. Returns one evidence line per Unit. */
  readonly extractUnits: (resumeText: string, record: (u: UsageRecord) => Promise<number>) => Promise<string[]>;
  readonly writeFile?: (path: string, data: string) => void;
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

export function selectPairs(corpus: FitBriefCorpus, split: FitBriefEvalOptions["split"]): CorpusPair[] {
  return corpus.pairs.filter((p) => split === "all" || p.split === split);
}

export async function runFitBriefEval(
  corpus: FitBriefCorpus,
  options: FitBriefEvalOptions,
  deps: FitBriefEvalDeps,
): Promise<FitBriefEvalOutcome> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d));
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

  const resumeSources = [corpus.resumeText, ...(corpus.inventoryText ? [corpus.inventoryText] : [])];
  let evidenceText = resumeSources.join("\n\n");
  if (options.evidence === "units") {
    const lines = await deps.extractUnits(corpus.resumeText, record);
    evidenceText = lines.map((l) => `- ${l}`).join("\n");
  }
  const sources = options.evidence === "units" ? [evidenceText] : resumeSources;

  const rows: { split: string; score: BriefScore | null }[] = [];
  let incomplete = false;
  let index = 0;
  for (const pair of selectPairs(corpus, options.split)) {
    for (let sample = 0; sample < options.samples; sample++) {
      if (overBudget()) {
        incomplete = true;
        break;
      }
      index += 1;
      const file = join(options.outDir, `${String(index).padStart(3, "0")}-${pair.id}-s${sample}.json`);
      try {
        const generated = await deps.generate(
          {
            jdText: pair.jdText,
            resumeText: evidenceText,
            ...(corpus.claimRulesText !== undefined && { claimRulesText: corpus.claimRulesText }),
          },
          record,
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
        rows.push({ split: pair.split, score: null });
        writeFile(
          file,
          JSON.stringify(
            { pair: pair.id, split: pair.split, sample, error: err instanceof Error ? err.message : String(err) },
            null,
            2,
          ),
        );
      }
    }
    if (incomplete) break;
  }

  const report = formatAggregate(aggregate(rows), {
    model: options.model,
    ...(options.effort !== undefined && { effort: options.effort }),
    judgeModel: options.judgeModel,
    evidenceMode: options.evidence,
    spentUsd,
    maxUsd: options.maxUsd,
    incomplete,
  });
  return { report, spentUsd, incomplete, rows };
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

export function parseArgs(argv: readonly string[], now: Date = new Date()): FitBriefEvalOptions & { dryRun: boolean } {
  for (const a of argv) {
    if (a.startsWith("--") && !KNOWN_FLAGS.has(a.split("=")[0]!)) {
      throw new Error(`Unknown flag ${a}`);
    }
  }
  const model = flag(argv, "--model");
  if (!model) throw new Error("--model is required");
  const effortRaw = flag(argv, "--effort");
  const judgeEffortRaw = flag(argv, "--judge-effort") ?? "high";
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
    judgeModel: flag(argv, "--judge-model") ?? "claude-opus-5-5",
    judgeEffort: judgeEffortRaw as Effort,
    evidence,
    split,
    samples,
    maxUsd,
    outDir: flag(argv, "--out") ?? join(homedir(), ".matchline", "eval-private", "fit-brief", runId),
    runId,
    dryRun,
  };
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
      `generator ${options.model}${options.effort ? ` (${options.effort})` : ""}, ` +
      `judge ${options.judgeModel} (${options.judgeEffort}), evidence ${options.evidence}. ` +
      `Output: ${options.outDir}`,
  );
  if (options.dryRun) return 0;

  mkdirSync(options.outDir, { recursive: true });
  const client: Anthropic = anthropicForCli();
  const outcome = await runFitBriefEval(corpus, options, {
    generate: (input, record) =>
      generateFitBrief(input, {
        model: options.model,
        ...(options.effort !== undefined && { effort: options.effort }),
        client,
        record,
        runId: options.runId,
      }),
    judge: (args, record) =>
      judgeBrief(args, {
        client,
        model: options.judgeModel,
        ...(options.judgeEffort !== undefined && { effort: options.judgeEffort }),
        record,
        runId: options.runId,
      }),
    extractUnits: async (resumeText, record) =>
      (await extractFromResume(resumeText, { ownerUid: "eval-fit-brief" }, { client, record })).map(
        (u) => u.raw_text,
      ),
  });
  console.log(outcome.report);
  return outcome.incomplete ? 1 : 0;
}

const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("fit-brief eval failed:", err instanceof Error ? err.message : err);
      process.exit(2);
    });
}
