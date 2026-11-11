/**
 * `npm run eval -- --extraction-only` (#648): run extraction alone over
 * every labelled résumé in `tests/fixtures/`, with no JD parsing,
 * embedding or matching.
 *
 * - Labelled résumé = `resumes/<id>.txt` with `expected-units/<id>.json`.
 *   The set is read from the fixtures, not hard-coded. A résumé without
 *   a label is listed as skipped; a label without a résumé is an error.
 * - Each flow is one extraction sample through `runExtractionForFixture`
 *   (the full flow's extraction stage, cache key and cost plumbing).
 * - Per flow the printed metrics are `analysis/metrics.ts`
 *   `extractionMetrics` on the same flow record `--record` writes:
 *   extraction accuracy, Unit precision, extracted-Unit count, summary
 *   tokens and grounding share. So the table equals what
 *   `eval:analyze --task extraction` computes from the records later.
 * - Records: the cell is `<resumeId>__extraction-only`, with the
 *   sentinel JD id `EXTRACTION_ONLY_JD_ID`; `matchAccuracy`,
 *   `matchCount` and `requirements` are null, and `stages` lists only
 *   `extraction`. `eval:analyze --task extraction` reads them (labels are
 *   keyed by résumé). Their cells never overlap a full-flow arm's
 *   (`<resumeId>__<jdId>`), so compare extraction-only arms with each
 *   other.
 * - Projection guard: checked BEFORE any flow runs, on résumés ×
 *   samples × max(1, variants).
 * - Variants may set only extraction knobs: a requirement-parsing model,
 *   effort or `parsing/jd` prompt would change nothing here and is
 *   refused, as is a command-wide `--prompt parsing/jd=`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AnthropicClient as Anthropic } from "../../functions/src/llm/anthropic.ts";
import type { OpenAIClient as OpenAI } from "../../functions/src/llm/openai.ts";

import type { StageCache } from "./cache.ts";
import { buildFlowRecord, type FlowRecord } from "./flowRecord.ts";
import { newFlowTrace } from "./flowTrace.ts";
import { extractionMetrics, type MetricValues } from "./analysis/metrics.ts";
import { loadExpectedUnits, loadResumeText, type FixturePaths } from "./loadFixtures.ts";
import { checkCaps, DEFAULT_CAPS, shouldBlock, type CapCheck } from "./projection.ts";
import { DEFAULT_VARIANT_LABEL, recordingRunner, type FlowRecorder, type FlowRunner } from "./recorder.ts";
import { EXTRACTION_ONLY_JD_ID, runExtractionForFixture, type RunForFixtureResult } from "./runForFixture.ts";
import { assertPromptSchemasCompatible, assertPromptsExist, runVariant, type SweepVariant } from "./sweep.ts";

export { EXTRACTION_ONLY_JD_ID };

export const EXTRACTION_ONLY_MODE = "extraction-only";

function listIds(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith(".") && d.name.endsWith(ext) && d.name.toLowerCase() !== `readme${ext}`)
      .map((d) => d.name.slice(0, -ext.length))
      .sort();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

/** Résumés with an extraction label, sorted; résumés without one. Throws on a label with no résumé. */
export function enumerateLabeledResumes(fixturesDir: string): { labeled: string[]; unlabeled: string[] } {
  const resumes = listIds(join(fixturesDir, "resumes"), ".txt");
  const labels = new Set(listIds(join(fixturesDir, "expected-units"), ".json"));
  const orphans = [...labels].filter((id) => !resumes.includes(id));
  if (orphans.length > 0) {
    throw new Error(
      `expected-units label(s) without a résumé fixture: ${orphans.join(", ")} (looked in ${join(fixturesDir, "resumes")})`,
    );
  }
  return { labeled: resumes.filter((id) => labels.has(id)), unlabeled: resumes.filter((id) => !labels.has(id)) };
}

/** Refuse when a fixture would collide with the sentinel JD id. */
export function assertNoSentinelCollision(fixturesDir: string): void {
  const hits = [
    ...(existsSync(join(fixturesDir, "jds", `${EXTRACTION_ONLY_JD_ID}.txt`)) ? [`jds/${EXTRACTION_ONLY_JD_ID}.txt`] : []),
    ...listIds(join(fixturesDir, "expected-matches"), ".json")
      .filter((id) => id.endsWith(`__${EXTRACTION_ONLY_JD_ID}`))
      .map((id) => `expected-matches/${id}.json`),
  ];
  if (hits.length > 0) {
    throw new Error(
      `fixture(s) ${hits.join(", ")} collide with the extraction-only sentinel JD id ${JSON.stringify(EXTRACTION_ONLY_JD_ID)}; ` +
        "rename them so extraction-only records cannot be read as a labelled cell.",
    );
  }
}

/** The record an extraction-only flow writes: no match fields, no parsing stage. */
export function extractionOnlyAdjust(record: FlowRecord): FlowRecord {
  const { requirement_parsing: _parsing, ...stages } = record.stages;
  return { ...record, stages, matchAccuracy: null, matchCount: null };
}

/** Refuse knobs extraction-only cannot exercise. */
export function assertExtractionOnlyVariants(
  variants: readonly SweepVariant[],
  promptOverrides: Readonly<Record<string, string>>,
): void {
  const problems: string[] = [];
  if (promptOverrides["parsing/jd"] !== undefined) problems.push("--prompt parsing/jd=… (no JD is parsed)");
  for (const v of variants) {
    if (v.models?.requirement_parsing !== undefined) problems.push(`${v.label}: model.requirement_parsing`);
    if (v.efforts?.requirement_parsing !== undefined) problems.push(`${v.label}: effort.requirement_parsing`);
    if (v.promptVersions?.["parsing/jd"] !== undefined) problems.push(`${v.label}: prompt.parsing/jd`);
  }
  if (problems.length > 0) {
    throw new Error(
      `--extraction-only runs no requirement parsing, so these would change nothing while appearing in the arm: ${problems.join("; ")}`,
    );
  }
}

export interface PlannedSpend {
  readonly anthropicUsd: number;
  readonly openaiUsd: number;
  readonly firebaseUsd: number;
}

export interface ExtractionOnlyOptions {
  readonly fixturesDir: string;
  readonly samples: number;
  readonly variants: readonly SweepVariant[];
  readonly promptOverrides: Readonly<Record<string, string>>;
  readonly tokenSource: string;
  /** Planned spend for N flows, priced before any flow runs. Extraction only: no OpenAI spend. */
  readonly estimate: (flowCount: number) => PlannedSpend;
  readonly recorder?: FlowRecorder;
  readonly cache?: StageCache;
  readonly cacheDiscriminators?: Readonly<Record<string, string | number>>;
}

export interface ExtractionOnlyDeps {
  readonly anthropicClient: Anthropic;
  readonly anthropicIsMetered: boolean;
  /** Defaults to `runExtractionForFixture`. */
  readonly run?: FlowRunner;
}

export interface ExtractionFlow {
  readonly variant: string;
  readonly resumeId: string;
  readonly result: RunForFixtureResult;
  readonly record: FlowRecord;
  /** Null when extraction did not return Units. */
  readonly metrics: MetricValues | null;
}

export interface ExtractionOnlyOutcome {
  readonly code: 0 | 1;
  readonly stdout: string;
  readonly stderr: string;
  readonly flows: readonly ExtractionFlow[];
  readonly capChecks: readonly CapCheck[];
}

/** A stand-in OpenAI client that throws if called: extraction-only never embeds. */
const NO_OPENAI = {
  embeddings: {
    create: (): never => {
      throw new Error("extraction-only must not call OpenAI");
    },
  },
} as unknown as OpenAI;

const PRINTED: ReadonlyArray<readonly [string, string, boolean]> = [
  ["extraction_accuracy", "extraction accuracy", true],
  ["unit_precision", "Unit precision", true],
  ["extracted_unit_count", "extracted Units", false],
  ["summary_tokens", "summary tokens", false],
  ["grounding_share", "grounding share", true],
];

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function fmt(v: number | null, share: boolean): string {
  if (v === null) return "–";
  return share ? (100 * v).toFixed(1) : v.toFixed(1);
}

/** Mean of metric `id` over a résumé's flows that returned Units. */
function resumeMean(flows: readonly ExtractionFlow[], id: string): number | null {
  return mean(flows.map((f) => f.metrics?.[id]).filter((v): v is number => typeof v === "number"));
}

export function formatExtractionOnlyMarkdown(flows: readonly ExtractionFlow[], unlabeled: readonly string[]): string {
  const out: string[] = [
    "# Extraction-only eval (#648)",
    "",
    "Extraction alone over every labelled résumé: no JD parsing, embedding or matching. Metrics are `extractionMetrics` (as `eval:analyze --task extraction`), averaged over the flows that returned Units; the aggregate is the equal-weight mean of résumé means.",
  ];
  if (unlabeled.length > 0) out.push("", `Skipped (no expected-units label): ${unlabeled.join(", ")}.`);
  const variants = [...new Set(flows.map((f) => f.variant))];
  for (const variant of variants) {
    const vf = flows.filter((f) => f.variant === variant);
    const resumes = [...new Set(vf.map((f) => f.resumeId))];
    out.push("", `## ${variant}`, "");
    out.push(`| résumé | flows | failed | ${PRINTED.map(([, label]) => label).join(" | ")} |`);
    out.push(`| --- | --- | --- | ${PRINTED.map(() => "---").join(" | ")} |`);
    const perResume = new Map<string, Map<string, number | null>>();
    for (const r of resumes) {
      const rf = vf.filter((f) => f.resumeId === r);
      const means = new Map(PRINTED.map(([id]) => [id, resumeMean(rf, id)]));
      perResume.set(r, means);
      out.push(
        `| ${r} | ${rf.length} | ${rf.filter((f) => !f.result.ok).length} | ${PRINTED.map(([id, , share]) => fmt(means.get(id)!, share)).join(" | ")} |`,
      );
    }
    const agg = PRINTED.map(([id, , share]) =>
      fmt(mean([...perResume.values()].map((m) => m.get(id)).filter((v): v is number => typeof v === "number")), share),
    );
    out.push(
      `| **all (${resumes.length})** | ${vf.length} | ${vf.filter((f) => !f.result.ok).length} | ${agg.map((a) => `**${a}**`).join(" | ")} |`,
    );
    const failures = vf.filter((f) => !f.result.ok);
    for (const f of failures.slice(0, 5)) out.push("", `- failed ${f.resumeId}: ${f.result.error ?? "unknown error"}`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Run extraction-only. Refuses (code 1, nothing run) when the projection
 * exceeds a monthly cap. Exit 1 too when every flow failed.
 */
export async function runExtractionOnly(opts: ExtractionOnlyOptions, deps: ExtractionOnlyDeps): Promise<ExtractionOnlyOutcome> {
  assertNoSentinelCollision(opts.fixturesDir);
  assertExtractionOnlyVariants(opts.variants, opts.promptOverrides);
  assertPromptsExist(opts.variants, opts.promptOverrides);
  assertPromptSchemasCompatible(opts.variants, opts.promptOverrides);
  const { labeled, unlabeled } = enumerateLabeledResumes(opts.fixturesDir);
  if (labeled.length === 0) throw new Error(`no labelled résumé under ${opts.fixturesDir} (resumes/<id>.txt + expected-units/<id>.json)`);
  const paths: FixturePaths = { fixturesDir: opts.fixturesDir };

  const flowCount = labeled.length * opts.samples * Math.max(1, opts.variants.length);
  const capChecks = checkCaps({ anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 }, opts.estimate(flowCount), DEFAULT_CAPS);
  if (shouldBlock(capChecks)) {
    return {
      code: 1,
      stdout: "",
      stderr:
        `Refusing --extraction-only: ${labeled.length} résumé(s) x ${opts.samples} sample(s) x ` +
        `${Math.max(1, opts.variants.length)} arm(s) = ${flowCount} flows, and the projection exceeds a monthly cap. ` +
        "Reduce --samples or --variant count, or use --token-source claude-cli. Nothing ran.",
      flows: [],
      capChecks,
    };
  }

  const labels = new Map(
    labeled.map((id) => [id, { expectedUnits: loadExpectedUnits(id, paths).expected_units, resumeText: loadResumeText(id, paths) }]),
  );
  const base = deps.run ?? runExtractionForFixture;
  const flows: ExtractionFlow[] = [];
  let currentVariant = DEFAULT_VARIANT_LABEL;
  // Ensure every flow has a trace (the recorder supplies its own when recording),
  // so the printed metrics come from the same record `--record` writes.
  const capture: FlowRunner = async (input, runDeps) => {
    const trace = runDeps.trace ?? newFlowTrace();
    const result = await base(input, { ...runDeps, trace });
    const now = new Date().toISOString();
    const record = extractionOnlyAdjust(
      buildFlowRecord(
        {
          invocationId: opts.recorder?.invocationId ?? "unrecorded",
          variant: currentVariant,
          stages: {},
          embeddingModel: "n/a",
          resumeId: input.resumeFixtureId,
          jdId: input.jdFixtureId,
          sampleIndex: 0,
          startedAt: now,
          finishedAt: now,
        },
        result,
        trace,
      ),
    );
    const label = labels.get(input.resumeFixtureId)!;
    flows.push({
      variant: currentVariant,
      resumeId: input.resumeFixtureId,
      result,
      record,
      metrics: record.units === null ? null : extractionMetrics(record, label),
    });
    return result;
  };
  const runFlow = recordingRunner(opts.recorder, opts.tokenSource, capture, { adjust: extractionOnlyAdjust });

  const runCorpus = async (variant: { readonly label: string; readonly tokenSource?: string }): Promise<RunForFixtureResult[]> => {
    currentVariant = variant.label;
    opts.recorder?.setVariant(variant.label, variant.tokenSource);
    const out: RunForFixtureResult[] = [];
    for (const resumeFixtureId of labeled) {
      for (let i = 0; i < opts.samples; i++) {
        out.push(
          await runFlow(
            { resumeFixtureId, jdFixtureId: EXTRACTION_ONLY_JD_ID },
            {
              anthropicClient: deps.anthropicClient,
              anthropicIsMetered: deps.anthropicIsMetered,
              openaiClient: NO_OPENAI,
              fixturePaths: paths,
              ...(opts.cache !== undefined && { cache: opts.cache }),
              ...(opts.cacheDiscriminators !== undefined && { cacheDiscriminators: opts.cacheDiscriminators }),
            },
          ),
        );
      }
    }
    return out;
  };

  if (opts.variants.length === 0) {
    await runCorpus({ label: DEFAULT_VARIANT_LABEL });
  } else {
    for (const variant of opts.variants) {
      await runVariant(variant, { runCorpus }, { basePromptVersions: opts.promptOverrides });
    }
  }

  const stdout = formatExtractionOnlyMarkdown(flows, unlabeled);
  const ok = flows.filter((f) => f.result.ok).length;
  if (ok === 0) {
    return {
      code: 1,
      stdout,
      stderr: `Extraction-only produced no usable measurements: all ${flows.length} flow(s) failed. Check credentials, the cache and the token source.`,
      flows,
      capChecks,
    };
  }
  return { code: 0, stdout, stderr: "", flows, capChecks };
}
