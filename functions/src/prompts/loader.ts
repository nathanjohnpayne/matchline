/**
 * Prompt loader. Reads a versioned Markdown prompt + its co-located
 * Zod schema and returns a typed bundle the caller can hand to an
 * LLM client.
 *
 * File layout (established by #66):
 *
 *   functions/src/prompts/<stage>/<name>.v<N>.md
 *   functions/src/prompts/<stage>/<name>.v<N>.schema.ts
 *
 * Markdown layout (parsed here):
 *
 *   ## System
 *   <system prompt text>
 *
 *   ## User (few-shot)
 *   <few-shot example block>
 *
 * Anything before `## System` is treated as commentary and ignored,
 * so authors can document the file at the top without polluting
 * the prompt payload.
 *
 * The `.schema.ts` side is imported lazily — the loader returns the
 * schema module directly, letting callers pick `ExtractionResponseV1`
 * / `ExtractedUnitV1` etc. by name.
 *
 * Runtime-wise: the loader reads from disk at import time by
 * default (cached after first load). Under Firebase Functions, the
 * `.md` files are copied next to the compiled `.js` via the
 * functions/package.json `postbuild` step so the same relative path
 * resolves in both local dev and deploy.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";

import { activeVersion, type PromptName, type PromptStage } from "./config.js";

export interface LoadedPrompt {
  readonly stage: string;
  readonly name: string;
  readonly version: string;
  /** System prompt — content between `## System` and `## User (few-shot)`. */
  readonly system: string;
  /** Few-shot block — content after `## User (few-shot)` to EOF. */
  readonly userFewShot: string;
}

export interface LoadedPromptWithSchema<S extends ZodTypeAny = ZodTypeAny>
  extends LoadedPrompt {
  readonly schemaModule: Record<string, unknown>;
  readonly schema: S;
}

const promptsRoot = dirname(fileURLToPath(import.meta.url));

const cache = new Map<string, LoadedPrompt>();

/**
 * Runtime per-(stage,name) version overrides. Empty by default.
 *
 * **Why this exists (#177 workstream B).** The eval harness needs
 * to A/B compare prompt versions (e.g., extraction/resume v1 vs v2)
 * without flipping `PROMPT_CONFIG`, which would change production
 * behavior. The harness sets overrides via `setPromptVersionOverrides`
 * before running pipelines; production paths leave the map empty
 * and fall through to `activeVersion()` from `config.ts`.
 *
 * Module state is intentional: eval calls into the same extraction
 * / parsing / generation modules that production uses, and those
 * modules call `loadPromptText(stage, name)` without passing an
 * options bag. Threading an override through every public API
 * just for the eval harness would be invasive; a single
 * "before any pipeline call, set the overrides for this run"
 * inversion is much narrower.
 *
 * Always call `clearPromptVersionOverrides()` in test teardown
 * if a test sets overrides — the cache is keyed on the resolved
 * version, so leaving stale overrides in place can leak between
 * tests.
 */
const runtimeOverrides = new Map<string, string>();

/**
 * Compose the canonical override key from a (stage, name) pair.
 * Exported so tests and the eval harness build the same string
 * the loader looks up. Format: `${stage}/${name}` (matches the
 * `--prompt stage/name=version` CLI form).
 */
export function promptOverrideKey(stage: string, name: string): string {
  return `${stage}/${name}`;
}

/**
 * Replace the entire runtime-override map. Pass an empty object /
 * `{}` to clear all overrides; pass partial maps to override
 * specific entries. Does NOT merge with the existing map — full
 * replacement, so a caller that hands `{ "extraction/resume": "v2" }`
 * after a prior `{ "parsing/jd": "v3" }` will end with only the
 * extraction override active.
 *
 * Side effect: clears the prompt cache so the next `loadPromptText`
 * call resolves the new version. Without this, a cached v1 entry
 * would mask a fresh v2 override on a hot-loaded process.
 */
export function setPromptVersionOverrides(
  overrides: Readonly<Record<string, string>>,
): void {
  runtimeOverrides.clear();
  for (const [k, v] of Object.entries(overrides)) {
    runtimeOverrides.set(k, v);
  }
  cache.clear();
}

/**
 * Clear all runtime overrides AND the prompt cache. Equivalent to
 * `setPromptVersionOverrides({})`. Provided as a clearer name for
 * test teardown and end-of-eval-run cleanup.
 */
export function clearPromptVersionOverrides(): void {
  runtimeOverrides.clear();
  cache.clear();
}

/**
 * Read a snapshot of the current overrides. Returns a frozen object
 * so callers can include it in eval-report metadata without
 * accidentally mutating loader state.
 */
export function getPromptVersionOverrides(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(runtimeOverrides));
}

/**
 * Resolve the version to load for a (stage, name) pair. Override
 * wins over the static `PROMPT_CONFIG` entry; both fall through to
 * the loader's same `activeVersion` invariant (the configured
 * default version must reference a file that exists; an override
 * version not on disk fails loudly at `readFileSync`).
 *
 * Exported so the eval harness can include the resolved versions
 * in its report header without re-implementing the lookup.
 */
export function resolvePromptVersion<
  S extends PromptStage,
  N extends PromptName<S>,
>(stage: S, name: N): string {
  const override = runtimeOverrides.get(promptOverrideKey(String(stage), String(name)));
  if (override !== undefined) return override;
  return String(activeVersion(stage, name));
}

/**
 * Load a prompt's Markdown body (without the schema). Exported
 * separately so callers that don't need the Zod schema (e.g.
 * documentation tooling) can skip the dynamic import.
 */
export function loadPromptText<S extends PromptStage, N extends PromptName<S>>(
  stage: S,
  name: N,
): LoadedPrompt {
  const version = resolvePromptVersion(stage, name);
  const cacheKey = `${String(stage)}/${String(name)}/${String(version)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const mdPath = join(promptsRoot, String(stage), `${String(name)}.${String(version)}.md`);
  let raw: string;
  try {
    raw = readFileSync(mdPath, "utf8");
  } catch (err) {
    throw new Error(
      `Prompt file not found: ${mdPath}. ` +
        `PROMPT_CONFIG says the active version for ${String(stage)}/${String(name)} ` +
        `is ${String(version)}, but no file matches on disk. Check the file ` +
        `exists and the postbuild step copied .md files to lib/. ` +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { system, userFewShot } = parsePromptSections(raw, mdPath);
  const loaded: LoadedPrompt = {
    stage: String(stage),
    name: String(name),
    version: String(version),
    system,
    userFewShot,
  };
  cache.set(cacheKey, loaded);
  return loaded;
}

/**
 * Load a prompt and its co-located schema. Prefer this at call sites
 * that pass `{template, schema}` to an LLM client.
 *
 * `schemaExportName` names the Zod schema export the caller wants
 * back as `.schema`. Keeps the loader honest about which schema in
 * the module it hands out (modules can export multiple).
 */
export async function loadPromptWithSchema<
  S extends PromptStage,
  N extends PromptName<S>,
  Z extends ZodTypeAny = ZodTypeAny,
>(
  stage: S,
  name: N,
  schemaExportName: string,
): Promise<LoadedPromptWithSchema<Z>> {
  const text = loadPromptText(stage, name);
  const schemaModulePath = join(
    promptsRoot,
    text.stage,
    `${text.name}.${text.version}.schema.js`,
  );

  let schemaModule: Record<string, unknown>;
  try {
    // dynamic import: the compiled .schema.js sits next to the .md.
    schemaModule = (await import(schemaModulePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Prompt schema module not found: ${schemaModulePath}. ` +
        `Every .v<N>.md needs a co-located .v<N>.schema.ts. ` +
        `Underlying: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const schema = schemaModule[schemaExportName];
  if (!schema) {
    throw new Error(
      `Schema module at ${schemaModulePath} does not export "${schemaExportName}". ` +
        `Available exports: ${Object.keys(schemaModule).join(", ")}`,
    );
  }

  return {
    ...text,
    schemaModule,
    schema: schema as Z,
  };
}

/**
 * Parse the two required sections from the Markdown body. Case-
 * sensitive headers; deliberately strict so stray whitespace or
 * different heading levels fail loudly during development rather
 * than silently breaking at runtime.
 *
 * Exported for unit tests.
 */
export function parsePromptSections(
  raw: string,
  sourcePathForError = "<inline>",
): { system: string; userFewShot: string } {
  // Line-based match with fence awareness:
  //   - Only exact `## System` / `## User (few-shot)` lines count
  //     (so `## Systematic approach` in preamble is ignored).
  //   - Lines inside a fenced code block (```...```) are skipped
  //     entirely — a prompt author documenting the format with a
  //     fenced example won't trigger the parser (Codex P2).
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let systemLine = -1;
  let userLine = -1;
  // CommonMark-style fence tracking: fence opened by N backticks
  // is only closed by a fence of N or more backticks. Tracks the
  // opening length so nested fences (4-tick outer showing a 3-tick
  // inner) work correctly — the inner 3-tick line doesn't close the
  // outer 4-tick fence (Codex P2 round 4).
  let fenceLen = 0;
  let fenceChar: "`" | "~" | "" = "";
  // CommonMark fences (rounds 4-6 of Codex review):
  //   - Up to 3 leading spaces of indentation.
  //   - 3+ backticks OR 3+ tildes.
  //   - Opening can be followed by an info string (language tag).
  //   - Closing must be followed by whitespace only. A `` ```js `` inside
  //     an open fence is NOT a close — it's content.
  //   - Closing length must be ≥ opening length, same char.
  const OPENING = /^ {0,3}(`{3,}|~{3,})/;
  const CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceLen === 0) {
      const m = line.match(OPENING);
      if (m) {
        fenceLen = m[1]!.length;
        fenceChar = m[1]![0] as "`" | "~";
        continue;
      }
    } else {
      const m = line.match(CLOSING);
      if (m) {
        const fence = m[1]!;
        if ((fence[0] as "`" | "~") === fenceChar && fence.length >= fenceLen) {
          fenceLen = 0;
          fenceChar = "";
        }
      }
      continue;
    }
    if (line === "## System" && systemLine < 0) systemLine = i;
    else if (line === "## User (few-shot)" && userLine < 0) userLine = i;
  }
  if (systemLine < 0) {
    throw new Error(
      `Prompt at ${sourcePathForError} is missing a '## System' section.`,
    );
  }
  if (userLine < 0) {
    throw new Error(
      `Prompt at ${sourcePathForError} is missing a '## User (few-shot)' section.`,
    );
  }
  if (userLine < systemLine) {
    throw new Error(
      `Prompt at ${sourcePathForError}: '## User (few-shot)' appears before '## System'. ` +
        `Fix the ordering so the system prompt is defined first.`,
    );
  }
  const system = lines.slice(systemLine + 1, userLine).join("\n").trim();
  const userFewShot = lines.slice(userLine + 1).join("\n").trim();
  return { system, userFewShot };
}

/** Test-only: drop the in-memory cache so unit tests can reload. */
export function _clearCacheForTests(): void {
  cache.clear();
}
