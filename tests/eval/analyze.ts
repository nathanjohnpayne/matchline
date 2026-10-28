#!/usr/bin/env -S tsx
/**
 * `npm run eval:analyze` — compare recorded arms against an incumbent.
 *
 *   npm run eval:analyze -- --records <dir>... --task extraction|jd \
 *     --incumbent <label> [--candidates a,b] [--out <dir>] [--seed N] \
 *     [--fixtures <dir>]
 *
 * Reads `<dir>/flows.jsonl` from each `--record` directory (a path to a
 * `.jsonl` file works too), pools flows by variant label, scores the
 * saved Units or Requirements against the public labels under
 * `tests/fixtures/`, prints Markdown, and writes the full result to
 * `<out>/analysis-<task>.json`. `--out` defaults to the first records
 * directory and must resolve outside the repository.
 *
 * Makes no model call and needs no key.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeRecords, formatAnalysisMarkdown, type AnalysisLabels } from "./analysis/analyzeRecords.ts";
import type { ExtractionLabels, JdLabels, Task } from "./analysis/metrics.ts";
import { DEFAULT_SEED } from "./analysis/stats.ts";
import { parseFlowsJsonl, type FlowRecord } from "./flowRecord.ts";
import { loadExpectedMatches, loadExpectedUnits, loadResumeText, type FixturePaths } from "./loadFixtures.ts";
import { assertRecordDirOutsideRepo, FLOWS_FILE } from "./recorder.ts";

export interface AnalyzeArgs {
  readonly records: readonly string[];
  readonly task: Task;
  readonly incumbent: string;
  readonly candidates?: readonly string[];
  readonly out?: string;
  readonly seed: number;
  readonly fixtures?: string;
}

const VALUE_FLAGS = new Set(["--records", "--task", "--incumbent", "--candidates", "--out", "--seed", "--fixtures"]);

/** Parse argv. A closed flag set: anything unknown is refused. */
export function parseAnalyzeArgs(argv: readonly string[]): AnalyzeArgs {
  const records: string[] = [];
  const single = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag ${JSON.stringify(arg)}`);
    const values: string[] = [];
    if (eq !== -1) {
      values.push(arg.slice(eq + 1));
    } else if (name === "--records") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) values.push(argv[++i]!);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      values.push(argv[++i]!);
    }
    if (values.length === 0 || values.some((v) => v === "")) throw new Error(`${name} requires a value`);
    if (name === "--records") {
      records.push(...values);
    } else {
      if (single.has(name)) throw new Error(`${name} given more than once`);
      single.set(name, values[0]!);
    }
  }
  if (records.length === 0) throw new Error("--records requires at least one directory");
  const task = single.get("--task");
  if (task !== "extraction" && task !== "jd") throw new Error("--task must be extraction|jd");
  const incumbent = single.get("--incumbent");
  if (incumbent === undefined) throw new Error("--incumbent is required");
  const candidatesRaw = single.get("--candidates");
  const candidates = candidatesRaw?.split(",").map((c) => c.trim()).filter((c) => c.length > 0);
  if (candidatesRaw !== undefined && (candidates === undefined || candidates.length === 0)) {
    throw new Error("--candidates requires at least one label");
  }
  const seedRaw = single.get("--seed");
  const seed = seedRaw === undefined ? DEFAULT_SEED : Number(seedRaw);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("--seed must be an integer in [0, 2^32)");
  return {
    records,
    task,
    incumbent,
    ...(candidates !== undefined && { candidates }),
    ...(single.has("--out") && { out: single.get("--out")! }),
    seed,
    ...(single.has("--fixtures") && { fixtures: single.get("--fixtures")! }),
  };
}

/** `<dir>/flows.jsonl`, or the path itself when it names a file. */
export function flowsPath(record: string): string {
  const abs = resolve(record);
  return existsSync(abs) && statSync(abs).isFile() ? abs : join(abs, FLOWS_FILE);
}

/**
 * A flow's identity: one invocation's one sample of one (variant, cell).
 * Two records with the same identity are the same observation, so pooling
 * them would count it twice.
 */
export function flowIdentity(f: Pick<FlowRecord, "invocationId" | "variant" | "cell" | "sampleIndex">): string {
  return `${f.invocationId} ${f.variant} ${f.cell} #${f.sampleIndex}`;
}

/**
 * Load every flow named by `--records`. Refuses a flow identity that appears
 * more than once across the inputs (the same directory passed twice, a
 * directory plus its own `flows.jsonl`, or a copied record file): the replay
 * filter cannot catch it, since a live flow keeps its live flags, and one
 * observation counted twice satisfies the two-sample guard and narrows every
 * interval.
 */
export function loadFlows(records: readonly string[]): FlowRecord[] {
  const flows = records.flatMap((r) => {
    const path = flowsPath(r);
    if (!existsSync(path)) throw new Error(`${r}: no ${FLOWS_FILE} found (looked for ${path})`);
    return parseFlowsJsonl(readFileSync(path, "utf8"), path);
  });
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const f of flows) {
    const id = flowIdentity(f);
    if (seen.has(id)) duplicates.push(id);
    else seen.add(id);
  }
  if (duplicates.length > 0) {
    const shown = [...new Set(duplicates)].slice(0, 5).join("; ");
    const more = duplicates.length > 5 ? ` and ${duplicates.length - 5} more` : "";
    throw new Error(
      `--records holds the same flow more than once (invocationId variant cell #sampleIndex): ${shown}${more}. ` +
        "Each invocation's records may be passed once; a repeated flow would be counted as a new observation.",
    );
  }
  return flows;
}

/**
 * Load the public labels every scored flow of the analyzed arms needs:
 * each flow whose task stage returned (Units for extraction, Requirements
 * for jd), whether or not a later stage failed.
 */
export function loadLabels(flows: readonly FlowRecord[], task: Task, paths?: FixturePaths): AnalysisLabels {
  const scored = flows.filter((f) => (task === "extraction" ? f.units !== null : f.requirements !== null));
  if (task === "extraction") {
    const units = new Map<string, ExtractionLabels>();
    for (const id of [...new Set(scored.map((f) => f.resumeId))].sort()) {
      units.set(id, {
        expectedUnits: loadExpectedUnits(id, paths).expected_units,
        resumeText: loadResumeText(id, paths),
      });
    }
    return { units };
  }
  const requirements = new Map<string, JdLabels>();
  for (const f of scored) {
    if (requirements.has(f.cell)) continue;
    requirements.set(f.cell, { expectedRequirements: loadExpectedMatches(f.resumeId, f.jdId, paths).expected_requirements });
  }
  return { requirements };
}

export function runAnalyze(args: AnalyzeArgs, options: { readonly root?: string } = {}): { markdown: string; jsonPath: string } {
  const outDir = resolve(args.out ?? dirname(flowsPath(args.records[0]!)));
  assertRecordDirOutsideRepo(outDir, "--out", options.root);
  const flows = loadFlows(args.records);
  const arms = new Set([args.incumbent, ...(args.candidates ?? [...new Set(flows.map((f) => f.variant))])]);
  const paths = args.fixtures === undefined ? undefined : { fixturesDir: resolve(args.fixtures) };
  const labels = loadLabels(
    flows.filter((f) => arms.has(f.variant)),
    args.task,
    paths,
  );
  const result = analyzeRecords(flows, {
    task: args.task,
    incumbent: args.incumbent,
    ...(args.candidates !== undefined && { candidates: args.candidates }),
    labels,
    seed: args.seed,
  });
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `analysis-${args.task}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { markdown: formatAnalysisMarkdown(result), jsonPath };
}

const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  try {
    const { markdown, jsonPath } = runAnalyze(parseAnalyzeArgs(process.argv.slice(2)));
    console.log(markdown);
    console.error(`\nWrote ${jsonPath}`);
  } catch (err) {
    console.error(`eval:analyze failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
