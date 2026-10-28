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

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { AnthropicClient as Anthropic } from "../../../functions/src/llm/anthropic.ts";

import { extractFromResume } from "../../../functions/src/extraction/resume.ts";
import { anthropicForCli } from "../../../functions/src/llm/anthropic.ts";
import { effortFor, modelFor } from "../../../functions/src/llm/config.ts";
import { priceUsage, promptVersionLabel, type UsageRecord } from "../../../functions/src/llm/cost.ts";
import { isEffort, profileFor, type Effort } from "../../../functions/src/llm/modelProfile.ts";
import { rateFor } from "../../../functions/src/llm/rates.ts";
import { loadPromptText } from "../../../functions/src/prompts/loader.ts";
import {
  fitBriefRequestFingerprint,
  generateFitBrief,
  type FitBriefInput,
  type FitBriefResult,
} from "../../../functions/src/generation/fitBrief.ts";

import { assertOutsideRepo, loadCorpus, type CorpusPair, type FitBriefCorpus } from "./corpus.ts";
import { judgeBrief, judgeRequestFingerprint, type JudgeResult } from "./judge.ts";
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
  /**
   * Units mode: reuse Units saved by an earlier run (its `units.json`)
   * instead of extracting again, so comparison runs see the same evidence.
   */
  readonly frozenUnits?: FrozenUnits;
}

/**
 * The Units a units-mode run used, saved as `units.json` in its output
 * directory. Extraction is stochastic, so runs compared against each other
 * should share one extraction: pass this file back with --units-from
 * (Codex P2, #581).
 */
export interface FrozenUnits {
  readonly resume_sha256: string;
  readonly extraction: string;
  readonly units: readonly UnitEvidence[];
}

const FrozenUnitsSchema = z
  .object({
    resume_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    extraction: z.string().min(1),
    units: z.array(
      z
        .object({
          raw_text: z.string().min(1),
          date_range: z.object({ start: z.string().min(1), end: z.string().min(1).optional() }).strict().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** Parse a saved `units.json`, refusing one made from a different résumé. */
export function parseFrozenUnits(text: string, resumeText: string): FrozenUnits {
  const parsed = FrozenUnitsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid --units-from file: ${parsed.error.message}`);
  if (parsed.data.resume_sha256 !== sha256Hex(resumeText)) {
    throw new Error("--units-from was extracted from a different résumé than the corpus holds.");
  }
  return parsed.data;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

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
   * Units mode only: the resolved extraction model, effort and prompt
   * version, recorded in the report so runs on different extraction pins
   * are never read as comparable (Codex P2, #581).
   */
  readonly extractionConfig?: string;
  /** Only called for --evidence units. Returns each Unit's verbatim text and date range. */
  readonly extractUnits: (resumeText: string, record: RecordUsageFn, guard: BudgetGuard) => Promise<UnitEvidence[]>;
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

/**
 * Write `data` to `path` privately and without following links (Codex
 * review of #581): create a fresh 0600 file exclusively in the same
 * directory, then rename it over the destination. The rename replaces a
 * symlink at `path` rather than writing through it, so a planted link
 * cannot carry private output into the repository, and the contents are
 * never readable under looser permissions in between.
 */
export function writePrivateFile(path: string, data: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      // writeSync may write fewer bytes than asked (a size limit, a nearly
      // full disk); loop so a short write can never publish a truncated
      // artifact (Codex P2, #581). A zero-byte write would loop forever, so
      // it fails instead.
      const bytes = Buffer.from(data, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error(`Short write to ${tmp}`);
        offset += written;
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    renamed = true;
  } finally {
    // A failed write, close or rename must not leave the private brief
    // behind in a temp file (CodeRabbit on #581).
    if (!renamed) {
      try {
        unlinkSync(tmp);
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }
}

/**
 * Create the output directory owner-only, and tighten it if it already
 * exists: `mode` applies only to directories mkdir creates, a reused --out
 * keeps its old permissions, and filenames carry pair ids (Codex P2, #581).
 * A directory that already holds files is refused, so artifacts from an
 * earlier run can never sit beside this run's and be read as current
 * (Codex P2, #581). The default --out is a fresh timestamped directory.
 */
export function prepareOutDir(dir: string): void {
  // Inspect before changing anything: a mistyped --out naming a shared,
  // non-empty directory must be refused with its permissions untouched
  // (Codex P1, #581).
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`--out ${dir} is not empty; give each run its own directory.`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Claim the directory atomically: two runs can both see it empty, but
  // only one can create the lock exclusively, so concurrent runs never
  // overwrite or mix each other's artifacts (Codex P2, #581). The lock
  // stays, marking the directory as used.
  try {
    closeSync(openSync(join(dir, RUN_LOCK), "wx", 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`--out ${dir} is already in use by another run; give each run its own directory.`);
    }
    throw err;
  }
}

/** Created exclusively in each run's output directory by `prepareOutDir`. */
export const RUN_LOCK = ".fit-brief-run.lock";

/**
 * Raised instead of retrying units extraction after a truncated response.
 * The production extractor retries `stop_reason: max_tokens` with the
 * same request and budget, which for an eval only pays for the same
 * truncation again (Codex P2, #581).
 */
export class ExtractionTruncatedError extends Error {
  readonly status = 400;
  constructor() {
    super("Units extraction was truncated at its output budget; not retrying.");
    this.name = "ExtractionTruncatedError";
  }
}

/**
 * Wrap the extraction client so that, once a response is truncated, every
 * later request fails locally without a paid call. The extractor treats
 * the failure as a transport error and gives up after its attempts, all
 * of them free.
 */
export function stopAfterTruncation(client: Anthropic): Anthropic {
  const create = client.messages.create.bind(client.messages);
  let truncated = false;
  return {
    ...client,
    messages: {
      ...client.messages,
      create: (async (...args: Parameters<typeof create>) => {
        if (truncated) throw new ExtractionTruncatedError();
        const response = await create(...args);
        if ((response as { stop_reason?: string }).stop_reason === "max_tokens") truncated = true;
        return response;
      }) as typeof create,
    },
  } as Anthropic;
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
  const writeFile = deps.writeFile ?? writePrivateFile;
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
  // Everything that decides what a run measured. It heads the report and
  // is persisted in every sample artifact, so runs on different prompts or
  // pins are never read as comparable (Codex P2, #581).
  // A frozen extraction is reported as the pin that produced it, not
  // the current one.
  const extractionLabel = options.frozenUnits?.extraction ?? deps.extractionConfig ?? "unrecorded";
  const runConfig = {
    model: options.model,
    ...(generatorEffort !== undefined && { effort: generatorEffort }),
    generatorPrompt: promptVersionLabel(loadPromptText("generation", "fitBrief")),
    generatorRequest: fitBriefRequestFingerprint(options.model, options.effort),
    judgeModel: options.judgeModel,
    ...(judgeEffort !== undefined && { judgeEffort }),
    judgePrompt: judgeRequestFingerprint(options.judgeModel, options.judgeEffort),
    // A privacy-safe hash of every corpus input this run read (résumé,
    // inventory, claim rules, and each selected pair's id, JD and
    // reference), so runs on different corpus revisions are told apart
    // without recording the private text (Codex P2, #581).
    corpus: `sha256:${sha256Hex(
      JSON.stringify([
        corpus.resumeText,
        corpus.inventoryText ?? null,
        corpus.claimRulesText ?? null,
        pairs.map((p) => [p.id, p.split, p.jdText, p.referenceText]),
      ]),
    ).slice(0, 12)}`,
    evidenceMode: options.evidence,
    ...(options.evidence === "units" && {
      extraction: extractionLabel,
      unitsFormat: UNITS_FORMAT_FINGERPRINT,
      unitsSource: options.frozenUnits ? "frozen" : "extracted",
    }),
  };
  // Set once the Units are known: a hash of exactly what the generator
  // read, so two runs can be checked for identical evidence.
  let unitsSha256: string | undefined;
  const config = () => ({ ...runConfig, ...(unitsSha256 !== undefined && { unitsSha256 }) });
  const report = (rows: readonly { split: string; score: BriefScore | null }[]) =>
    formatAggregate(aggregate(rows), { ...config(), spentUsd, maxUsd: options.maxUsd, incomplete });

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
  // Units mode: each Unit's raw_text, used only to classify failed quotes.
  let unitTexts: readonly string[] | undefined;
  if (options.evidence === "units") {
    let units: readonly UnitEvidence[];
    if (options.frozenUnits) {
      if (options.frozenUnits.resume_sha256 !== sha256Hex(corpus.resumeText)) {
        throw new Error("Frozen Units were extracted from a different résumé than the corpus holds.");
      }
      units = options.frozenUnits.units;
    } else {
      try {
        units = await deps.extractUnits(corpus.resumeText, record, guard);
      } catch (err) {
        if (!(err instanceof BudgetReachedError) && !overBudget()) throw err;
        incomplete = true;
        return { report: report([]), spentUsd, incomplete, rows: [] };
      }
    }
    generatorEvidence = renderUnitEvidence(units);
    unitTexts = units.map((u) => u.raw_text);
    unitsSha256 = sha256Hex(generatorEvidence);
    // Persist the exact Units so the run can be audited and its extraction
    // reused by later comparison runs via --units-from (Codex P2, #581).
    const frozen: FrozenUnits = {
      resume_sha256: sha256Hex(corpus.resumeText),
      extraction: extractionLabel,
      units,
    };
    writeFile(join(options.outDir, "units.json"), JSON.stringify(frozen, null, 2));
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
              { pair: pair.id, split: pair.split, sample, config: config(), brief: generated.brief, unjudged: "spend bound reached" },
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
        const evidence = checkEvidence(
          generated.brief,
          sources,
          unitTexts,
        );
        const score = scoreBrief({ evidence, judge: judgement, generatedVerdict: generated.brief.verdict });
        rows.push({ split: pair.split, score });
        writeFile(
          file,
          JSON.stringify(
            { pair: pair.id, split: pair.split, sample, config: config(), brief: generated.brief, evidence, judgement, score },
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
              config: config(),
              // Keep a paid-for brief when only the judge failed.
              ...(generated !== undefined && { brief: generated.brief }),
              ...(!stoppedByBound && { failureCategories: ["unscored"] }),
              error: err instanceof Error ? err.message : String(err),
              // Keep per-attempt detail (FitBriefError.failures) so a bad
              // key or exhausted retries can be diagnosed privately.
              ...(Array.isArray((err as { failures?: unknown })?.failures) && {
                failures: (err as { failures: unknown[] }).failures,
              }),
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
  "--split", "--samples", "--max-usd", "--out", "--units-from", "--dry-run",
]);

/** Boolean flags take no value; `--dry-run=true` is rejected, not silently ignored (Codex P2, #581). */
const BOOLEAN_FLAGS = new Set(["--dry-run"]);

export function parseArgs(
  argv: readonly string[],
  now: Date = new Date(),
): FitBriefEvalOptions & { dryRun: boolean; unitsFrom?: string } {
  // Walk every token: each must be a known flag, followed by its value
  // unless it is boolean or written --name=value. Anything else, such as a
  // positional word or a single-dash typo like `-split test`, is rejected
  // rather than silently ignored before a paid run (Codex P2, #581).
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = a.split("=")[0]!;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}`);
    if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown flag ${a}`);
    if (seen.has(name)) throw new Error(`${name} given more than once`);
    seen.add(name);
    if (BOOLEAN_FLAGS.has(name)) {
      if (a !== name) throw new Error(`${name} takes no value (got ${a})`);
    } else if (a === name) {
      i += 1; // the value; flag() validates it below
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
  const unitsFrom = flag(argv, "--units-from");
  if (unitsFrom !== undefined && evidence !== "units") throw new Error("--units-from needs --evidence units");
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
    ...(unitsFrom !== undefined && { unitsFrom }),
  };
}

export interface UnitEvidence {
  readonly raw_text: string;
  readonly date_range?: { readonly start: string; readonly end?: string };
}

/**
 * Units mode's evidence for the generator: one JSON object per Unit, in
 * extraction order. Order is kept because a Unit's text may omit its role
 * or employer, so its neighbours carry that context (Codex P2, #581).
 * Dates can live only in `date_range` and a brief judges tenure (Codex P2
 * on #581), but they are the extraction model's output, not résumé text,
 * so they sit in their own field rather than in any quotable text. The
 * evidence gate then only ever certifies verbatim résumé text, and dates a
 * brief asserts are checked by the judge against the canonical résumé
 * (Codex P1 ×2 on #581). JSON keeps a Unit whole even when its text holds
 * newlines or Markdown markers (Codex P2, #581). Other structured fields
 * are omitted on purpose: units mode tests the Units' text and dates, not
 * the full record.
 */
export function renderUnitEvidence(units: readonly UnitEvidence[]): string {
  return JSON.stringify(
    units.map((u) => ({
      text: u.raw_text,
      dates_from_extraction: u.date_range ? `${u.date_range.start} to ${u.date_range.end ?? "present"}` : null,
    })),
    null,
    2,
  );
}

/**
 * Identifies the units-mode serialization the generator reads, so runs
 * whose evidence was laid out differently never share a configuration
 * (Codex P2, #581). Hashes the rendering of a fixed canary.
 */
export const UNITS_FORMAT_FINGERPRINT = `sha256:${createHash("sha256")
  .update(
    renderUnitEvidence([
      { raw_text: "<unit>", date_range: { start: "2000-01", end: "2001-02" } },
      { raw_text: "<open unit>", date_range: { start: "2002-03" } },
      { raw_text: "<undated unit>" },
    ]),
  )
  .digest("hex")
  .slice(0, 12)}`;

/** What `extractFromResume` will run with, resolved the same way it resolves them. */
export function extractionConfigLabel(): string {
  const effort = effortFor("extraction");
  return (
    `${modelFor("extraction").model}${effort === undefined ? "" : ` effort ${effort}`}, ` +
    `prompt ${promptVersionLabel(loadPromptText("extraction", "resume"))}`
  );
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
  let frozenUnits: FrozenUnits | undefined;
  if (options.unitsFrom !== undefined) {
    assertOutsideRepo(options.unitsFrom, "--units-from");
    frozenUnits = parseFrozenUnits(readFileSync(options.unitsFrom, "utf8"), corpus.resumeText);
  }
  const pairs = selectPairs(corpus, options.split);
  const calls = pairs.length * options.samples;
  console.log(
    `${calls} brief(s): ${pairs.length} ${options.split} pair(s) × ${options.samples} sample(s); ` +
      `generator ${options.model}${effortLabel(resolvedEffort(options.model, options.effort))}, ` +
      `judge ${options.judgeModel}${effortLabel(resolvedEffort(options.judgeModel, options.judgeEffort))}, ` +
      `evidence ${options.evidence}${frozenUnits ? " (frozen Units)" : ""}. ` +
      `Output: ${options.outDir}`,
  );
  if (options.dryRun) return 0;

  prepareOutDir(options.outDir);
  const client: Anthropic = anthropicForCli();
  const outcome = await runFitBriefEval(corpus, { ...options, ...(frozenUnits && { frozenUnits }) }, {
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
    extractionConfig: extractionConfigLabel(),
    extractUnits: async (resumeText, record, guard) =>
      (
        await extractFromResume(
          resumeText,
          { ownerUid: "eval-fit-brief" },
          { client: stopAfterTruncation(guardClient(client, guard)), record },
        )
      ).map((u) => ({ raw_text: u.raw_text, ...(u.date_range && { date_range: u.date_range }) })),
  });
  console.log(outcome.report);
  // Nonzero when the run stopped early, any sample could not be evaluated
  // (an invalid key, a judge failing every request), or spend reached the
  // bound (even on the final call, after which no
  // further check runs), so automation never reads any of those as a
  // clean pass (Codex P2, #581).
  return outcome.incomplete || outcome.rows.some((r) => r.score === null) || outcome.spentUsd >= options.maxUsd
    ? 1
    : 0;
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
