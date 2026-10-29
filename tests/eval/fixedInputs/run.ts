#!/usr/bin/env -S tsx
/**
 * `npm run eval:fixed-inputs` (#648): run the production matcher on fixed
 * inputs and score it with the eval scorer, to separate what is lost in
 * representation (Units or Requirements missing) from what is lost in
 * ranking.
 *
 *   npm run eval:fixed-inputs -- --records <dir...> \
 *     --units record|gold|<corrections.json> --requirements record|gold|<corrections.json> \
 *     [--scorer current,renormalized,cosine] [--k 24] [--embeddings-cache <file>] \
 *     [--out <dir>] [--max-usd 0.10] [--dry-run]
 *
 * For each recorded flow it builds the 2×2 {record, --units} × {record,
 * --requirements} (collapsed when a side is `record`), embeds every text
 * through a per-text disk cache (embeddingCache.ts), runs
 * `runMatchingPipeline` unchanged with the chosen scorer injected through
 * `MatchingDeps.score`, maps Units and Requirements to label ids, and
 * prints match accuracy per condition and per cell plus the A/B/C
 * decomposition of missed pairs.
 *
 * No LLM call. The only paid call is the embedding of texts the cache
 * does not hold: it is priced before any request and refused above
 * `--max-usd`; `--dry-run` prints the plan and estimate without
 * constructing a client. A fully cached run needs no key.
 *
 * Match-accuracy numbers from this runner are diagnostic until the labels
 * and owner corrections are reviewed (#636).
 *
 * Exit codes: 0 ok (or dry run); 1 refused (budget, missing key, or an
 * unlisted corrections file); 2 usage error or crash.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openaiForCli, type OpenAIClient as OpenAI } from "../../../functions/src/llm/openai.ts";
import type { ExperienceUnit, JobRequirementUnit } from "../../../functions/src/types/capability.ts";

import { flowIdentity, loadFlows } from "../analyze.ts";
import { repoRoot } from "../fitBrief/corpus.ts";
import type { FlowRecord } from "../flowRecord.ts";
import {
  loadExpectedMatches,
  loadExpectedUnits,
  type ExpectedMatchesFile,
  type ExpectedUnit,
  type FixturePaths,
} from "../loadFixtures.ts";
import { assertRecordDirOutsideRepo } from "../recorder.ts";

import { parseFixedInputArgs, type FixedInputArgs, type SideArg } from "./args.ts";
import {
  applyRequirementCorrections,
  applyUnitCorrections,
  loadCorrections,
  loadManifest,
  resolveSourceFlow,
  type LoadedCorrections,
  type Side,
} from "./corrections.ts";
import { defaultEmbeddingCachePath, EmbeddingCache, EmbeddingRefusal, type FillResult } from "./embeddingCache.ts";
import { decompose, evaluateMatches, runMatch } from "./evaluate.ts";
import {
  buildConditions,
  recordRequirements,
  recordUnits,
  textsToEmbed,
  type Condition,
  type InputSet,
} from "./inputs.ts";
import {
  formatFixedInputsMarkdown,
  formatPlan,
  type CorrectionReport,
  type FixedInputsResult,
  type FlowResult,
  type ScoredCell,
} from "./report.ts";
import { SCORERS, type ScorerName } from "./scorers.ts";

export const RESULT_FILE = "fixed-inputs.json";
export const REPORT_FILE = "report.md";

export interface FixedInputsDeps {
  /** Repository root for the in-repo refusals (tests pass a tmp repo). */
  readonly root?: string;
  readonly fixturesDir?: string;
  /** Corrections manifest (tests only; the CLI always uses the in-repo one). */
  readonly manifestPath?: string;
  /** Builds the OpenAI client; called only when texts are uncached and the run is live. */
  readonly openaiClient?: () => OpenAI;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly argv?: readonly string[];
}

export interface FixedInputsOutcome {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
  readonly result?: FixedInputsResult;
  readonly written?: { readonly json: string; readonly markdown: string };
}

/** A refusal: exit 1 with a message, nothing spent past this point. */
class Refusal extends Error {}

interface WorkItem {
  readonly flow: FlowRecord;
  readonly expectedUnits: readonly ExpectedUnit[];
  readonly expectedMatches: ExpectedMatchesFile;
  readonly conditions: readonly Condition[];
}

interface CorrectedSide {
  readonly corrections: LoadedCorrections;
  readonly flow: FlowRecord;
  readonly report: CorrectionReport;
  readonly set: InputSet;
}

function labelsExist(fixturesDir: string, flow: FlowRecord): boolean {
  return (
    existsSync(join(fixturesDir, "expected-units", `${flow.resumeId}.json`)) &&
    existsSync(join(fixturesDir, "expected-matches", `${flow.cell}.json`))
  );
}

function correctSide(
  side: Side,
  loaded: readonly LoadedCorrections[],
  flows: readonly FlowRecord[],
): Map<string, CorrectedSide> {
  const out = new Map<string, CorrectedSide>();
  for (const c of loaded) {
    if (out.has(c.cell)) throw new Error(`--${side} names two corrections files for cell ${c.cell}`);
    const flow = resolveSourceFlow(flows, c, side);
    const items = c.file[side]!;
    const sourceFlow = { invocationId: flow.invocationId, variant: flow.variant, sampleIndex: flow.sampleIndex };
    if (side === "units") {
      const applied = applyUnitCorrections(items, recordUnits(flow), c.path);
      out.set(c.cell, {
        corrections: c,
        flow,
        set: { kind: "corrected", units: applied.items },
        report: { side, path: c.path, name: c.name, sha256: c.sha256, cell: c.cell, sourceFlow, provenance: applied.provenance },
      });
    } else {
      const source = recordRequirements(flow);
      const applied = applyRequirementCorrections(items, source, c.path);
      const byId = new Map(source.map((q) => [q.id, q]));
      const overrides = applied.items.flatMap((q) => {
        const before = byId.get(q.id);
        if (before === undefined) return [];
        const o = {
          id: q.id,
          ...(q.normalized_requirement !== before.normalized_requirement && { normalized_requirement: q.normalized_requirement }),
          ...(q.must_have !== before.must_have && { must_have: q.must_have }),
        };
        return Object.keys(o).length > 1 ? [o] : [];
      });
      out.set(c.cell, {
        corrections: c,
        flow,
        set: { kind: "corrected", requirements: applied.items },
        report: {
          side,
          path: c.path,
          name: c.name,
          sha256: c.sha256,
          cell: c.cell,
          sourceFlow,
          provenance: applied.provenance,
          overrides,
        },
      });
    }
  }
  return out;
}

function sideSet(arg: SideArg): InputSet {
  return { kind: arg.kind === "gold" ? "gold" : "record" };
}

function withEmbeddings<T extends { embedding?: number[] }>(items: readonly T[], text: (x: T) => string, cache: EmbeddingCache): T[] {
  return items.map((x) => {
    const v = cache.get(text(x));
    if (v === undefined) throw new Error(`internal: no embedding for ${JSON.stringify(text(x).slice(0, 60))}`);
    return { ...x, embedding: [...v] };
  });
}

export async function runFixedInputs(args: FixedInputArgs, deps: FixedInputsDeps = {}): Promise<FixedInputsOutcome> {
  const stderr: string[] = [];
  try {
    return await runInner(args, deps, stderr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof Refusal || err instanceof EmbeddingRefusal ? 1 : 2;
    stderr.push(`eval:fixed-inputs ${code === 1 ? "refused" : "failed"}: ${message}`);
    return { code, stdout: "", stderr: stderr.join("\n") };
  }
}

async function runInner(args: FixedInputArgs, deps: FixedInputsDeps, stderr: string[]): Promise<FixedInputsOutcome> {
  const root = deps.root ?? repoRoot();
  const fixturesDir = deps.fixturesDir ?? join(repoRoot(), "tests", "fixtures");
  const paths: FixturePaths = { fixturesDir };
  const env = deps.env ?? process.env;

  // Output and cache locations are validated before anything is read or spent.
  let outDir: string | undefined;
  if (args.out !== undefined) {
    assertRecordDirOutsideRepo(args.out, "--out", root);
    outDir = resolve(args.out);
    for (const f of [RESULT_FILE, REPORT_FILE]) {
      if (existsSync(join(outDir, f))) throw new Error(`--out ${args.out} already holds ${f}; use a fresh directory`);
    }
  }
  const cachePath = args.embeddingsCache ?? defaultEmbeddingCachePath();
  const cache = EmbeddingCache.load(cachePath, { root });

  const allFlows = loadFlows(args.records);

  // Owner-corrected sides: accepted only by manifest hash.
  const manifest =
    args.units.kind === "corrections" || args.requirements.kind === "corrections" ? loadManifest(deps.manifestPath) : undefined;
  const load = (arg: SideArg): LoadedCorrections[] => {
    if (arg.kind !== "corrections") return [];
    try {
      return arg.paths.map((p) => loadCorrections(p, manifest!));
    } catch (err) {
      throw new Refusal(err instanceof Error ? err.message : String(err));
    }
  };
  const unitCorrections = correctSide("units", load(args.units), allFlows);
  const reqCorrections = correctSide("requirements", load(args.requirements), allFlows);

  // Which flows run, and with which alternatives.
  const skipped = new Map<string, string[]>();
  const skip = (reason: string, f: FlowRecord): void => {
    skipped.set(reason, [...(skipped.get(reason) ?? []), `${f.variant} ${f.cell} #${f.sampleIndex}`]);
  };
  const planned: Array<{ flow: FlowRecord; units: InputSet; requirements: InputSet }> = [];
  if (unitCorrections.size > 0 || reqCorrections.size > 0) {
    if (unitCorrections.size > 0 && reqCorrections.size > 0) {
      const a = [...unitCorrections.keys()].sort().join(",");
      const b = [...reqCorrections.keys()].sort().join(",");
      if (a !== b) throw new Error(`--units and --requirements corrections cover different cells (${a} vs ${b})`);
    }
    const cells = new Set([...unitCorrections.keys(), ...reqCorrections.keys()]);
    for (const cell of [...cells].sort()) {
      const u = unitCorrections.get(cell);
      const r = reqCorrections.get(cell);
      if (u !== undefined && r !== undefined && flowIdentity(u.flow) !== flowIdentity(r.flow)) {
        throw new Error(
          `${cell}: the --units corrections come from ${flowIdentity(u.flow)} but the --requirements corrections ` +
            `from ${flowIdentity(r.flow)}; both sides must correct the same flow`,
        );
      }
      planned.push({
        flow: (u ?? r)!.flow,
        units: u?.set ?? sideSet(args.units),
        requirements: r?.set ?? sideSet(args.requirements),
      });
    }
  } else {
    for (const flow of allFlows) {
      if (flow.units === null || flow.requirements === null) {
        skip("saved no Units or no Requirements (an upstream stage failed)", flow);
        continue;
      }
      planned.push({ flow, units: sideSet(args.units), requirements: sideSet(args.requirements) });
    }
  }
  const work: WorkItem[] = [];
  for (const p of planned) {
    if (!labelsExist(fixturesDir, p.flow)) {
      skip(`no labels for the cell under ${fixturesDir} (expected-units and expected-matches)`, p.flow);
      continue;
    }
    const expectedUnits = loadExpectedUnits(p.flow.resumeId, paths).expected_units;
    const expectedMatches = loadExpectedMatches(p.flow.resumeId, p.flow.jdId, paths);
    const conditions = buildConditions(
      { units: recordUnits(p.flow), requirements: recordRequirements(p.flow) },
      { units: p.units, requirements: p.requirements },
      { expectedUnits, expectedMatches },
    );
    work.push({ flow: p.flow, expectedUnits, expectedMatches, conditions });
  }
  if (work.length === 0) throw new Error("no flow to run: every flow in --records was skipped");

  const conditionNames = [...new Set(work.flatMap((w) => w.conditions.map((c) => c.name)))];
  const texts = work.flatMap((w) => textsToEmbed(w.conditions));
  const plan = cache.plan(texts);
  const planSummary = {
    model: plan.model,
    uniqueTexts: plan.uniqueTexts,
    cachedTexts: plan.cachedTexts,
    uncachedTexts: plan.uncached.length,
    estimatedTokens: plan.estimatedTokens,
    estimatedUsd: plan.estimatedUsd,
  };
  const corrections = [...unitCorrections.values(), ...reqCorrections.values()].map((c) => c.report);
  const skippedList = [...skipped].map(([reason, flows]) => ({ reason, flows }));
  const planText = formatPlan(planSummary, {
    flows: work.length,
    conditions: conditionNames,
    scorers: args.scorers,
    cachePath: cache.path,
    maxUsd: args.maxUsd,
    corrections,
    skipped: skippedList,
  });

  if (args.dryRun) {
    const verdict =
      plan.uncached.length === 0
        ? "Every text is cached: a live run makes no request and needs no key."
        : plan.estimatedUsd > args.maxUsd
          ? `A live run would refuse: the estimate exceeds --max-usd $${args.maxUsd}.`
          : `A live run would embed ${plan.uncached.length} text(s) and needs OPENAI_API_KEY.`;
    return { code: 0, stdout: `# Fixed-input matching runner (#648): dry run\n\n${planText}\n\n${verdict}\n`, stderr: "" };
  }

  let fill: FillResult | null = null;
  if (plan.uncached.length > 0) {
    if (plan.estimatedUsd > args.maxUsd) {
      throw new Refusal(
        `${plan.uncached.length} uncached text(s) are estimated at $${plan.estimatedUsd.toFixed(6)}, above --max-usd $${args.maxUsd}. ` +
          "No request was sent. Raise --max-usd or narrow --records.",
      );
    }
    const factory =
      deps.openaiClient ??
      ((): OpenAI => {
        const key = env.OPENAI_API_KEY;
        if (typeof key !== "string" || key === "") {
          throw new Refusal(
            `${plan.uncached.length} text(s) are uncached; export OPENAI_API_KEY or seed the cache at ${cache.path}. No request was sent.`,
          );
        }
        return openaiForCli();
      });
    fill = await cache.fill(texts, { client: factory(), maxUsd: args.maxUsd });
    stderr.push(
      `Embedded ${fill.embedded} text(s) in ${fill.requests} request(s): ${fill.inputTokens} tokens, $${fill.usd.toFixed(6)}; cached at ${cache.path}`,
    );
  }

  const flows: FlowResult[] = [];
  for (const w of work) {
    const asOf = new Date(w.flow.finishedAt);
    const conditions: Record<string, Partial<Record<ScorerName, ScoredCell>>> = {};
    for (const c of w.conditions) {
      const units = withEmbeddings<ExperienceUnit>(c.units, (u) => u.normalized_summary, cache);
      const reqs = withEmbeddings<JobRequirementUnit>(c.requirements, (q) => q.normalized_requirement, cache);
      const byScorer: Partial<Record<ScorerName, ScoredCell>> = {};
      for (const s of args.scorers) {
        const matches = await runMatch(units, reqs, asOf, SCORERS[s]);
        const ev = evaluateMatches(matches, c.unitMap, c.requirementMap, w.expectedMatches, args.k);
        byScorer[s] = {
          accuracy: ev.accuracy,
          matchCount: matches.length,
          decomposition: decompose(ev.composites, c.unitMap, c.requirementMap, w.expectedMatches, args.k),
        };
      }
      conditions[c.name] = byScorer;
    }
    flows.push({
      arm: w.flow.variant,
      invocationId: w.flow.invocationId,
      cell: w.flow.cell,
      sampleIndex: w.flow.sampleIndex,
      asOf: w.flow.finishedAt,
      recordMatchAccuracy: w.flow.matchAccuracy,
      recordMatchCount: w.flow.matchCount ?? null,
      unitCount: w.conditions[0]!.units.length,
      requirementCount: w.conditions[0]!.requirements.length,
      conditions,
    });
  }

  const result: FixedInputsResult = {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    argv: [...(deps.argv ?? [])],
    metric: args.k === undefined ? "match accuracy (labelled pairs in the label's top k, the eval's topKOverlap)" : `recall@${args.k}`,
    k: args.k ?? null,
    scorers: args.scorers,
    conditions: conditionNames,
    cachePath: cache.path,
    plan: planSummary,
    fill,
    skipped: skippedList,
    corrections,
    flows,
  };
  const markdown = formatFixedInputsMarkdown(result, args.maxUsd);
  let written: FixedInputsOutcome["written"];
  if (outDir !== undefined) {
    mkdirSync(outDir, { recursive: true });
    const json = join(outDir, RESULT_FILE);
    const md = join(outDir, REPORT_FILE);
    writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    writeFileSync(md, markdown, { encoding: "utf8", flag: "wx" });
    written = { json, markdown: md };
    stderr.push(`Wrote ${json} and ${md}`);
  }
  return { code: 0, stdout: markdown, stderr: stderr.join("\n"), result, ...(written !== undefined && { written }) };
}

const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  const argv = process.argv.slice(2);
  let args: FixedInputArgs;
  try {
    args = parseFixedInputArgs(argv);
  } catch (err) {
    console.error(`eval:fixed-inputs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  runFixedInputs(args, { argv })
    .then((outcome) => {
      if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
      if (outcome.stderr !== "") console.error(outcome.stderr);
      process.exit(outcome.code);
    })
    .catch((err) => {
      console.error("eval:fixed-inputs failed:", err);
      process.exit(2);
    });
}
