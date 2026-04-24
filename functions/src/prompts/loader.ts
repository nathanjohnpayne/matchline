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
 * Load a prompt's Markdown body (without the schema). Exported
 * separately so callers that don't need the Zod schema (e.g.
 * documentation tooling) can skip the dynamic import.
 */
export function loadPromptText<S extends PromptStage, N extends PromptName<S>>(
  stage: S,
  name: N,
): LoadedPrompt {
  const version = activeVersion(stage, name);
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
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A line that starts with ``` (optional language tag) toggles
    // the fence state. Trim trailing whitespace to tolerate
    // "``` ts" and similar.
    if (line.replace(/\s+$/, "").startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
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
