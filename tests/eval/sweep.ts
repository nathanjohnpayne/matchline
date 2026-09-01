/**
 * Model / prompt sweep (#389, serving #177).
 *
 * ## What this answers
 *
 * `functions/src/llm/config.ts` pins `extraction: claude-sonnet-4-6`
 * and `requirement_parsing: claude-haiku-4-5` **by assertion**. Nothing
 * has ever measured whether Sonnet's extra cost buys extraction
 * accuracy, or whether a cheaper model clears the 80/80 bar just as
 * well. This sweep runs the labeled corpus once per variant and emits a
 * quality-vs-cost table so those pins can be chosen from data.
 *
 * ## Why the cost column is trustworthy
 *
 * Every variant's cost is **modeled**: payload token counts priced
 * through the same `rates.ts` / `priceFor` that production accounting
 * uses. It is deliberately NOT the subscription CLI's reported
 * `total_cost_usd`, which is shadow cost of the agent harness — a
 * measured extraction reported $0.105 against ~$0.066 of real Haiku
 * payload, the difference being 20-80k tokens of injected tool
 * definitions. Ranking on that number would pick the wrong model.
 *
 * Because the cost is modeled from usage records that the stage cache
 * replays on a hit, the ranking is also **cache-independent**: a warm
 * variant reports the same cost as a cold one (pinned in
 * `cache.test.ts`).
 *
 * ## What this cannot answer
 *
 * - **Latency.** A CLI run carries agent startup and tool-loop
 *   overhead; the verified extraction took 399s through Claude Code
 *   against a far faster API call. Latency stays an `api`-source
 *   measurement, and #177's p95 < 20s target must be verified there.
 * - **Exact quality.** The CLI has no `tool_use` enforcement, so its
 *   schema adherence differs from production. Treat the ranking as
 *   directional and confirm the top 2-3 finalists on the metered API
 *   before editing `config.ts` — at ~$0.17/flow a 4-cell confirmation
 *   run is well under a dollar.
 */

import {
  clearModelOverrides,
  isStage,
  modelFor,
  setModelOverrides,
  STAGES,
  type ModelConfig,
  type Stage,
} from "../../functions/src/llm/config.ts";
import { rateFor } from "../../functions/src/llm/rates.ts";
import {
  clearPromptVersionOverrides,
  resolvePromptVersion,
  setPromptVersionOverrides,
} from "../../functions/src/prompts/loader.ts";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunForFixtureResult } from "./runForFixture.ts";

/** Where `loadPromptText` resolves `<stage>/<name>.<version>.md` from. */
const PROMPTS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "functions",
  "src",
  "prompts",
);

/**
 * Stages the eval corpus actually exercises.
 *
 * `runForFixture` runs extraction → embed → parse → embed → match.
 * `rationale` is currently a deterministic template (#100, no LLM),
 * and `generation` / `validation` need Firestore for AssetRef persist
 * so they are not wired into the harness. Overriding any of those
 * would parse cleanly and show up in the results table while
 * changing nothing.
 */
export const SWEEPABLE_STAGES: readonly Stage[] = ["extraction", "requirement_parsing"];

/**
 * Prompt keys the eval corpus actually resolves — the `stage/name`
 * pairs `runForFixture` passes to `resolvePromptVersion`. Overriding
 * anything else (a typo, or a generation/validation prompt the
 * harness never loads) would appear in the results table while
 * changing nothing.
 */
export const SWEEPABLE_PROMPT_KEYS: readonly string[] = [
  "extraction/resume",
  "parsing/jd",
];

/** One point in the sweep matrix. */
export interface SweepVariant {
  /** Short label for the results table, e.g. "haiku-extraction". */
  readonly label: string;
  /** Per-stage model overrides. Unlisted stages keep their config.ts default. */
  readonly models?: Partial<Record<Stage, ModelConfig>>;
  /** Prompt-version overrides, e.g. `{ "extraction/resume": "v2" }`. */
  readonly promptVersions?: Readonly<Record<string, string>>;
  /** Where tokens come from. Recorded so the table shows it. */
  readonly tokenSource?: string;
}

export interface VariantResult {
  readonly label: string;
  readonly tokenSource: string;
  readonly models: Partial<Record<Stage, ModelConfig>>;
  readonly promptVersions: Readonly<Record<string, string>>;
  /** Mean across the corpus, in [0, 1]. Null when no cell succeeded. */
  readonly extractionAccuracy: number | null;
  readonly matchAccuracy: number | null;
  /** Sum of modeled (uncached, payload-priced) cost across the corpus. */
  readonly modeledCostUsd: number;
  /** Modeled cost per flow — the number to compare against the <$1 PRD bar. */
  readonly modeledCostPerFlowUsd: number | null;
  readonly flows: number;
  readonly failures: number;
}

/**
 * Verify every prompt version a sweep names exists on disk, BEFORE any
 * tokens are spent.
 *
 * Codex P2: `--variant a:model.extraction=... --variant
 * b:prompt.extraction/resume=v22` used to fail only once variant b ran
 * — after variant a had already spent a full corpus of tokens.
 *
 * This is a pre-flight rather than a parse-time check on purpose:
 * `parseVariantFlag` validates SYNTAX and stays pure, so it remains
 * testable without a filesystem, and the filesystem question is asked
 * once, up front, alongside `assertModelsPriced`.
 */
export function assertPromptsExist(
  variants: readonly SweepVariant[],
  base: Readonly<Record<string, string>> = {},
  promptsRoot: string = PROMPTS_ROOT,
): void {
  const missing: string[] = [];
  const check = (key: string, version: string): void => {
    const [stage, name] = key.split("/") as [string, string];
    const file = join(promptsRoot, stage, `${name}.${version}.md`);
    if (!existsSync(file)) missing.push(`${key}=${version} (${file})`);
  };
  for (const [k, v] of Object.entries(base)) check(k, v);
  for (const variant of variants) {
    for (const [k, v] of Object.entries(variant.promptVersions ?? {})) check(k, v);
  }
  if (missing.length > 0) {
    throw new Error(
      `sweep: prompt version file(s) not found:\n  ${missing.join("\n  ")}\n` +
        `Refusing to start — the failure would otherwise surface only after ` +
        `earlier variants had already spent tokens.`,
    );
  }
}

/**
 * The prompt version whose co-located Zod schema each pipeline stage is
 * STATICALLY wired to.
 *
 * `functions/src/extraction/resume.ts` imports
 * `ExtractionResponseV1Schema` and builds its tool schema from it;
 * `functions/src/parsing/jd.ts` does the same with
 * `JdParsingResponseV1Schema`. Neither consults the resolved prompt
 * version, even though the loader can return a version's own schema.
 */
const WIRED_SCHEMA_VERSION: Readonly<Record<string, string>> = {
  "extraction/resume": "v1",
  "parsing/jd": "v1",
};

/**
 * Refuse a prompt-version override whose co-located schema differs from
 * the one the pipeline actually enforces.
 *
 * Codex P2: prompts version their schema alongside the Markdown
 * (`<stage>/<name>.v<N>.schema.ts`), but extraction and JD parsing
 * import the v1 schema statically. Overriding to a v2 whose schema
 * differs would run the v2 prompt while constraining and validating its
 * output against v1 — the sweep would report that v2 ran, and either
 * corrupt the comparison or burn retries on responses that are correct
 * for v2 and invalid for v1. That is precisely the mislabeled-table
 * failure the other pre-flights exist to prevent, and prompt tuning
 * (#177 workstream B) is what will first author such a v2.
 *
 * Compares file contents rather than importing: a byte-identical schema
 * is safe to sweep, an absent one means the version reuses the wired
 * schema, and anything else refuses before a token is spent.
 */
export function assertPromptSchemasCompatible(
  variants: readonly SweepVariant[],
  base: Readonly<Record<string, string>> = {},
  promptsRoot: string = PROMPTS_ROOT,
): void {
  const conflicts: string[] = [];
  const check = (key: string, version: string): void => {
    const wired = WIRED_SCHEMA_VERSION[key];
    if (wired === undefined || wired === version) return;
    const [stage, name] = key.split("/") as [string, string];
    const overrideSchema = join(promptsRoot, stage, `${name}.${version}.schema.ts`);
    // No schema of its own — the version reuses the wired one.
    if (!existsSync(overrideSchema)) return;
    const wiredSchema = join(promptsRoot, stage, `${name}.${wired}.schema.ts`);
    if (!existsSync(wiredSchema)) return;
    if (readFileSync(overrideSchema, "utf8") === readFileSync(wiredSchema, "utf8")) return;
    conflicts.push(
      `${key}=${version} ships ${name}.${version}.schema.ts, which differs from the ` +
        `statically-wired ${name}.${wired}.schema.ts`,
    );
  };
  for (const [k, v] of Object.entries(base)) check(k, v);
  for (const variant of variants) {
    for (const [k, v] of Object.entries(variant.promptVersions ?? {})) check(k, v);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `sweep: prompt version(s) whose schema the pipeline does not enforce:\n  ` +
        `${conflicts.join("\n  ")}\n` +
        `The pipeline imports the wired schema statically, so this variant would ` +
        `run its prompt while validating against a different schema — the results ` +
        `table would credit a version that never really constrained the output. ` +
        `Wire the new schema into the stage before sweeping its prompt.`,
    );
  }
}

/**
 * Validate that every model a sweep will touch has a `rates.ts` entry,
 * BEFORE any tokens are spent.
 *
 * Without this the sweep would run to completion and then report $0.00
 * for the unpriced variant — which reads as "free" and would win the
 * Pareto comparison outright. `priceFor` swallows unknown models to 0
 * by design (telemetry must never break a pipeline), so the guard has
 * to live here, up front, where it can still refuse to start.
 */
export function assertModelsPriced(variants: readonly SweepVariant[]): void {
  const missing = new Set<string>();
  for (const variant of variants) {
    for (const config of Object.values(variant.models ?? {})) {
      if (config === undefined) continue;
      try {
        rateFor(config.model);
      } catch {
        missing.add(config.model);
      }
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `sweep: no rates.ts entry for ${[...missing].sort().join(", ")}. ` +
        `Add each model to functions/src/llm/rates.ts with its published ` +
        `input/output price before sweeping it — an unpriced model reports ` +
        `$0.00 and would win the cost comparison by default.`,
    );
  }
}

export interface RunVariantOptions {
  /**
   * Prompt overrides supplied command-wide via `--prompt`, which each
   * variant layers on top of rather than replacing.
   *
   * Codex P2: `setPromptVersionOverrides` REPLACES the whole map, so
   * running `--prompt parsing/jd=v2 --variant 'a:model.extraction=...'`
   * silently dropped the `--prompt` flag for every variant — the run
   * used the default JD prompt while the report header claimed v2.
   */
  readonly basePromptVersions?: Readonly<Record<string, string>>;
}

export interface RunVariantDeps {
  /**
   * Run the whole labeled corpus once under the currently-active
   * overrides. Injected so the sweep is testable without LLM calls.
   */
  readonly runCorpus: () => Promise<readonly RunForFixtureResult[]>;
}

/**
 * The model each sweepable stage actually resolves to right now —
 * variant override, command-wide override, or `config.ts` default,
 * whichever wins. Must be called while the overrides are installed.
 */
function effectiveModels(): Partial<Record<Stage, ModelConfig>> {
  const out: Partial<Record<Stage, ModelConfig>> = {};
  for (const stage of SWEEPABLE_STAGES) out[stage] = modelFor(stage);
  return out;
}

/**
 * The prompt version each sweepable key actually resolves to right
 * now. `resolvePromptVersion` is the loader's own lookup — the
 * docstring there calls out this exact use — so the report cannot
 * drift from what `loadPromptText` read.
 */
function resolvedPromptVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SWEEPABLE_PROMPT_KEYS) {
    const [stage, name] = key.split("/") as [string, string];
    // SWEEPABLE_PROMPT_KEYS is a closed list of real (stage, name)
    // pairs, but it is typed as string[] so the parse-time guards can
    // compare against it. The cast re-states what the list guarantees.
    out[key] = resolvePromptVersion(
      stage as Parameters<typeof resolvePromptVersion>[0],
      name as Parameters<typeof resolvePromptVersion>[1],
    );
  }
  return out;
}

/**
 * Run one variant: apply its overrides, run the corpus, roll up.
 *
 * Overrides are cleared in a `finally` so a throwing variant can't
 * leak its model or prompt selection into the next one — that would
 * silently attribute variant N's numbers to variant N+1's config.
 */
export async function runVariant(
  variant: SweepVariant,
  deps: RunVariantDeps,
  options: RunVariantOptions = {},
): Promise<VariantResult> {
  // Codex P2: a command-wide `--prompt validation/traceability=v2` (or
  // a typo) was merged into every variant and reported as part of it,
  // even though the corpus only resolves extraction/resume and
  // parsing/jd. The table then credited a variant with a prompt that
  // never ran. Variant-level keys are already checked at parse time;
  // this checks the ones arriving from the command line.
  for (const key of Object.keys(options.basePromptVersions ?? {})) {
    if (!SWEEPABLE_PROMPT_KEYS.includes(key)) {
      throw new Error(
        `--prompt ${key} is not exercised by the eval corpus, so a sweep would ` +
          `report it as part of every variant while changing nothing. ` +
          `Sweepable prompt keys: ${SWEEPABLE_PROMPT_KEYS.join(", ")}.`,
      );
    }
  }
  setModelOverrides(variant.models ?? {});
  // Variant overrides win on conflict; the command-wide ones survive
  // for keys the variant does not name.
  const effectivePromptVersions = {
    ...(options.basePromptVersions ?? {}),
    ...(variant.promptVersions ?? {}),
  };
  setPromptVersionOverrides(effectivePromptVersions);
  try {
    const results = await deps.runCorpus();
    // Report the configuration that actually ran. Returning the raw
    // variant here used to hide command-wide --prompt flags behind
    // "(defaults)", making a valid sweep look like it used a
    // different prompt from the one that produced its measurements.
    //
    // Codex P2: carry that the rest of the way. Recording only the
    // EXPLICIT overrides left an extraction-only variant with no
    // record of the `requirement_parsing` model or either prompt
    // version that also participated in its numbers — so a saved
    // report stopped being reproducible the moment `config.ts` or
    // `PROMPT_CONFIG` moved. Resolve every sweepable knob through the
    // same lookups the run itself used, here inside the `try` while
    // the overrides are still installed; the `finally` below clears
    // them and the answer would change.
    return rollUpVariant(
      {
        ...variant,
        models: effectiveModels(),
        promptVersions: {
          ...effectivePromptVersions,
          ...resolvedPromptVersions(),
        },
      },
      results,
    );
  } finally {
    clearModelOverrides();
    clearPromptVersionOverrides();
  }
}

/**
 * Pure rollup of one variant's per-fixture results.
 *
 * Failed cells contribute 0 to the accuracy means (matching
 * `aggregateSampledFixture`'s existing semantics — a variant that
 * crashes half the corpus should not be flattered by averaging over
 * only its survivors) but their partial cost is still counted, because
 * the tokens were really spent.
 */
export function rollUpVariant(
  variant: SweepVariant,
  results: readonly RunForFixtureResult[],
): VariantResult {
  const flows = results.length;
  const failures = results.filter((r) => !r.ok).length;
  const ext = results.map((r) => (r.ok ? r.extractionAccuracy : 0));
  const mat = results.map((r) => (r.ok ? r.matchAccuracy : 0));
  const modeledCostUsd = results.reduce((a, r) => a + r.modeledCostUsd, 0);

  return {
    label: variant.label,
    tokenSource: variant.tokenSource ?? "api",
    models: variant.models ?? {},
    promptVersions: variant.promptVersions ?? {},
    extractionAccuracy: flows === 0 ? null : ext.reduce((a, b) => a + b, 0) / flows,
    matchAccuracy: flows === 0 ? null : mat.reduce((a, b) => a + b, 0) / flows,
    modeledCostUsd,
    modeledCostPerFlowUsd: flows === 0 ? null : modeledCostUsd / flows,
    flows,
    failures,
  };
}

/**
 * Mark the Pareto frontier: variants that no other variant beats on
 * extraction accuracy, match accuracy, and cost simultaneously.
 *
 * Extraction and match are independent 80/80 gates in #177, so an
 * average would hide a regression on one metric behind a gain on the
 * other. A variant is dominated when another is at least as good on
 * both quality axes, at least as cheap, and strictly better on one.
 *
 * Variants with no successful flows are never on the frontier — a run
 * that produced nothing isn't "cheap", it's broken.
 *
 * Codex P2 round 1: the `extractionAccuracy !== null` test alone did
 * NOT achieve that, despite the comment claiming it did. A corpus
 * where every fixture failed still has `flows > 0` and numeric zero
 * accuracies, because `rollUpVariant` maps failed cells to 0 rather
 * than null. If those failures happened early — before much usage was
 * recorded — the broken variant landed on the frontier at near-zero
 * cost and the table presented a configuration that produced nothing
 * as an attractive tradeoff. `failures < flows` is the actual check.
 */
export function paretoFrontier(
  results: readonly VariantResult[],
): ReadonlySet<string> {
  const scored = results
    .filter(
      (r): r is VariantResult & { extractionAccuracy: number; matchAccuracy: number } =>
        r.extractionAccuracy !== null &&
        r.matchAccuracy !== null &&
        r.flows > 0 &&
        r.failures < r.flows,
    )
    .map((r) => ({
      label: r.label,
      extractionAccuracy: r.extractionAccuracy,
      matchAccuracy: r.matchAccuracy,
      cost: r.modeledCostPerFlowUsd ?? Number.POSITIVE_INFINITY,
    }));

  const frontier = new Set<string>();
  for (const candidate of scored) {
    const dominated = scored.some(
      (other) =>
        other.label !== candidate.label &&
        other.extractionAccuracy >= candidate.extractionAccuracy &&
        other.matchAccuracy >= candidate.matchAccuracy &&
        other.cost <= candidate.cost &&
        (other.extractionAccuracy > candidate.extractionAccuracy ||
          other.matchAccuracy > candidate.matchAccuracy ||
          other.cost < candidate.cost),
    );
    if (!dominated) frontier.add(candidate.label);
  }
  return frontier;
}

/**
 * PRD bars from `specs/matchline.md § Success metrics`, restated in
 * #177's acceptance criteria.
 */
export const QUALITY_BAR = 0.8;
export const COST_BAR_PER_FLOW_USD = 1;

/**
 * The recommendation the sweep exists to produce: the **cheapest**
 * variant that clears both 80/80 gates.
 *
 * Returns null when nothing clears — which is the honest answer today
 * (#177's baseline is extraction 48.4% / match 19.1%) and must not be
 * dressed up as "the best of a bad set". A caller that wants the
 * least-bad option can read the Pareto frontier instead.
 */
export function recommend(results: readonly VariantResult[]): VariantResult | null {
  const clearing = results.filter(
    (r) =>
      // Codex P2: `paretoFrontier` excludes all-failure variants but
      // this did not, so a variant whose every flow failed could in
      // principle be recommended. The two must agree on what counts
      // as a usable result.
      r.flows > 0 &&
      // A recommendation is an instruction to ship, not a Pareto
      // datapoint. Partial failures may remain useful in the table,
      // but no failing variant may clear the production bar.
      r.failures === 0 &&
      r.extractionAccuracy !== null &&
      r.matchAccuracy !== null &&
      r.extractionAccuracy >= QUALITY_BAR &&
      r.matchAccuracy >= QUALITY_BAR &&
      (r.modeledCostPerFlowUsd ?? Number.POSITIVE_INFINITY) < COST_BAR_PER_FLOW_USD,
  );
  if (clearing.length === 0) return null;
  return clearing.reduce((best, r) =>
    (r.modeledCostPerFlowUsd ?? Infinity) < (best.modeledCostPerFlowUsd ?? Infinity)
      ? r
      : best,
  );
}

/**
 * Format the sweep as a Markdown table, ready to paste into a PR body
 * or #177. Pure — no I/O, snapshot-testable.
 */
export function formatSweepReport(results: readonly VariantResult[]): string {
  const frontier = paretoFrontier(results);
  const lines: string[] = [];

  lines.push("# Model sweep");
  lines.push("");
  lines.push(
    "Cost is **modeled**: payload tokens priced through `functions/src/llm/rates.ts`, " +
      "not the CLI's reported spend (which includes 20-80k tokens of agent-harness " +
      "overhead a production call never carries).",
  );
  lines.push("");
  // Codex P2: `flows` is a column rather than a detail tucked into the
  // failure suffix. Without it a one-fixture smoke run and a
  // full-corpus run serialize identically, so a reader of the saved
  // report cannot judge how much corpus a recommendation rests on, nor
  // reconstruct total modeled cost from `$ / flow`.
  // Codex P2: `estimateTokens` documents that CLI-derived costs are
  // labeled `estimated` in the sweep output — they come from a
  // ~4-chars-per-token approximation, not real token accounting. The
  // report promised that and never delivered it, so a near-tie between
  // a CLI row and an API row read as more precise than it is.
  if (results.some((r) => r.tokenSource !== "api")) {
    lines.push("");
    lines.push(
      "`~` marks an **estimated** cost: rows measured through a subscription CLI " +
        "price a ~4-chars-per-token approximation of the payload, not metered token " +
        "counts. Treat a near-tie against an `api` row as unresolved until the " +
        "confirmation run on `--token-source api`.",
    );
  }
  lines.push("");
  lines.push(
    "| variant | source | models | prompts | extraction | match | flows | $/flow | pareto |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");

  const sorted = [...results].sort(
    (a, b) =>
      (a.modeledCostPerFlowUsd ?? Infinity) - (b.modeledCostPerFlowUsd ?? Infinity),
  );
  for (const r of sorted) {
    const models =
      Object.entries(r.models)
        .map(([stage, cfg]) => `${stage}=${cfg?.model ?? "?"}`)
        .join("<br>") || "(defaults)";
    const prompts =
      Object.entries(r.promptVersions)
        .map(([k, v]) => `${k}=${v}`)
        .join("<br>") || "(defaults)";
    const fail = r.failures > 0 ? ` ⚠️${r.failures}/${r.flows} failed` : "";
    lines.push(
      `| ${r.label} | ${r.tokenSource} | ${models} | ${prompts} | ` +
        `${fmtPct(r.extractionAccuracy)} | ${fmtPct(r.matchAccuracy)} | ` +
        `${r.flows} | ` +
        `${r.tokenSource === "api" ? "" : "~"}${fmtUsd(r.modeledCostPerFlowUsd)} | ` +
        `${frontier.has(r.label) ? "✅" : ""}${fail} |`,
    );
  }

  lines.push("");
  const pick = recommend(results);
  if (pick === null) {
    lines.push(
      `**No variant clears the ${(QUALITY_BAR * 100).toFixed(0)}/${(QUALITY_BAR * 100).toFixed(0)} bar.** ` +
        "Pareto-optimal variants are marked above; none is production-ready yet " +
        "(#177 baseline: extraction 48.4% / match 19.1%).",
    );
  } else {
    // Codex P2: a recommendation resting on an estimated cost has to
    // say so — it is the single line a reader is most likely to lift
    // out of a saved report and act on.
    const estimated = pick.tokenSource !== "api";
    lines.push(
      `**Recommendation: \`${pick.label}\`** — cheapest variant clearing both ` +
        `${(QUALITY_BAR * 100).toFixed(0)}% gates at ` +
        `${estimated ? "~" : ""}${fmtUsd(pick.modeledCostPerFlowUsd)}/flow` +
        `${estimated ? " (estimated — measured through a subscription CLI; confirm on --token-source api)" : ""}.`,
    );
  }
  lines.push("");
  lines.push(
    "⚠️ Latency is NOT ranked here — a CLI run carries agent startup and tool-loop " +
      "overhead (399s measured on an extraction the API serves far faster). Verify " +
      "#177's p95 < 20s target on `--token-source api`.",
  );
  lines.push(
    "⚠️ Confirm the top finalists on the metered API before editing " +
      "`functions/src/llm/config.ts` — the CLI has no `tool_use` enforcement, so its " +
      "schema adherence differs from production.",
  );

  return lines.join("\n");
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function fmtUsd(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(4)}`;
}

/**
 * Parse a `--variant` flag into a `SweepVariant`.
 *
 * Grammar (repeatable; one flag per matrix point):
 *
 *   --variant '<label>:<key>=<value>[,<key>=<value>...]'
 *
 * where `<key>` is either `model.<stage>` or `prompt.<stage>/<name>`:
 *
 *   --variant 'haiku-extract:model.extraction=claude-haiku-4-5-20251001'
 *   --variant 'v2-prompt:prompt.extraction/resume=v2'
 *   --variant 'both:model.extraction=claude-haiku-4-5-20251001,prompt.extraction/resume=v2'
 *
 * `<label>` is restricted to `[A-Za-z0-9._-]+`, because it is rendered
 * straight into the Markdown results table and the recommendation
 * line — see the guard below.
 *
 * Provider is inferred from the model id prefix, matching the two
 * providers `ModelConfig` allows.
 */
export function parseVariantFlag(spec: string, tokenSource: string): SweepVariant {
  const sep = spec.indexOf(":");
  if (sep <= 0) {
    throw new Error(
      `--variant must be '<label>:<key>=<value>[,...]' (got ${JSON.stringify(spec)})`,
    );
  }
  const label = spec.slice(0, sep).trim();
  if (label.length === 0) {
    throw new Error(
      `--variant label must not be empty (got ${JSON.stringify(spec)})`,
    );
  }
  // Codex P2: the label is interpolated into the Markdown results
  // table, into a backticked recommendation line, and into the
  // duplicate-label check. A label carrying `|`, a newline, or a
  // backtick therefore splits a row into extra cells, breaks the table
  // apart, or escapes the code span — and the report is written to be
  // saved and pasted as experiment evidence, so a corrupted table
  // silently credits metrics to the wrong variant. Restricting the
  // grammar at parse time closes every render site at once, which
  // escaping at one of them would not; it also matches how the prompt
  // version below is handled, and rejects loudly rather than quietly
  // rewriting what the operator asked for.
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(
      `--variant label must be alphanumeric + '.'/'_'/'-' only ` +
        `(got ${JSON.stringify(label)}). The label is rendered into the ` +
        `Markdown results table, where '|', newlines and backticks would ` +
        `corrupt the row.`,
    );
  }
  const body = spec.slice(sep + 1);
  const models: Partial<Record<Stage, ModelConfig>> = {};
  const promptVersions: Record<string, string> = {};

  for (const clause of body.split(",")) {
    const eq = clause.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `--variant clause must be '<key>=<value>' (got ${JSON.stringify(clause)} in ${JSON.stringify(spec)})`,
      );
    }
    const key = clause.slice(0, eq).trim();
    const value = clause.slice(eq + 1).trim();
    if (value.length === 0) {
      throw new Error(`--variant clause ${JSON.stringify(key)} has an empty value`);
    }
    if (key.startsWith("model.")) {
      const stageRaw = key.slice("model.".length);
      // Codex P2 round 1: casting the suffix straight to `Stage`
      // accepted typos like `model.extracton=...`. The bogus key was
      // shown in the report and its model was pricing-validated, but
      // `modelFor("extraction")` never read it — so the corpus
      // silently ran the DEFAULT model and attributed those numbers
      // to the named variant. A sweep that mislabels its own results
      // is worse than one that refuses to start.
      if (!isStage(stageRaw)) {
        throw new Error(
          `--variant: unknown stage ${JSON.stringify(stageRaw)} in ${JSON.stringify(key)}. ` +
            `Valid stages: ${STAGES.join(", ")}.`,
        );
      }
      // Codex P2 round 1: the eval corpus only exercises extraction
      // and requirement_parsing (plus embeddings, which have no
      // model override). Overriding `generation` / `validation` /
      // `rationale` would parse cleanly, appear in the table, and
      // change nothing — another silent mislabel.
      if (!SWEEPABLE_STAGES.includes(stageRaw)) {
        throw new Error(
          `--variant: stage ${JSON.stringify(stageRaw)} is not exercised by the eval ` +
            `corpus, so overriding it would change nothing while still appearing in ` +
            `the results table. Sweepable stages: ${SWEEPABLE_STAGES.join(", ")}.`,
        );
      }
      // The eval pipeline currently accepts Anthropic extraction and
      // parsing models only. Refuse anything else here rather than
      // displaying a variant name that will fail before a client call.
      //
      // Codex P2: this was an OpenAI DENYLIST by name shape
      // (`/^(gpt|o[0-9])/`), which classified anything unrecognized as
      // Anthropic. `text-embedding-3-small` matched neither pattern, so
      // it was labelled `anthropic` — and because it has a `rates.ts`
      // entry, `assertModelsPriced` passed too. Both pre-flights waved
      // through a matrix that would send an OpenAI model id to the
      // Anthropic client, and only mid-run, after earlier variants had
      // already spent a corpus of tokens.
      //
      // An ALLOWLIST inverts the failure: every Anthropic model id is
      // `claude-*`, so anything else is refused up front whatever
      // provider it belongs to, including one that does not exist yet.
      if (!/^claude-/.test(value)) {
        throw new Error(
          `--variant: model ${JSON.stringify(value)} is not an Anthropic model, but ` +
            `extractFromResume/parseJobRequirements hard-require provider "anthropic" ` +
            `and throw before the injected client is called. Model sweeps are ` +
            `Anthropic-only today (ids beginning "claude-"); sweeping another ` +
            `provider needs that guard relaxed first.`,
        );
      }
      models[stageRaw] = { provider: "anthropic", model: value };
    } else if (key.startsWith("prompt.")) {
      const promptKey = key.slice("prompt.".length);
      // Codex P2 round 2: the same silent-mislabel hazard the stage
      // check above closes. `prompt.extracton/resume=v2` or
      // `prompt.validation/traceability=v2` parsed cleanly and was
      // displayed in the report, but `runForFixture` only resolves
      // `extraction/resume` and `parsing/jd` — so the corpus ran the
      // DEFAULT prompt while the table credited the variant.
      if (!SWEEPABLE_PROMPT_KEYS.includes(promptKey)) {
        throw new Error(
          `--variant: prompt key ${JSON.stringify(promptKey)} is not exercised by the ` +
            `eval corpus, so overriding it would change nothing while still appearing ` +
            `in the results table. Sweepable prompt keys: ${SWEEPABLE_PROMPT_KEYS.join(", ")}.`,
        );
      }
      // Codex P2: the version flows into `loadPromptText`'s
      // `join(promptsRoot, stage, "${name}.${version}.md")`. A value
      // containing path separators escapes that directory —
      // `prompt.extraction/resume=x/../../parsing/jd.v1` resolves to
      // the REAL JD prompt, so the sweep would execute one prompt
      // while the results table credited an extraction variant.
      // `parsePromptOverrides` in run.ts already enforces exactly this
      // restriction for `--prompt`; the same rule applies here.
      if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(
          `--variant: prompt version must be alphanumeric + '_'/'-' only ` +
            `(got ${JSON.stringify(value)}). Slashes and '..' are rejected to ` +
            `prevent path traversal in the prompt loader.`,
        );
      }
      promptVersions[promptKey] = value;
    } else {
      throw new Error(
        `--variant key must start with 'model.' or 'prompt.' (got ${JSON.stringify(key)})`,
      );
    }
  }

  return { label, models, promptVersions, tokenSource };
}

/** Collect every `--variant` / `--variant=` occurrence from argv. */
export function parseVariants(
  argv: readonly string[],
  tokenSource: string,
): readonly SweepVariant[] {
  const out: SweepVariant[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--variant") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--variant requires a value");
      }
      out.push(parseVariantFlag(value, tokenSource));
      i += 1;
    } else if (arg.startsWith("--variant=")) {
      out.push(parseVariantFlag(arg.slice("--variant=".length), tokenSource));
    }
  }
  // Duplicate labels would collide in the Pareto set (which is keyed
  // on label) and silently drop a row from the frontier.
  const seen = new Set<string>();
  for (const v of out) {
    if (seen.has(v.label)) {
      throw new Error(`--variant label ${JSON.stringify(v.label)} is used more than once`);
    }
    seen.add(v.label);
  }
  return out;
}

/**
 * Run a whole sweep: validate pricing up front, then run each variant
 * in turn and format the table.
 *
 * Sequential, not parallel — variants mutate shared module state
 * (`setModelOverrides` / `setPromptVersionOverrides`), so running them
 * concurrently would interleave configurations and produce results
 * attributed to the wrong variant.
 */
export async function runSweep(
  variants: readonly SweepVariant[],
  deps: RunVariantDeps,
  options: RunVariantOptions = {},
): Promise<{ results: readonly VariantResult[]; report: string }> {
  assertModelsPriced(variants);
  assertPromptsExist(variants, options.basePromptVersions ?? {});
  assertPromptSchemasCompatible(variants, options.basePromptVersions ?? {});
  const results: VariantResult[] = [];
  for (const variant of variants) {
    results.push(await runVariant(variant, deps, options));
  }
  return { results, report: formatSweepReport(results) };
}
