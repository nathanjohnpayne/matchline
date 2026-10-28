/**
 * `--record <dir>` (per-flow recorder): writes one JSON line per flow to
 * `<dir>/flows.jsonl` and the run's configuration to
 * `<dir>/invocation.json`, for `analyze.ts` to compare arms with.
 *
 * The directory must resolve outside this public repository, using the
 * same check as the fit-brief harness (`assertOutsideRepo`). The eval
 * corpus is public, so the records are safe to keep; the refusal keeps
 * run output out of commits all the same.
 *
 * Files are created on the first recorded flow, so a run refused before
 * any spend (a projection-guard block, a sweep with no labeled pairs)
 * leaves nothing behind. An existing `flows.jsonl` or `invocation.json`
 * in the directory is refused rather than appended to, so one directory
 * always holds exactly one invocation.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { effortFor, EMBEDDING_MODEL, modelFor, type Stage } from "../../functions/src/llm/config.ts";
import { profileFor } from "../../functions/src/llm/modelProfile.ts";
import type { PromptName, PromptStage } from "../../functions/src/prompts/config.ts";
import { resolvePromptVersion } from "../../functions/src/prompts/loader.ts";

import { assertOutsideRepo, repoRoot } from "./fitBrief/corpus.ts";
import {
  buildFlowRecord,
  cellId,
  FLOW_RECORD_SCHEMA_VERSION,
  type FlowRecord,
  type InvocationRecord,
  type StageConfig,
  type StageConfigs,
  type VariantDescription,
} from "./flowRecord.ts";
import { newFlowTrace } from "./flowTrace.ts";
import {
  promptFingerprint,
  runForFixture,
  type RunForFixtureDeps,
  type RunForFixtureInput,
  type RunForFixtureResult,
} from "./runForFixture.ts";
import type { SweepVariant, VariantResult } from "./sweep.ts";

export const FLOWS_FILE = "flows.jsonl";
export const INVOCATION_FILE = "invocation.json";
export const DEFAULT_VARIANT_LABEL = "default";

/** Parse `--record <dir>` / `--record=<dir>`. Undefined when absent. */
export function parseRecordDir(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--record") {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--record requires a directory");
      i += 1;
    } else if (arg.startsWith("--record=")) {
      value = arg.slice("--record=".length);
      if (value === "") throw new Error("--record requires a directory");
    } else {
      continue;
    }
    if (found !== undefined) throw new Error("--record given more than once");
    found = value;
  }
  return found;
}

/** Refuse a directory that resolves inside the repository (symlinks resolved). */
export function assertRecordDirOutsideRepo(dir: string, label: string, root: string = repoRoot()): void {
  try {
    assertOutsideRepo(dir, label, root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("resolves inside this repository")) throw err;
    throw new Error(
      `${label} ${dir} resolves inside this repository. This repository is public; ` +
        `write eval records outside it (for example ~/.matchline/eval-records/<run>).`,
    );
  }
}

/** HEAD and whether the tree is dirty; nulls when git is unavailable. */
export function gitHead(cwd: string = repoRoot()): { sha: string | null; dirty: boolean | null } {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    let dirty: boolean | null = null;
    try {
      dirty =
        execFileSync("git", ["status", "--porcelain"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim().length > 0;
    } catch {
      dirty = null;
    }
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/** The LLM stages a flow runs, with the prompt each resolves. */
const RECORDED_STAGES: ReadonlyArray<readonly [Stage, PromptStage, string]> = [
  ["extraction", "extraction", "resume"],
  ["requirement_parsing", "parsing", "jd"],
];

/**
 * What each LLM stage runs with right now: the installed overrides (a
 * sweep variant's, or `--prompt`) or the defaults. Called per flow, so a
 * sweep records each variant's own configuration.
 */
export function captureStageConfig(tokenSource: string): StageConfigs {
  const out: Record<string, StageConfig> = {};
  for (const [stage, promptStage, promptName] of RECORDED_STAGES) {
    const model = modelFor(stage);
    const requested = effortFor(stage);
    let profileDefault: string | undefined;
    try {
      profileDefault = profileFor(model.model).defaultEffort;
    } catch {
      profileDefault = undefined;
    }
    const name = promptName as PromptName<typeof promptStage>;
    out[stage] = {
      provider: model.provider,
      model: model.model,
      effortRequested: requested ?? null,
      effortSent: tokenSource === "api" ? (requested ?? profileDefault ?? null) : null,
      promptVersion: resolvePromptVersion(promptStage, name),
      promptFingerprint: promptFingerprint(promptStage, name),
    };
  }
  return out;
}

/** Describe the run's arms for invocation.json, before anything runs. */
export function describeVariants(
  variants: readonly SweepVariant[],
  tokenSource: string,
  promptOverrides: Readonly<Record<string, string>>,
): VariantDescription[] {
  if (variants.length === 0) {
    return [
      {
        label: DEFAULT_VARIANT_LABEL,
        tokenSource,
        requested: { models: {}, efforts: {}, promptVersions: { ...promptOverrides } },
        stages: captureStageConfig(tokenSource),
      },
    ];
  }
  return variants.map((v) => ({
    label: v.label,
    tokenSource: v.tokenSource ?? tokenSource,
    requested: {
      models: { ...(v.models ?? {}) },
      efforts: { ...(v.efforts ?? {}) } as Record<string, string>,
      promptVersions: { ...promptOverrides, ...(v.promptVersions ?? {}) },
    },
  }));
}

export interface RecorderClock {
  now(): Date;
}

export interface InvocationInput {
  readonly argv: readonly string[];
  readonly tokenSource: string;
  readonly cacheMode: string;
  readonly samples: number;
  readonly mode: string;
  readonly promptOverrides: Readonly<Record<string, string>>;
  readonly variants: readonly VariantDescription[];
}

export class FlowRecorder {
  readonly dir: string;
  readonly invocationId: string;
  private invocation: InvocationRecord;
  private opened = false;
  private variantLabel = DEFAULT_VARIANT_LABEL;
  private readonly samplesSeen = new Map<string, number>();
  private readonly clock: RecorderClock;

  private constructor(dir: string, invocation: InvocationRecord, clock: RecorderClock) {
    this.dir = dir;
    this.invocation = invocation;
    this.invocationId = invocation.invocationId;
    this.clock = clock;
  }

  /**
   * Validate `dir` and prepare a recorder. Refuses an in-repo path or a
   * directory that already holds a record. Writes nothing yet.
   */
  static prepare(
    dir: string,
    input: InvocationInput,
    options: {
      readonly root?: string;
      readonly clock?: RecorderClock;
      readonly head?: { sha: string | null; dirty: boolean | null };
      readonly invocationId?: string;
    } = {},
  ): FlowRecorder {
    const root = options.root ?? repoRoot();
    assertRecordDirOutsideRepo(dir, "--record", root);
    const abs = resolve(dir);
    for (const file of [FLOWS_FILE, INVOCATION_FILE]) {
      if (existsSync(join(abs, file))) {
        throw new Error(
          `--record ${dir} already holds ${file}. Use a fresh directory per run so ` +
            `one directory never mixes two invocations.`,
        );
      }
    }
    const clock = options.clock ?? { now: () => new Date() };
    const head = options.head ?? gitHead(root);
    const invocation: InvocationRecord = {
      schemaVersion: FLOW_RECORD_SCHEMA_VERSION,
      invocationId: options.invocationId ?? randomUUID(),
      headSha: head.sha,
      dirty: head.dirty,
      argv: [...input.argv],
      tokenSource: input.tokenSource,
      cacheMode: input.cacheMode,
      samples: input.samples,
      mode: input.mode,
      promptOverrides: { ...input.promptOverrides },
      variants: input.variants,
      startedAt: clock.now().toISOString(),
      finishedAt: null,
      flowCount: 0,
    };
    return new FlowRecorder(abs, invocation, clock);
  }

  get flowCount(): number {
    return this.invocation.flowCount;
  }

  get variant(): string {
    return this.variantLabel;
  }

  now(): Date {
    return this.clock.now();
  }

  /** Label the flows that follow (a sweep calls this per variant). */
  setVariant(label: string): void {
    this.variantLabel = label;
  }

  /** 0-based index of the next sample of (variant, cell). */
  nextSampleIndex(variant: string, resumeId: string, jdId: string): number {
    const key = `${variant}\u0000${cellId(resumeId, jdId)}`;
    const next = this.samplesSeen.get(key) ?? 0;
    this.samplesSeen.set(key, next + 1);
    return next;
  }

  append(flow: FlowRecord): void {
    this.open();
    appendFileSync(join(this.dir, FLOWS_FILE), `${JSON.stringify(flow)}\n`, "utf8");
    this.invocation = { ...this.invocation, flowCount: this.invocation.flowCount + 1 };
  }

  /**
   * Stamp `finishedAt`, and for a sweep the configuration each variant
   * actually resolved to. A no-op when no flow was recorded.
   */
  finish(results?: readonly VariantResult[]): void {
    if (!this.opened) return;
    const resolvedByLabel = new Map((results ?? []).map((r) => [r.label, r]));
    this.invocation = {
      ...this.invocation,
      finishedAt: this.clock.now().toISOString(),
      variants: this.invocation.variants.map((v) => {
        const r = resolvedByLabel.get(v.label);
        return r === undefined
          ? v
          : {
              ...v,
              resolved: {
                models: { ...r.models },
                efforts: { ...r.efforts } as Record<string, string>,
                promptVersions: { ...r.promptVersions },
              },
            };
      }),
    };
    this.writeInvocation();
  }

  private open(): void {
    if (this.opened) return;
    mkdirSync(this.dir, { recursive: true });
    // `wx` fails if another run created the file since `prepare`.
    writeFileSync(join(this.dir, FLOWS_FILE), "", { flag: "wx" });
    this.opened = true;
    this.writeInvocation();
  }

  private writeInvocation(): void {
    writeFileSync(join(this.dir, INVOCATION_FILE), `${JSON.stringify(this.invocation, null, 2)}\n`, "utf8");
  }
}

export type FlowRunner = (input: RunForFixtureInput, deps: RunForFixtureDeps) => Promise<RunForFixtureResult>;

/**
 * Wrap `runForFixture` so every flow is recorded. Without a recorder the
 * runner is returned unchanged, so a run without `--record` does exactly
 * what it did before.
 */
export function recordingRunner(
  recorder: FlowRecorder | undefined,
  tokenSource: string,
  run: FlowRunner = runForFixture,
): FlowRunner {
  if (recorder === undefined) return run;
  return async (input, deps) => {
    const trace = newFlowTrace();
    const stages = captureStageConfig(tokenSource);
    const variant = recorder.variant;
    const startedAt = recorder.now().toISOString();
    const result = await run(input, { ...deps, trace });
    const finishedAt = recorder.now().toISOString();
    recorder.append(
      buildFlowRecord(
        {
          invocationId: recorder.invocationId,
          variant,
          stages,
          embeddingModel: EMBEDDING_MODEL,
          resumeId: input.resumeFixtureId,
          jdId: input.jdFixtureId,
          sampleIndex: recorder.nextSampleIndex(variant, input.resumeFixtureId, input.jdFixtureId),
          startedAt,
          finishedAt,
        },
        result,
        trace,
      ),
    );
    return result;
  };
}
