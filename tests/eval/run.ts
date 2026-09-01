#!/usr/bin/env -S tsx
/**
 * Eval harness entry point. Walks `tests/fixtures/` for fixture
 * inputs, runs the (stub, until Phase 1) extraction/matching
 * pipeline, scores against expected outputs, and prints a report.
 *
 * Phase 0 scope: skeleton that runs green on an empty fixture set
 * (or a handful of hand-authored fixtures) and demonstrates the
 * full pipeline wiring. Phase 1 (#25) populates the corpus and
 * flips the 80/80 CI gate blocking.
 *
 * Usage:
 *   npm run eval               — smoke mode (default)
 *   npm run eval -- --full     — full corpus (projection-guard gated)
 *
 * Stage cache (#389). Extraction / JD parsing / embeddings are served
 * from `tests/eval/.cache/` on a key hit. Matching itself has no LLM
 * call, so a warm cache makes matching-layer tuning (#177 workstream
 * A, score weights, ontology) run offline at zero cost — including
 * with no API keys set at all.
 *   --no-cache                 — bypass the cache entirely
 *   --refresh-cache            — ignore stored entries but rewrite them
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  anthropicForCli,
} from "../../functions/src/llm/anthropic.ts";
import { openaiForCli } from "../../functions/src/llm/openai.ts";
import { PROMPT_CONFIG } from "../../functions/src/prompts/config.js";
import {
  getPromptVersionOverrides,
  setPromptVersionOverrides,
} from "../../functions/src/prompts/loader.js";

import { resolveCacheMode, StageCache } from "./cache.js";
import {
  claudeCliClient,
  CLI_ADAPTER_VERSION,
  isTokenSourceKind,
  TOKEN_SOURCE_KINDS,
  type TokenSourceKind,
} from "./tokenSource.js";
import { checkCaps, DEFAULT_CAPS, shouldBlock } from "./projection.js";
import { assertModelsPriced, parseVariants, runSweep } from "./sweep.js";
import { formatReport, type EvalReport, type FixtureResult } from "./report.js";
import { runForFixture, type RunForFixtureResult } from "./runForFixture.js";

type Mode = "smoke" | "full";

function parseMode(argv: readonly string[]): Mode {
  return argv.includes("--full") ? "full" : "smoke";
}

/**
 * Parse `--samples N` / `--samples=N` from argv. Default 1.
 *
 * **Why this exists.** LLM extraction is non-deterministic at
 * temperature > 0 — the same fixture pair produces 22 vs 24
 * Units across runs, which cascades into match-accuracy variance
 * of ~8pp on a single fixture (live-measured during PR #168
 * review). A single-run reading can land above or below the
 * 80/80 PRD bar for the same code, making per-PR verification
 * unreliable.
 *
 * Multi-sample averaging stabilizes the reading: run extraction
 * + matching N times per (resume, JD) pair, report the mean +
 * min/max range. Default 1 keeps the existing behavior; opt
 * into N>1 only when you want stable numbers (PR review,
 * benchmark runs, etc.) since cost scales linearly.
 *
 * Rejects: 0, negative, non-integer, non-numeric forms.
 * The projection guard scales planned spend by `samples` so
 * a `--samples 5 --full` run on a 100-cell labeled corpus
 * doesn't silently project 1× spend.
 */
/**
 * Parse `--token-source <kind>` / `--token-source=<kind>`. Default
 * `api`, so an unflagged run behaves exactly as before.
 *
 * Rejects an unknown kind or token-source option loudly: a typo that
 * silently falls back to `api` would spend real money on a run the
 * operator believed was subscription-billed.
 */
/**
 * Cache-key discriminators for a token source.
 *
 * Codex P1: unconditionally adding `{ tokenSource }` changed all four
 * stage hashes for ordinary `api` runs, because every entry written by
 * the pre-#389 harness was keyed with NO discriminator. An operator
 * upgrading with a fully warm cache would silently lose all of it and
 * pay to re-warm — the exact cost #391 exists to remove.
 *
 * `api` therefore keeps the legacy keyspace (no discriminator), and
 * only the CLI sources add one. That still gives the property the
 * discriminator was introduced for: CLI-produced entries never collide
 * with metered-API entries, which is what makes comparing them
 * meaningful.
 */
export function cacheDiscriminatorsFor(
  tokenSource: TokenSourceKind,
): Readonly<Record<string, string>> | undefined {
  // Codex P2: `tokenSource` alone pins WHICH adapter produced an entry,
  // not WHICH VERSION of it. `cache.ts`'s STAGE_IMPL_VERSION covers the
  // production pipeline and explicitly not this adapter, so without the
  // version here a warm CLI cache keeps hitting after `tokenSource.ts`
  // changes its prompt rewrite, flags, or response adaptation — and the
  // sweep replays pre-change results through the path it was run to
  // measure.
  return tokenSource === "api"
    ? undefined
    : { tokenSource, cliAdapter: String(CLI_ADAPTER_VERSION) };
}

/** Flags that consume the following token as their value. */
const FLAGS_WITH_VALUES: readonly string[] = [
  "--samples",
  "--prompt",
  "--variant",
  "--token-source",
];

/** Flags that stand alone; an `=value` on these is a mistake. */
const BOOLEAN_FLAGS: readonly string[] = [
  "--full",
  "--smoke",
  "--no-cache",
  "--refresh-cache",
];

/** Every flag `main` understands. Anything else is an operator typo. */
const KNOWN_FLAGS: readonly string[] = [...FLAGS_WITH_VALUES, ...BOOLEAN_FLAGS];

/**
 * Reject unrecognized argv before any dispatch decision is made.
 *
 * Codex P1: the per-parser guards each cover only their own
 * neighbourhood — `parseTokenSource` rejects `--token-*`,
 * `parseVariants` rejects `--variant*`. A typo missing those prefixes
 * entirely (`--tokn-source claude-cli`, `--token_source claude-cli`)
 * matched nothing, was silently ignored, and left `parseTokenSource`
 * returning its `api` default. With both keys present `main` then
 * dispatched a full corpus of METERED Anthropic calls for an operator
 * who had asked to bill the run to a subscription.
 *
 * CodeRabbit P1: checking only `--`-prefixed tokens left the same hole
 * open one keystroke further — `--full token-source claude-cli` (a
 * dropped leading `--`) parsed as a stray positional, was ignored, and
 * produced exactly the same silent metered run. Nothing else in the
 * harness consumes positionals, so an unconsumed one is always a
 * mistake. `--full=1` is rejected for the same reason: a value on a
 * boolean flag means the operator believed it did something.
 *
 * A closed allowlist over BOTH shapes is the only form that closes the
 * class; per-parser prefix checks can only catch typos near their own
 * flag.
 */
export function assertKnownFlags(argv: readonly string[]): void {
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      // Not consumed as a value below, so it is a stray positional.
      unknown.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!KNOWN_FLAGS.includes(name)) {
      unknown.push(arg);
      continue;
    }
    if (eq !== -1 && BOOLEAN_FLAGS.includes(name)) {
      unknown.push(arg);
      continue;
    }
    // Consume this flag's value so it is not read as a positional.
    // Mirrors the parsers' own rule that a value never starts with
    // `--`, so `--samples --full` still reaches parseSamples' error.
    if (eq === -1 && FLAGS_WITH_VALUES.includes(name)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) i += 1;
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognized argument(s): ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
        `Known flags: ${KNOWN_FLAGS.join(", ")}. Refusing to run — an ignored ` +
        `argument silently falls back to the metered API default, spending real ` +
        `money on a run you may have meant to bill to a subscription.`,
    );
  }
}

export function parseTokenSource(argv: readonly string[]): TokenSourceKind {
  const read = (raw: string | undefined): TokenSourceKind => {
    if (raw === undefined || raw.startsWith("--")) {
      throw new Error(
        `--token-source requires a value (one of ${TOKEN_SOURCE_KINDS.join(", ")})`,
      );
    }
    if (!isTokenSourceKind(raw)) {
      throw new Error(
        `--token-source must be one of ${TOKEN_SOURCE_KINDS.join(", ")} (got ${JSON.stringify(raw)})`,
      );
    }
    return raw;
  };
  // Codex P2: scan every occurrence rather than returning on the
  // first. A composed command (a wrapper prepending `--token-source
  // api`, a caller appending `--token-source claude-cli`) previously
  // selected the wrapper's value silently — the metered API ran a
  // billing source the caller explicitly overrode. Repeats of the
  // SAME value are harmless (composition can legitimately produce
  // them); a genuine conflict between two different values is a
  // caller error and fails loudly rather than picking one silently.
  let found: TokenSourceKind | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: TokenSourceKind | undefined;
    if (arg === "--token-source") {
      value = read(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--token-source=")) {
      value = read(arg.slice("--token-source=".length));
    } else if (arg.startsWith("--token-")) {
      throw new Error(
        `Unknown token-source option ${JSON.stringify(arg)}. Use --token-source.`,
      );
    }
    if (value === undefined) continue;
    if (found !== undefined && found !== value) {
      throw new Error(
        `--token-source specified with conflicting values (${found} vs ${value}); pass it once`,
      );
    }
    found = value;
  }
  return found ?? "api";
}

/**
 * Embeddings-only per-flow estimate, for runs whose LLM tokens come
 * from a subscription CLI rather than the metered API.
 *
 * A flow embeds ~20 Unit summaries plus ~15 Requirement strings at
 * ~50 tokens each — about 1,750 tokens, or ~$0.000035 at
 * `text-embedding-3-small`'s $0.02/1M. The constant is ~30x that for
 * headroom while staying three orders of magnitude under the generic
 * per-flow figure.
 *
 * Codex P1: reusing the generic estimate's OpenAI share (30% of
 * $0.75) for CLI runs projected $45 for a 10x10 corpus and refused it
 * at the $23.75 threshold — blocking exactly the subscription-backed
 * runs this exists to enable. This applies to the NORMAL path too,
 * not just sweeps: a plain `--token-source claude-cli --full` was
 * projecting $52.50 of Anthropic spend it never incurs.
 */
const PER_FLOW_EMBEDDINGS_ONLY_USD = 0.001;

/**
 * Planned spend, split by whether LLM tokens are metered. Anthropic
 * spend is zero for a CLI source because those tokens come from the
 * subscription, not the API budget the caps govern.
 */
export function estimateSpendForSource(
  mode: Mode,
  flowCount: number,
  tokenSource: TokenSourceKind,
): { anthropicUsd: number; openaiUsd: number; firebaseUsd: number } {
  if (tokenSource === "api") return estimatePlannedSpend(mode, flowCount);
  return {
    anthropicUsd: 0,
    openaiUsd: flowCount * PER_FLOW_EMBEDDINGS_ONLY_USD,
    firebaseUsd: 0,
  };
}

export function parseSamples(argv: readonly string[]): number {
  // Accept both `--samples 5` and `--samples=5`.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--samples") {
      const value = argv[i + 1];
      // CodeRabbit Nit on PR #172: reject `--samples --full` (and
      // any other flag-as-value) at this layer rather than letting
      // it fall into the numeric validator. The numeric validator
      // would surface a confusing "must be a positive integer (got
      // \"--full\")" message; "requires a positive integer" is the
      // accurate cause. A value that looks like a flag is missing.
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          "--samples requires a positive integer (e.g. `--samples 3`)",
        );
      }
      return validateSamples(value);
    }
    if (arg.startsWith("--samples=")) {
      return validateSamples(arg.slice("--samples=".length));
    }
  }
  return 1;
}

function validateSamples(raw: string): number {
  // Reject: empty, NaN, fractional, negative, zero.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--samples must be a positive integer (got ${JSON.stringify(raw)})`,
    );
  }
  const n = Number.parseInt(raw, 10);
  if (n < 1) {
    throw new Error(
      `--samples must be >= 1 (got ${n})`,
    );
  }
  return n;
}

/**
 * Parse `--prompt stage/name=version` arguments. Multi-arg friendly:
 * `--prompt extraction/resume=v2 --prompt parsing/jd=v3` returns
 * `{ "extraction/resume": "v2", "parsing/jd": "v3" }`. Also accepts
 * the `--prompt=KEY=VALUE` form for parity with `--samples=` etc.
 *
 * Throws on malformed input (no slash, no equals, empty parts) so
 * a typo fails loudly at startup instead of silently being ignored
 * and producing a default-version run with the wrong report header.
 *
 * **Why a flag and not an env var.** The ad-hoc form
 * `MATCHLINE_PROMPT_OVERRIDES="extraction/resume=v2"` is more
 * discoverable in CI logs and shell history than the comma-blob
 * form, plays nicely with shell completion, and the parse error
 * surfaces at argv-parsing time rather than midway through the
 * pipeline.
 */
export function parsePromptOverrides(
  argv: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let raw: string | undefined;
    if (arg === "--prompt") {
      raw = argv[i + 1];
      if (raw === undefined) {
        throw new Error(
          "--prompt requires a STAGE/NAME=VERSION argument (e.g. `--prompt extraction/resume=v2`)",
        );
      }
      i += 1;
    } else if (arg.startsWith("--prompt=")) {
      raw = arg.slice("--prompt=".length);
    } else {
      continue;
    }
    const eqIdx = raw.indexOf("=");
    if (eqIdx <= 0 || eqIdx === raw.length - 1) {
      throw new Error(
        `--prompt argument must be STAGE/NAME=VERSION with non-empty parts on both sides (got "${raw}")`,
      );
    }
    const key = raw.slice(0, eqIdx);
    const version = raw.slice(eqIdx + 1);
    // Codex P1 on PR #178: the prior shape (`includes("/") &&
    // !startsWith("/") && !endsWith("/")`) accepted three-segment
    // keys like `extraction/resume/typo=v2`, which never match a
    // configured (stage, name) entry — the override silently
    // invalidates the A/B run because nothing in PROMPT_CONFIG can
    // ever be `extraction/resume/typo`. Require EXACTLY one slash
    // with non-empty alphanumeric+`_`+`-` parts on both sides so a
    // typo fails loudly here instead of silently producing a
    // default-version run with the wrong report header.
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(
        `--prompt key must be STAGE/NAME with exactly one slash and non-empty alphanumeric segments on both sides (got "${key}")`,
      );
    }
    // Codex P1 on PR #178: version flows directly into
    // `loadPromptText`'s `join(promptsRoot, stage, "${name}.${version}.md")`
    // call. A version containing `/` or `..` would resolve outside
    // `promptsRoot/<stage>/` (e.g. `version="../../outside"` →
    // attempts to read a file outside the prompts tree). Restrict
    // to alphanumeric + `_` + `-` so the version slot can never
    // escape its directory by construction. Existing versions
    // (`v1`) match; future `v2-rc1` / `v3` also match. A version
    // that needs a `.` (e.g. `v1.0`) would require widening this
    // regex AND adding an explicit `..` rejection — defer until
    // someone actually wants that shape.
    if (!/^[A-Za-z0-9_-]+$/.test(version)) {
      throw new Error(
        `--prompt VERSION must be alphanumeric + '_'/'-' only (got "${version}"). ` +
          `Slashes and '..' are rejected to prevent path traversal in the prompt loader.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new Error(
        `--prompt ${key} specified twice; pass each (stage, name) at most once per run`,
      );
    }
    out[key] = version;
  }
  return out;
}

function listFixtures(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isFile() &&
          !d.name.startsWith(".") &&
          d.name.endsWith(ext) &&
          // Skip READMEs and other meta files that happen to share the ext.
          d.name.toLowerCase() !== `readme${ext}`,
      )
      .map((d) => d.name);
  } catch (err) {
    // ENOENT is expected — a fixture subdir simply doesn't exist yet.
    // Anything else (permission, I/O) should fail visibly so a broken
    // mount or a typo'd path never silently reports "no fixtures".
    if (isEnoent(err)) return [];
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * A stand-in LLM client for credential-free runs (#389).
 *
 * Satisfies both the Anthropic (`messages.create`) and OpenAI
 * (`embeddings.create`) shapes the pipelines call, and throws on
 * either. It is only ever installed when the stage cache is in
 * read-write mode, so the intended path is that every stage hits and
 * this is never invoked.
 *
 * The failure message has to be actionable, because reaching it means
 * the operator's mental model was wrong: they believed the cache was
 * warm for this fixture and it wasn't. `runForFixture` captures the
 * throw into that fixture's `error` field, so one cold cell surfaces
 * as a failed row rather than aborting the corpus.
 */
export function offlineOnlyClient<T>(provider: string, envVar: string): T {
  const fail = (): never => {
    throw new Error(
      `Cache miss needs a live ${provider} call, but ${envVar} is not set. ` +
        `This run started without credentials because the stage cache was ` +
        `expected to serve every stage offline. Either export ${envVar} to ` +
        `fill the gap, or warm the cache for this fixture first.`,
    );
  };
  return {
    messages: { create: fail },
    embeddings: { create: fail },
  } as T;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Codex P1: before ANY dispatch decision, including the metered-API
  // default that an ignored `--token-source` typo silently selects.
  assertKnownFlags(argv);
  const mode = parseMode(argv);
  const samples = parseSamples(argv);
  // Apply `--prompt stage/name=version` overrides BEFORE any
  // pipeline call. Production paths use the loader's default
  // (PROMPT_CONFIG); the eval harness optionally swaps in a
  // different prompt version per (stage, name) for A/B comparison.
  // See functions/src/prompts/loader.ts § runtimeOverrides.
  const promptOverrides = parsePromptOverrides(argv);
  setPromptVersionOverrides(promptOverrides);
  // Stage cache (#389). `resolveCacheMode` forces `bypass` whenever
  // `--samples N > 1` so repeated samples still measure real
  // run-to-run variance instead of replaying one cached answer N
  // times — see cache.ts § Sampling.
  const tokenSource = parseTokenSource(argv);
  // Parsed and pricing-validated up front so a malformed --variant
  // fails loudly even on the no-keys stub path.
  // Codex P3: `--varaint 'haiku:...'` was ignored, so `main` proceeded
  // with an ordinary run that still spends the default model's tokens
  // while producing none of the comparison the operator asked for.
  for (const arg of argv) {
    const flag = arg.split("=")[0]!;
    if (flag !== "--variant" && /^--var/i.test(flag)) {
      throw new Error(
        `Unknown flag ${JSON.stringify(flag)} — did you mean --variant? ` +
          `Refusing to run, because ignoring it would spend tokens on a ` +
          `non-sweep run while looking like the sweep you asked for.`,
      );
    }
  }
  const variants = parseVariants(argv, tokenSource);
  assertModelsPriced(variants);
  const cacheMode = resolveCacheMode(argv, samples);
  const cache = new StageCache({ mode: cacheMode });
  // Omitted from the report when caching is off, so a `--no-cache`
  // run's output stays byte-identical to the pre-#389 shape.
  // Projection-guard baseline. Hoisted above the sweep branch so the
  // sweep and the normal path share ONE definition — duplicating it
  // is how the sweep came to bypass the guard entirely in the first
  // place. Phase 1 (#41) replaces this mock with a real llm_calls
  // aggregation.
  const currentUsage = { anthropicUsd: 0, openaiUsd: 0, firebaseUsd: 0 };
  const cacheRollup = (): EvalReport["cache"] => {
    if (cacheMode === "bypass") return undefined;
    const s = cache.stats();
    return { mode: cacheMode, hits: s.hits, misses: s.misses };
  };
  const fixturesDir = join(process.cwd(), "tests", "fixtures");
  const resumeFixtures = listFixtures(join(fixturesDir, "resumes"), ".txt");
  const jdFixtures = listFixtures(join(fixturesDir, "jds"), ".txt");

  // #136: real extraction/parsing/matching runs when both
  // ANTHROPIC_API_KEY and OPENAI_API_KEY are present in the
  // environment. Without keys, fall back to the previous
  // "fixtures listed, not scored" stub so CI's non-blocking
  // smoke run still produces a report shape.
  const haveAnthropicKey =
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.length > 0;
  const haveOpenAiKey =
    typeof process.env.OPENAI_API_KEY === "string" &&
    process.env.OPENAI_API_KEY.length > 0;
  // CLI token sources replace only Anthropic completion tokens;
  // embeddings still call OpenAI. Requiring ANTHROPIC_API_KEY for a
  // claude-cli run turned an otherwise authenticated subscription run
  // into the no-key stub before the adapter could ever execute.
  const hasLiveCredentials =
    haveOpenAiKey && (tokenSource === "api" ? haveAnthropicKey : true);


  // Smoke mode pins to a SPECIFIC (resume, JD) pair via
  // `selectFixturesForMode` (extracted as a pure helper so the
  // bare-ID-vs-`.txt`-filename mismatch and the missing-fixture
  // throw paths are testable without touching the filesystem).
  const { selectedResumes, selectedJds } = selectFixturesForMode(
    mode,
    resumeFixtures,
    jdFixtures,
    fixturesDir,
  );

  // Build (resume, jd) pairs. Smoke = single pair (smoke pin
  // points at a labeled pair already). Full = cross product
  // for the corpus run, then filter to pairs that actually
  // have labeled `expected-matches/*.json` so the eval doesn't
  // mark every unlabeled cell as a 0/0 failed-fixture entry
  // (Codex P1 on PR #151 post-merge).
  const allPairs: Array<{ resume: string; jd: string }> = [];
  for (const r of selectedResumes) {
    for (const j of selectedJds) {
      allPairs.push({ resume: r, jd: j });
    }
  }
  const { labeled: pairs, skipped } = filterToLabeledPairs(
    allPairs,
    fixturesDir,
  );

  const fixtureResults: FixtureResult[] = [];
  // Flow tallies for the all-failure exit check below. Counted from the
  // raw per-sample results, because `FixtureResult` maps a failure to
  // 0-accuracy rather than carrying an ok flag.
  let attemptedFlows = 0;
  let successfulFlows = 0;
  // Emit a "skipped" entry per unlabeled pair so the operator
  // sees the gap explicitly. `extractionAccuracy: null` and
  // `matchAccuracy: null` keep skipped cells out of the mean
  // (the aggregator already filters nulls), so corpus accuracy
  // is dominated by labeled pairs — not by ENOENT-driven
  // false-zeros.
  for (const sk of skipped) {
    const resumeId = sk.resume.replace(/\.txt$/, "");
    const jdId = sk.jd.replace(/\.txt$/, "");
    fixtureResults.push({
      id: `${resumeId}__${jdId}`,
      extractionAccuracy: null,
      matchAccuracy: null,
      latencyMs: null,
      costUsd: null,
      notes:
        `skipped: no tests/fixtures/expected-matches/${resumeId}__${jdId}.json. ` +
        `Label this pair to include in the corpus run.`,
    });
  }
  // #389: a fully warm cache needs no network at all, so requiring
  // keys would block the headline use case — offline matching /
  // ontology tuning at zero cost. When the cache can serve reads we
  // attempt the run with non-networking placeholder clients; a real
  // cache MISS then fails that fixture loudly with an actionable
  // message instead of silently making an unauthenticated call.
  //
  // Codex P2 round 3: `cacheMode === "read-write"` alone was not
  // enough. On a clean checkout with no keys the cache directory is
  // empty (it's gitignored), so this ran every labeled pair against
  // throwing placeholders, sat through the extraction retry backoff,
  // and printed failed 0-score rows — replacing the documented no-key
  // stub listing that CI's `npm run eval` depends on. Requiring the
  // cache to be non-empty restores that contract exactly: nothing on
  // disk means nothing to serve, so fall back to the stub.
  const canAttemptOffline = cacheMode === "read-write" && cache.hasEntries();
  const runnable = pairs.length > 0 && (hasLiveCredentials || canAttemptOffline);
  if (runnable) {
    // Codex P2: select each client on ITS OWN key. Gating both on
    // `haveKeys` meant a run with only ANTHROPIC_API_KEY set fell back
    // to placeholders for both providers, so an Anthropic cache miss
    // failed even though the key needed to fill it was right there —
    // directly contradicting the placeholder's own advice.
    // The CLI sources satisfy the same `messages.create` shape the
    // pipelines already inject, so nothing downstream changes. They
    // take precedence over the key-based selection below because they
    // do not use a key at all.
    const anthropicClient =
      tokenSource === "claude-cli"
        ? claudeCliClient()
        : haveAnthropicKey
          ? anthropicForCli()
          : offlineOnlyClient<ReturnType<typeof anthropicForCli>>("Anthropic", "ANTHROPIC_API_KEY");
    const openaiClient = haveOpenAiKey
      ? openaiForCli()
      : offlineOnlyClient<ReturnType<typeof openaiForCli>>("OpenAI", "OPENAI_API_KEY");
    // -- Sweep mode --------------------------------------------------
    // `--variant` turns the run into a matrix and prints a
    // quality-vs-cost Pareto table instead of a single report.
    if (variants.length > 0) {
      const sweepFlows = pairs.length * samples * variants.length;
      // Codex P2: the normal path scales by real cache state but this
      // did not, so a warm sweep — which performs few or no paid
      // calls — could be refused for spend it will never incur. The
      // guard runs BEFORE the sweep, so it uses whatever the cache
      // already holds from previous runs rather than this run's
      // outcome; that is the conservative direction.
      const sweepChecks = checkCaps(
        currentUsage,
        scaleSpendByProvider(
          estimateSpendForSource(mode, sweepFlows, tokenSource),
          cache.stats(),
        ),
        DEFAULT_CAPS,
      );
      if (shouldBlock(sweepChecks)) {
        console.error(
          `\nRefusing to sweep ${variants.length} variant(s) x ${pairs.length} pair(s) x ` +
            `${samples} sample(s) = ${sweepFlows} flows: projection exceeds a monthly cap.\n` +
            "Reduce --variant count, or use --token-source claude-cli so LLM tokens " +
            "come from the subscription instead of the metered API.\n",
        );
        console.log(formatReport(buildReport(mode, fixtureResults, sweepChecks, cacheRollup(), tokenSource)));
        return 1;
      }
      const runCorpus = async (): Promise<readonly RunForFixtureResult[]> => {
        const out: RunForFixtureResult[] = [];
        for (const pair of pairs) {
          for (let i = 0; i < samples; i++) {
            out.push(
              await runForFixture(
                {
                  resumeFixtureId: pair.resume.replace(/\.txt$/, ""),
                  jdFixtureId: pair.jd.replace(/\.txt$/, ""),
                },
                {
                  anthropicClient,
                  // Codex P2: only `api` is metered — CLI sources are
                  // subscription-billed, so their Anthropic usage must
                  // not count as real spend in `costUsd`.
                  anthropicIsMetered: tokenSource === "api",
                  openaiClient,
                  cache,
                  cacheDiscriminators: cacheDiscriminatorsFor(tokenSource),
                },
              ),
            );
          }
        }
        return out;
      };
      // Command-wide `--prompt` flags survive into every variant;
      // variant-level prompt overrides layer on top.
      const { results, report } = await runSweep(
        variants,
        { runCorpus },
        { basePromptVersions: promptOverrides },
      );
      console.log(report);
      // An all-failure sweep produced no usable measurements; CI and
      // shell callers must not read that as success.
      if (!results.some((r) => r.flows > 0 && r.failures < r.flows)) {
        console.error(
          "\nSweep produced no usable measurements: every flow failed in every " +
            "variant. Check credentials, model availability, and the token source.\n",
        );
        return 1;
      }
      return 0;
    }

    for (const pair of pairs) {
      // Strip `.txt` from the fixture filename to get the
      // fixture id (resumes/jds are always `<id>.txt`).
      const resumeFixtureId = pair.resume.replace(/\.txt$/, "");
      const jdFixtureId = pair.jd.replace(/\.txt$/, "");
      // Multi-sample averaging: when `--samples N` (N > 1) is
      // passed, run extraction + matching N times per pair and
      // aggregate. Default 1 keeps the single-run cost +
      // behavior. See parseSamples docstring for rationale.
      const samplesForThisPair: RunForFixtureResult[] = [];
      for (let i = 0; i < samples; i++) {
        samplesForThisPair.push(
          await runForFixture(
            { resumeFixtureId, jdFixtureId },
            {
              anthropicClient,
              // Codex P2: only `api` is metered — CLI sources are
              // subscription-billed, so their Anthropic usage must
              // not count as real spend in `costUsd`.
              anthropicIsMetered: tokenSource === "api",
              openaiClient,
              cache,
              // Keep API- and CLI-produced entries in separate
              // keyspaces — comparing them is the point.
              cacheDiscriminators: cacheDiscriminatorsFor(tokenSource),
            },
          ),
        );
      }
      // Codex P2: the sweep branch already refuses to report success
      // when nothing measured, but the ordinary branch returned 0
      // unconditionally. `runForFixture` turns every adapter exception
      // into an `ok: false` row, so a `--token-source claude-cli` run
      // against a missing, logged-out, or preflight-rejected Claude
      // printed a table of failures and still exited 0 — CI and shell
      // callers read that as a passing eval.
      attemptedFlows += samplesForThisPair.length;
      successfulFlows += samplesForThisPair.filter((r) => r.ok).length;
      fixtureResults.push(aggregateSampledFixture(samplesForThisPair));
    }
  } else if (variants.length > 0) {
    // Codex P2: a requested sweep that cannot run used to print the
    // ordinary no-key fixture listing and exit 0, so CI and shell
    // callers read "produced no comparison at all" as success. If the
    // operator asked for a matrix, silence is the wrong answer.
    console.error(
      `\nRefusing to sweep ${variants.length} variant(s): ` +
        (pairs.length === 0
          ? "no labeled (resume, JD) pairs are available. Label at least one pair under tests/fixtures/expected-matches/.\n"
          : `credentials for --token-source ${tokenSource} are missing.\n`),
    );
    return 2;
  } else {
    // No API keys (or no JD fixtures yet) — list each
    // resume fixture without scoring. Same shape as the
    // pre-#136 Phase 0 stub.
    const stubReason = hasLiveCredentials
      ? "no JD fixtures available — extraction + matching needs at least one (resume, JD) pair"
      : cacheMode === "read-write"
        ? tokenSource === "api"
          ? "ANTHROPIC_API_KEY and/or OPENAI_API_KEY not set — export both before running API scoring"
          : "OPENAI_API_KEY not set — embeddings require it even with a subscription CLI token source"
        : // Keys absent AND the cache was explicitly disabled, so the
          // offline path isn't available either. Say which flag closed
          // it so the operator isn't left guessing (#389).
          `${tokenSource === "api" ? "ANTHROPIC_API_KEY and/or OPENAI_API_KEY" : "OPENAI_API_KEY"} not set, and the stage cache is ` +
          `in ${cacheMode} mode so it cannot serve the run offline — export the required key, ` +
          "or drop --no-cache/--refresh-cache/--samples so a warm cache can be used";
    for (const r of selectedResumes) {
      fixtureResults.push({
        id: r,
        extractionAccuracy: null,
        matchAccuracy: null,
        latencyMs: null,
        costUsd: null,
        notes: stubReason,
      });
    }
  }

  // Projection guard: even with no real LLM calls today, the harness
  // always reports against the caps so the output shape is stable
  // and operators see the monthly picture. Phase 1 replaces the
  // zero-currentUsage mock with a real Firestore aggregation.
  // A flow is one (resume × JD) pair THAT WILL ACTUALLY RUN —
  // skipped pairs (no expected-matches label yet) don't dispatch
  // to the engine and therefore don't add to projected spend.
  // Pre-#151-postmerge this used the full listing counts and
  // would overshoot — projecting 110 flows on the current corpus
  // when only 1 (the canonical labeled pair) actually runs.
  // `pairs.length` is post-`filterToLabeledPairs`. For smoke
  // mode this is identical to the prior count (smoke pin always
  // points at a labeled pair); for full mode it falls to the
  // labeled subset.
  //
  // `--samples N` multiplies the flow count: N independent
  // runs per pair → N× LLM calls → N× projected spend. The
  // guard MUST scale by samples or a `--samples 5 --full`
  // run on a 100-cell labeled corpus would silently project
  // 1× and let real spend blow past caps.
  const flowCount = pairs.length * samples;
  // Codex P1: the guard used to project all `flowCount` pairs at the
  // flat $0.75 estimate regardless of cache state, so a fully warm
  // 10x10 corpus — which performs ZERO paid calls — would exceed the
  // Anthropic cap and exit 1, breaking the headline offline
  // matching-tuning workflow. Scale by the share of stages that
  // actually needed a live call. This guard runs after execution, so
  // the real hit/miss split is already known.
  const plannedAdd = scaleSpendByProvider(
    estimateSpendForSource(mode, flowCount, tokenSource),
    cache.stats(),
  );
  const capChecks = checkCaps(currentUsage, plannedAdd, DEFAULT_CAPS);

  if (shouldBlock(capChecks)) {
    // Projection guard is enforcing from day 1: once Phase 1 wires
    // real `currentUsage` from the llm_calls Firestore aggregation,
    // this branch will trip in actual over-budget scenarios. Keeping
    // it non-enforcing "until Phase 1" would ship a guard CI treats
    // as success — which is exactly the failure mode a guard exists
    // to prevent. Exit 1 now, so the gate works identically the
    // moment real spend flows through.
    //
    // Cursor on PR #172: smoke mode now ALSO blocks when the
    // projection exceeds a cap. Pre-fix the block was scoped to
    // `mode === "full"`, but with `--samples N` smoke runs incur
    // real LLM spend that scales linearly. A `--samples 200` smoke
    // run would have run 200 paid flows under the prior gate even
    // though projected spend exceeded monthly caps. The cap
    // protection is now mode-agnostic.
    const refusedDescriptor =
      mode === "full" ? "--full" : `--samples ${samples}`;
    console.error(
      `\nRefusing to run ${refusedDescriptor}: projection exceeds a monthly cap.\n` +
        "Re-run with --smoke / smaller --samples or wait for next month's cap reset.\n",
    );
    console.log(formatReport(buildReport(mode, fixtureResults, capChecks, cacheRollup(), tokenSource)));
    return 1;
  }

  const report = buildReport(mode, fixtureResults, capChecks, cacheRollup(), tokenSource);
  console.log(formatReport(report));
  console.log(
    `\n(fixtures available: ${resumeFixtures.length} resumes × ${jdFixtures.length} JDs)`,
  );

  // Codex P2: mirror the sweep branch's all-failure guard. Gated on
  // `attemptedFlows > 0` so the no-key and no-fixture listings — which
  // legitimately measure nothing and legitimately exit 0 — are
  // untouched.
  if (attemptedFlows > 0 && successfulFlows === 0) {
    console.error(
      `\nRun produced no usable measurements: all ${attemptedFlows} flow(s) failed. ` +
        "Check credentials, model availability, and the token source.\n",
    );
    return 1;
  }

  return 0;
}

/**
 * Aggregate N samples for one (resume, JD) pair into a single
 * FixtureResult. Mean of accuracy axes; sum of cost (the
 * operator paid for every sample); mean of latency. Failed
 * samples contribute 0 to accuracy means and their partial
 * cost to the cost sum (same shape as `toFixtureResult`'s
 * single-run failure path).
 *
 * The min/max range is surfaced in `notes` when N > 1 so
 * an operator can see the variance from a single report
 * without parsing a separate file.
 *
 * Pure: no I/O, no clock dep. Tested in isolation against
 * synthetic samples in `run.test.ts`.
 */
export function aggregateSampledFixture(
  results: readonly RunForFixtureResult[],
): FixtureResult {
  if (results.length === 0) {
    throw new Error("aggregateSampledFixture: empty samples");
  }
  const first = results[0]!;
  // Same-fixture invariant (cursor on PR #172): every sample
  // must share the same (resumeFixtureId, jdFixtureId) pair as
  // the first. Without this check, a caller that accidentally
  // mixes samples from different fixtures would silently
  // produce a `FixtureResult` labeled with the first fixture's
  // ID but with means averaged across heterogeneous content —
  // a false-positive accuracy reading attributed to the wrong
  // pair. Throw loudly at the boundary instead.
  for (let i = 1; i < results.length; i++) {
    const r = results[i]!;
    if (
      r.resumeFixtureId !== first.resumeFixtureId ||
      r.jdFixtureId !== first.jdFixtureId
    ) {
      throw new Error(
        `aggregateSampledFixture: heterogeneous samples — index 0 is ` +
          `(${first.resumeFixtureId}, ${first.jdFixtureId}) but index ${i} ` +
          `is (${r.resumeFixtureId}, ${r.jdFixtureId}). All samples passed ` +
          `to a single aggregation MUST be for the same (resume, JD) pair.`,
      );
    }
  }
  const id = `${first.resumeFixtureId}__${first.jdFixtureId}`;
  const n = results.length;

  // Per-sample accuracies: failed samples contribute 0 (same
  // semantics as the single-sample failure path in
  // `toFixtureResult`).
  const ext = results.map((r) => (r.ok ? r.extractionAccuracy : 0));
  const mat = results.map((r) => (r.ok ? r.matchAccuracy : 0));
  const meanExt = ext.reduce((a, b) => a + b, 0) / n;
  const meanMat = mat.reduce((a, b) => a + b, 0) / n;
  const meanLatency = results.reduce((a, r) => a + r.latencyMs, 0) / n;
  const totalCost = results.reduce((a, r) => a + r.costUsd, 0);
  // Codex P1: this function is what the real CLI path uses (
  // `toFixtureResult` only covers the single-result shape the tests
  // exercised), and it previously dropped `modeledCostUsd` entirely.
  // That left `totalModeledCostUsd` empty on every actual run,
  // silently defeating the cache-independent cost comparison this
  // change exists to provide.
  const totalModeledCost = results.reduce((a, r) => a + r.modeledCostUsd, 0);
  const cacheHits = results.reduce((a, r) => a + r.cacheHits, 0);

  // Failure tally — if any sample failed, surface in notes.
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);

  let notes: string;
  if (n === 1) {
    // Backward compat: single-sample shape produces the same
    // notes string `toFixtureResult` did.
    if (!first.ok) {
      notes = `failed (cost=$${first.costUsd.toFixed(4)}): ${first.error ?? "unknown error"}`;
    } else {
      notes = `extracted=${first.extractedUnitCount} reqs=${first.parsedRequirementCount} matches=${first.matchCount}`;
    }
  } else {
    // Multi-sample: lead with mean and explicit min-max ranges
    // on each accuracy axis, then per-run unit/req counts as a
    // compact tail (median run's counts as exemplar).
    const minExt = Math.min(...ext);
    const maxExt = Math.max(...ext);
    const minMat = Math.min(...mat);
    const maxMat = Math.max(...mat);
    const fmtPctRange = (mn: number, mx: number): string =>
      `${(mn * 100).toFixed(1)}–${(mx * 100).toFixed(1)}%`;
    const failTag = failed.length > 0 ? `; ${failed.length}/${n} failed` : "";
    const exemplar = succeeded[0] ?? first;
    notes =
      `${n} samples; ` +
      `extraction range ${fmtPctRange(minExt, maxExt)}, ` +
      `match range ${fmtPctRange(minMat, maxMat)}; ` +
      `~${exemplar.extractedUnitCount} units / ${exemplar.parsedRequirementCount} reqs / ${exemplar.matchCount} matches per run` +
      failTag;
  }

  return {
    id,
    extractionAccuracy: meanExt,
    matchAccuracy: meanMat,
    latencyMs: Math.round(meanLatency),
    costUsd: totalCost,
    modeledCostUsd: totalModeledCost,
    notes: cacheHits > 0 ? `${notes}; ${cacheHits} cached stage(s)` : notes,
  };
}

/**
 * Convert a per-fixture orchestration result into the
 * report-layer FixtureResult shape. Failed runs (`ok=false`)
 * still produce a result — the error is surfaced in `notes`
 * and accuracies are 0 so the corpus mean reflects the
 * failure (intentional: the gate should fail when fixtures
 * fail, not silently skip them).
 */
export function toFixtureResult(r: RunForFixtureResult): FixtureResult {
  const id = `${r.resumeFixtureId}__${r.jdFixtureId}`;
  if (!r.ok) {
    return {
      id,
      extractionAccuracy: 0,
      matchAccuracy: 0,
      latencyMs: r.latencyMs,
      // Surface the PARTIAL cost the orchestrator
      // accumulated before throwing. Earlier API calls
      // billed real tokens; zeroing them out of the CLI
      // report would hide spend during flaky runs and
      // break the aggregate-total contract. cursor #139
      // r3 caught the prior `costUsd: null` shape after
      // the orchestrator-level fix had already preserved
      // the partial total.
      costUsd: r.costUsd,
      notes: `failed (cost=$${r.costUsd.toFixed(4)}): ${r.error ?? "unknown error"}`,
    };
  }
  return {
    id,
    extractionAccuracy: r.extractionAccuracy,
    matchAccuracy: r.matchAccuracy,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    notes: `extracted=${r.extractedUnitCount} reqs=${r.parsedRequirementCount} matches=${r.matchCount}`,
  };
}

/**
 * Build the report's `promptVersions` field. Walks every
 * `(stage, name)` in `PROMPT_CONFIG`, marks each entry as `default`
 * (resolved version === config) or `override` (active runtime
 * override is winning), and returns them in stable
 * `${stage}/${name}` order so the report is reproducible.
 *
 * Pure: takes the override snapshot as input rather than reading
 * loader module state, so it's testable without setting overrides.
 */
export function resolvePromptVersionsForReport(
  promptConfig: typeof PROMPT_CONFIG = PROMPT_CONFIG,
  overrides: Readonly<Record<string, string>> = getPromptVersionOverrides(),
): EvalReport["promptVersions"] {
  const out: Array<{
    key: string;
    version: string;
    source: "default" | "override";
  }> = [];
  for (const stage of Object.keys(promptConfig).sort()) {
    const stageEntries = (promptConfig as Record<string, Record<string, string>>)[
      stage
    ];
    if (!stageEntries) continue;
    for (const name of Object.keys(stageEntries).sort()) {
      const key = `${stage}/${name}`;
      const override = overrides[key];
      const defaultVersion = stageEntries[name]!;
      out.push({
        key,
        version: override ?? defaultVersion,
        source: override !== undefined ? "override" : "default",
      });
    }
  }
  return out;
}

function buildReport(
  mode: Mode,
  fixtureResults: readonly FixtureResult[],
  capChecks: ReturnType<typeof checkCaps>,
  cache?: EvalReport["cache"],
  tokenSource?: string,
): EvalReport {
  const modeledCosts = fixtureResults
    .map((r) => r.modeledCostUsd)
    .filter((n): n is number => n !== null && n !== undefined);
  const latencies = fixtureResults
    .map((r) => r.latencyMs)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const costs = fixtureResults
    .map((r) => r.costUsd)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  return {
    mode,
    fixtureResults,
    capChecks,
    aggregate: {
      extractionAccuracyMean: mean(
        fixtureResults
          .map((r) => r.extractionAccuracy)
          .filter((n): n is number => n !== null),
      ),
      matchAccuracyMean: mean(
        fixtureResults
          .map((r) => r.matchAccuracy)
          .filter((n): n is number => n !== null),
      ),
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
      costP50: percentile(costs, 50),
      costP95: percentile(costs, 95),
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      totalModeledCostUsd:
        modeledCosts.length > 0 ? modeledCosts.reduce((a, b) => a + b, 0) : null,
    },
    promptVersions: resolvePromptVersionsForReport(),
    ...(cache !== undefined && { cache }),
    // Codex P2: without this a `--token-source claude-cli` run's report
    // was indistinguishable from a metered one, even though the source
    // changes both execution and accounting.
    ...(tokenSource !== undefined && { tokenSource }),
  };
}

/**
 * Pure cardinality: given the number of resume and JD fixtures in a
 * run, how many (resume × JD) flows will execute? Smoke mode pairs
 * the single selected resume with a single JD (or zero if none
 * exist); full mode is the full cross product.
 *
 * Exported for tests: the zero-JD regression (50 resumes × 0 JDs
 * should be 0 flows, not 50) was the second blocker from
 * nathanpayne-codex on #55.
 */
export function computeFlowCount(
  mode: Mode,
  resumeCount: number,
  jdCount: number,
): number {
  if (resumeCount <= 0 || jdCount <= 0) return 0;
  if (mode === "smoke") {
    // Smoke: one resume × one JD, capped at available fixtures.
    return Math.min(resumeCount, 1) * Math.min(jdCount, 1);
  }
  return resumeCount * jdCount;
}

/**
 * Smoke-mode fixture pin. Bare fixture IDs (no `.txt` extension) —
 * `listFixtures` returns `<id>.txt`-shaped names, so the comparison
 * is "ID ∈ stripped(filenames)" and the selected output always
 * carries the `.txt` suffix the rest of the pipeline expects.
 *
 * **Why constants, not slice(0, 1).** Codex P1 + cursor on PRs
 * #150 / #151: prior `slice(0, 1)` selected whatever filename
 * sorted first, which became one of the new unlabeled fixtures
 * the moment a corpus PR landed. `loadExpectedMatches` then threw
 * ENOENT before any LLM call and the smoke run reported a
 * guaranteed 0/0 instead of a meaningful signal. Pinning to a
 * SPECIFIC pair makes that regression structural — not behavioral.
 *
 * **Why this pair.** Nathan + Google SPM is the canonical fixture;
 * it has hand-curated `expected-matches/*.json` and the rest of
 * #137's labeling work keeps it current.
 */
export const SMOKE_RESUME = "nathan-2026";
export const SMOKE_JD = "google-compute-spm-2026";

/**
 * Select the resume + JD fixture filenames to evaluate for a given
 * mode. Pure: takes the listing arrays and returns the slice/pin —
 * no filesystem or process state. Extracted so the bare-ID-vs-
 * `.txt`-filename comparison and the missing-fixture throw paths
 * are testable without mocking the filesystem (the regression
 * cursor caught on the first smoke-pin attempt).
 *
 * Throws `Error` with a clear "update SMOKE_RESUME / SMOKE_JD"
 * message if either pinned fixture is absent from the listing,
 * so removing a pinned fixture fails loud at startup instead of
 * producing a confusing downstream `loadX` error.
 */
export function selectFixturesForMode(
  mode: Mode,
  resumeFixtures: readonly string[],
  jdFixtures: readonly string[],
  fixturesDir: string,
): { selectedResumes: string[]; selectedJds: string[] } {
  if (mode !== "smoke") {
    return {
      selectedResumes: [...resumeFixtures],
      selectedJds: [...jdFixtures],
    };
  }
  const stripTxt = (n: string): string => n.replace(/\.txt$/, "");
  const resumeIds = resumeFixtures.map(stripTxt);
  const jdIds = jdFixtures.map(stripTxt);
  if (!resumeIds.includes(SMOKE_RESUME)) {
    throw new Error(
      `Smoke mode pin: resume fixture "${SMOKE_RESUME}" not found in ${join(
        fixturesDir,
        "resumes",
      )}. Update SMOKE_RESUME in tests/eval/run.ts.`,
    );
  }
  if (!jdIds.includes(SMOKE_JD)) {
    throw new Error(
      `Smoke mode pin: JD fixture "${SMOKE_JD}" not found in ${join(
        fixturesDir,
        "jds",
      )}. Update SMOKE_JD in tests/eval/run.ts.`,
    );
  }
  return {
    selectedResumes: [`${SMOKE_RESUME}.txt`],
    selectedJds: [`${SMOKE_JD}.txt`],
  };
}

/**
 * Partition (resume, jd) pairs by whether their corresponding
 * `expected-matches/<resume>__<jd>.json` label file exists on
 * disk. Pairs without a label file are returned in `skipped`
 * so the harness can emit a per-pair "skipped" report entry
 * (with `extractionAccuracy: null` so the aggregate isn't
 * polluted) instead of dispatching the pair to the engine,
 * which would throw ENOENT inside `loadExpectedMatches`.
 *
 * **Why this exists** (Codex P1 on PR #151 post-merge):
 * the corpus PRs added 9 resumes × 10 JDs = 100 cells but
 * only the 1 canonical (`nathan-2026 × google-compute-spm-2026`)
 * cell has labels. A full-mode run on main would cascade-fail
 * the other 99 cells, marking each as a failed fixture
 * contributing 0% extraction + 0% match accuracy to the
 * aggregate. The eval would report a corrupted picture
 * dominated by label incompleteness, not by real prompt
 * quality.
 *
 * Intent: corpus accuracy is computed over **labeled cells
 * only** until the per-pair labeling work in #137 sub-issue 3
 * lands. Skipped cells stay visible in the per-fixture report
 * so it's obvious which pairs need labeling next.
 *
 * Pure: filesystem reads scoped to `expected-matches/` only;
 * no LLM, no Firestore, no process state.
 */
export function filterToLabeledPairs(
  pairs: ReadonlyArray<{ resume: string; jd: string }>,
  fixturesDir: string,
): {
  labeled: Array<{ resume: string; jd: string }>;
  skipped: Array<{ resume: string; jd: string }>;
} {
  const stripTxt = (n: string): string => n.replace(/\.txt$/, "");
  const labeled: Array<{ resume: string; jd: string }> = [];
  const skipped: Array<{ resume: string; jd: string }> = [];
  for (const p of pairs) {
    const labelPath = join(
      fixturesDir,
      "expected-matches",
      `${stripTxt(p.resume)}__${stripTxt(p.jd)}.json`,
    );
    if (existsSync(labelPath)) {
      labeled.push(p);
    } else {
      skipped.push(p);
    }
  }
  return { labeled, skipped };
}

/**
 * Very conservative upfront estimate of what one mode's run will
 * cost, so the projection guard has something to check against even
 * before real calls happen. `flowCount` is resume×JD pairs, not
 * resume count — and post-#172 it ALSO multiplies by `--samples N`
 * so the projection scales with sample count.
 *
 * **Per-flow cost.** Smoke and full now use the same `$0.75` per
 * flow (was: smoke=$0.0). The pre-#172 smoke=$0.0 was a placeholder
 * from when smoke was a stub. With multi-sample on real keys,
 * smoke runs incur real LLM spend — observed at $0.15–0.27 per
 * flow on the canonical Nathan × Google pair. $0.75 is conservative
 * enough to engage the cap guard before bursty runs blow past
 * monthly limits, while small enough that single-sample smoke
 * (the default) projects $0.75 and never trips the guard.
 *
 * Cursor caught the regression on PR #172: pre-fix,
 * `--samples 200` in smoke mode would project $0.00 (passing the
 * guard) but actually run 200 paid flows. Post-fix it projects
 * $150 and the guard refuses to run.
 *
 * Phase 1 replaces this with per-stage rate × estimated-token
 * math from real call telemetry (#41).
 */
const PER_FLOW_USD_ESTIMATE = 0.75;

/**
 * Fraction of work this run had to execute live, in [0, 1].
 *
 * The projection guard runs after the corpus executes, so the real
 * hit/miss split is already known and the estimate can be scaled by
 * it rather than assuming every flow was paid. The aggregate returns
 * the stage-count fraction; a provider returns 0 only when every one
 * of its recorded stages hit, because stage counts are not cost
 * weights. A fully warm run returns 0; a cold run returns 1.
 *
 * Returns 1 when nothing was recorded (cache bypassed, or no fixtures
 * ran) so the guard keeps its pre-#389 conservatism by default.
 */
export function liveStageFraction(
  stats: {
    readonly hits: number;
    readonly misses: number;
    readonly hitsByProvider?: Readonly<Record<string, number>>;
    readonly missesByProvider?: Readonly<Record<string, number>>;
  },
  provider?: string,
): number {
  // The provider aggregate cannot safely be discounted by its stage
  // count. Anthropic extraction uses Sonnet while requirement parsing
  // uses Haiku, so one hit and one miss are not "50% of the spend".
  // Until this estimate carries per-stage modeled costs, retain the
  // full provider estimate whenever any of that provider's stages ran
  // live. This can over-project a partially warm run, but it cannot
  // under-project a budget-capped provider.
  if (provider !== undefined) {
    const hits = stats.hitsByProvider?.[provider] ?? 0;
    const misses = stats.missesByProvider?.[provider] ?? 0;
    const total = hits + misses;
    // No stages recorded for this provider — stay conservative
    // rather than discounting a provider we know nothing about.
    if (total <= 0) return 1;
    return misses === 0 ? 0 : 1;
  }
  const total = stats.hits + stats.misses;
  if (total <= 0) return 1;
  return stats.misses / total;
}

/**
 * Scale a spend estimate only for providers whose stages were fully
 * cache-served. Firebase carries no cached stages, so it is left alone.
 */
export function scaleSpendByProvider(
  spend: { anthropicUsd: number; openaiUsd: number; firebaseUsd: number },
  stats: Parameters<typeof liveStageFraction>[0],
): { anthropicUsd: number; openaiUsd: number; firebaseUsd: number } {
  return {
    anthropicUsd: spend.anthropicUsd * liveStageFraction(stats, "anthropic"),
    openaiUsd: spend.openaiUsd * liveStageFraction(stats, "openai"),
    firebaseUsd: spend.firebaseUsd,
  };
}

export function estimatePlannedSpend(
  _mode: Mode,
  flowCount: number,
): { anthropicUsd: number; openaiUsd: number; firebaseUsd: number } {
  return {
    anthropicUsd: flowCount * PER_FLOW_USD_ESTIMATE * 0.7,
    openaiUsd: flowCount * PER_FLOW_USD_ESTIMATE * 0.3,
    firebaseUsd: 0,
  };
}

// Only run main() when invoked as a script (via `npm run eval` →
// `tsx tests/eval/run.ts`). Importing run.ts from a test file must
// not trigger process.exit — vitest caught this in unhandled-error
// form when run.test.ts imported `computeFlowCount`.
const isScriptEntry = process.argv[1] === fileURLToPath(import.meta.url);
if (isScriptEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("eval harness failed:", err);
      process.exit(2);
    });
}
