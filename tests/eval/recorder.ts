/**
 * `--record <dir>` (per-flow recorder): writes one JSON line per flow to
 * `<dir>/flows.jsonl` and the run's configuration to
 * `<dir>/invocation.json`, for `analyze.ts` to compare arms with.
 *
 * The directory must resolve outside this public repository: outside
 * the checkout the code runs from (the fit-brief harness's
 * `assertOutsideRepo`), and outside the main checkout and every other
 * worktree of the same repository, which git lists. The eval corpus is
 * public, so the records are safe to keep; the refusal keeps run output
 * out of commits all the same.
 *
 * Files are created on the first recorded flow, so a run refused before
 * any flow runs (a `--variant` sweep blocked by its projection guard,
 * which is checked before the sweep starts; a sweep with no labeled
 * pairs) leaves nothing behind. The ordinary (non-sweep) path checks its
 * projection guard only after the corpus has run, so a run that guard
 * refuses has already recorded its flows. An existing `flows.jsonl` or `invocation.json`
 * in the directory is refused rather than appended to, so one directory
 * always holds exactly one invocation.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/**
 * Refuse a directory that resolves inside the repository (symlinks
 * resolved): inside `root`, inside the main checkout (the parent of the
 * shared git directory), or inside any worktree `git worktree list`
 * reports. A worktree of the same repository can commit records just as
 * well as the checkout the code runs from. When git cannot answer, the
 * path is refused: an unknown checkout layout is not proof of "outside".
 */
export function assertRecordDirOutsideRepo(dir: string, label: string, root: string = repoRoot()): void {
  try {
    assertOutsideRepo(dir, label, root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("resolves inside this repository")) throw err;
    throw new Error(insideRepoMessage(label, dir, null));
  }
  const target = comparablePath(realpathOrAncestor(dir));
  for (const checkout of repositoryCheckouts(root, label, dir)) {
    if (isWithin(relative(comparablePath(realpathOrAncestor(checkout)), target))) {
      throw new Error(insideRepoMessage(label, dir, checkout));
    }
  }
}

function insideRepoMessage(label: string, dir: string, checkout: string | null): string {
  return (
    `${label} ${dir} resolves inside this repository${checkout === null ? "" : ` (the checkout or worktree at ${checkout})`}. ` +
    `This repository is public; write eval records outside it (for example ~/.matchline/eval-records/<run>).`
  );
}

/**
 * The main checkout and every worktree of the repository at `root`. Throws
 * (refusing the path) when either git command fails. GIT_DIR and friends
 * are dropped so an inherited hook environment cannot point git at a
 * different repository than `root`.
 */
function repositoryCheckouts(root: string, label: string, dir: string): string[] {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync("git", ["-C", root, ...args], { env, stdio: ["ignore", "pipe", "pipe"] }).toString();
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string }).stderr?.toString().trim();
      const reason = stderr || (err instanceof Error ? err.message : String(err));
      throw new Error(
        `${label} ${dir}: cannot confirm it is outside this repository, because \`git ${args.join(" ")}\` ` +
          `failed in ${root} (${reason}). Refusing rather than risk writing into a checkout.`,
      );
    }
  };
  const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const checkouts = [dirname(commonDir)];
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) checkouts.push(line.slice("worktree ".length));
  }
  return checkouts;
}

/** `rel` stays inside its base (the rule the fit-brief helper uses). */
function isWithin(rel: string): boolean {
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Case-fold where the default file system is case-insensitive, as the fit-brief helper does. */
function comparablePath(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/** Real path of `path`, or of its deepest existing ancestor with the rest appended. */
function realpathOrAncestor(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync.native(current), ...tail);
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
  private variantTokenSourceValue: string | undefined;
  private disabledReason: string | undefined;
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

  /** The token source the current variant set, if any. */
  get variantTokenSource(): string | undefined {
    return this.variantTokenSourceValue;
  }

  /** True once a write failed; later flows run unrecorded. */
  get disabled(): boolean {
    return this.disabledReason !== undefined;
  }

  /**
   * Label the flows that follow (a sweep calls this per variant), with
   * the variant's own token source when it sets one, so each flow
   * records the effort that source actually sends.
   */
  setVariant(label: string, tokenSource?: string): void {
    this.variantLabel = label;
    this.variantTokenSourceValue = tokenSource;
  }

  /**
   * Stop recording after a write failure. The run has already paid for
   * the flow, so the failure goes to stderr and the run continues
   * without records rather than aborting.
   */
  disable(err: unknown): void {
    if (this.disabledReason !== undefined) return;
    const message = err instanceof Error ? err.message : String(err);
    this.disabledReason = message;
    this.invocation = { ...this.invocation, recordingError: message };
    console.error(
      `--record: writing to ${this.dir} failed (${message}); recording is off for the rest of this run, ` +
        `which continues. ${this.invocation.flowCount} flow(s) were recorded before the failure.`,
    );
  }

  /** 0-based index of the next sample of (variant, cell). */
  nextSampleIndex(variant: string, resumeId: string, jdId: string): number {
    const key = `${variant}\u0000${cellId(resumeId, jdId)}`;
    const next = this.samplesSeen.get(key) ?? 0;
    this.samplesSeen.set(key, next + 1);
    return next;
  }

  /**
   * Append one flow, then rewrite invocation.json with the new count, so
   * a run killed mid-way (SIGINT, OOM) leaves a `flowCount` that matches
   * `flows.jsonl`; `finishedAt` stays null until `finish()`.
   */
  append(flow: FlowRecord): void {
    if (this.disabled) return;
    this.open();
    appendFileSync(join(this.dir, FLOWS_FILE), `${JSON.stringify(flow)}\n`, "utf8");
    this.invocation = { ...this.invocation, flowCount: this.invocation.flowCount + 1 };
    this.writeInvocation();
  }

  /**
   * Stamp `finishedAt`, and for a sweep the configuration each variant
   * actually resolved to. A no-op when no flow was recorded. After a
   * write failure it still tries once, so invocation.json says how many
   * flows made it and why recording stopped.
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

  /** Write to a temp file and rename it over, so a kill mid-write cannot truncate invocation.json. */
  private writeInvocation(): void {
    const tmp = join(this.dir, `.${INVOCATION_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(this.invocation, null, 2)}\n`, "utf8");
    renameSync(tmp, join(this.dir, INVOCATION_FILE));
  }
}

export type FlowRunner = (input: RunForFixtureInput, deps: RunForFixtureDeps) => Promise<RunForFixtureResult>;

export interface RecordingOptions {
  /**
   * Rewrites each flow record before it is appended, e.g. the
   * extraction-only mode nulls the match fields its runner reports as 0.
   * Defaults to no change.
   */
  readonly adjust?: (record: FlowRecord) => FlowRecord;
}

/**
 * Wrap `runForFixture` so every flow is recorded. Without a recorder the
 * runner is returned unchanged, so a run without `--record` does exactly
 * what it did before.
 */
export function recordingRunner(
  recorder: FlowRecorder | undefined,
  tokenSource: string,
  run: FlowRunner = runForFixture,
  options: RecordingOptions = {},
): FlowRunner {
  const adjust = options.adjust ?? ((r: FlowRecord): FlowRecord => r);
  if (recorder === undefined) return run;
  return async (input, deps) => {
    if (recorder.disabled) return run(input, deps);
    const trace = newFlowTrace();
    const variant = recorder.variant;
    // A sweep variant may run under its own token source; the effort
    // sent depends on it (CLI sources drop output_config).
    const flowTokenSource = recorder.variantTokenSource ?? tokenSource;
    let stages: StageConfigs;
    let startedAt: string;
    try {
      stages = captureStageConfig(flowTokenSource);
      startedAt = recorder.now().toISOString();
    } catch (err) {
      recorder.disable(err);
      return run(input, deps);
    }
    const result = await run(input, { ...deps, trace });
    // The flow is paid for by now: a failure to record it must not
    // abort the run or lose its result.
    try {
      const finishedAt = recorder.now().toISOString();
      recorder.append(
        adjust(buildFlowRecord(
          {
            invocationId: recorder.invocationId,
            variant,
            tokenSource: flowTokenSource,
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
        )),
      );
    } catch (err) {
      recorder.disable(err);
    }
    return result;
  };
}
