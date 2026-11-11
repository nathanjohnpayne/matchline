/**
 * Which stages and prompt keys each eval suite may override (#488).
 *
 * The corpus sweep (`npm run eval`) runs extraction and requirement
 * parsing; the subtask suites (`npm run eval:subtasks`) run the three
 * validation subtasks or generation. An override for a stage a suite
 * never runs would parse cleanly, appear in the report and change
 * nothing, so every parser takes the scope it is parsing for and
 * refuses anything outside it. `rationale` is in no scope: it is a
 * deterministic template (#100) and its config entry is never read.
 *
 * Imports nothing from `sweep.ts`, so `sweep.ts` can import this.
 */

import { VALIDATION_STAGES, type ModelConfig, type Stage } from "../../functions/src/llm/config.ts";
import { profileFor, type Effort } from "../../functions/src/llm/modelProfile.ts";
import { JD_PARSING_SCHEMA_VERSIONS } from "../../functions/src/parsing/jdResponseSchema.ts";
import { PROMPT_CONFIG } from "../../functions/src/prompts/config.ts";

export type SweepSuite = "corpus" | "validation" | "generation";

export const SWEEP_SUITES: readonly SweepSuite[] = Object.freeze(["corpus", "validation", "generation"]);

export function isSweepSuite(value: string): value is SweepSuite {
  return (SWEEP_SUITES as readonly string[]).includes(value);
}

export interface SweepScope {
  readonly suite: SweepSuite;
  /** Stages whose `model.` / `effort.` overrides this suite exercises. */
  readonly stages: readonly Stage[];
  /** `<stage>/<name>` prompt keys this suite resolves. */
  readonly promptKeys: readonly string[];
  /**
   * The prompt version whose co-located schema each key's module
   * imports statically (see `assertPromptSchemasCompatible`).
   */
  readonly wiredSchemaVersion: Readonly<Record<string, string>>;
  /**
   * Prompt versions whose module picks the schema by the resolved
   * version instead of importing one statically, per key (#656:
   * `parsing/jd`, through `functions/src/parsing/jdResponseSchema.ts`).
   * A version listed here is validated against its own schema, so the
   * wired-schema comparison does not apply to it.
   */
  readonly dispatchedSchemaVersions?: Readonly<Record<string, readonly string[]>>;
}

function scope(s: SweepScope): SweepScope {
  return Object.freeze({
    suite: s.suite,
    stages: Object.freeze([...s.stages]),
    promptKeys: Object.freeze([...s.promptKeys]),
    wiredSchemaVersion: Object.freeze({ ...s.wiredSchemaVersion }),
    ...(s.dispatchedSchemaVersions !== undefined && {
      dispatchedSchemaVersions: Object.freeze(
        Object.fromEntries(
          Object.entries(s.dispatchedSchemaVersions).map(([k, v]) => [k, Object.freeze([...v])]),
        ),
      ),
    }),
  });
}

/**
 * The production-default version of a `<stage>/<name>` prompt key. The
 * validation and generation modules import the co-located schema of
 * their active version, so the subtask scopes derive their wired
 * versions from `PROMPT_CONFIG` instead of repeating it: a change that
 * moves a default (and the module's schema import with it) moves the
 * scope, the outcome classifier key and the schema hash together, and
 * `sweepScope.test.ts` fails until the classifier for the new version
 * exists.
 */
export function defaultPromptVersion(key: string): string {
  const [stage, name] = key.split("/") as [string, string];
  const version = (PROMPT_CONFIG as unknown as Record<string, Record<string, string> | undefined>)[stage]?.[name];
  if (version === undefined) throw new Error(`no PROMPT_CONFIG entry for ${key}`);
  return version;
}

function defaultsFor(keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, defaultPromptVersion(k)]));
}

const VALIDATION_PROMPT_KEYS = ["validation/claimExtraction", "validation/traceability", "validation/specificity"];
const GENERATION_PROMPT_KEYS = ["generation/resume"];

export const SWEEP_SCOPES: Readonly<Record<SweepSuite, SweepScope>> = Object.freeze({
  corpus: scope({
    suite: "corpus",
    stages: ["extraction", "requirement_parsing"],
    promptKeys: ["extraction/resume", "parsing/jd"],
    wiredSchemaVersion: { "extraction/resume": "v1", "parsing/jd": "v1" },
    dispatchedSchemaVersions: { "parsing/jd": JD_PARSING_SCHEMA_VERSIONS },
  }),
  validation: scope({
    suite: "validation",
    stages: VALIDATION_STAGES,
    promptKeys: VALIDATION_PROMPT_KEYS,
    wiredSchemaVersion: defaultsFor(VALIDATION_PROMPT_KEYS),
  }),
  generation: scope({
    suite: "generation",
    stages: ["generation"],
    promptKeys: GENERATION_PROMPT_KEYS,
    wiredSchemaVersion: defaultsFor(GENERATION_PROMPT_KEYS),
  }),
});

/**
 * `generation/pipeline.ts` (owned by #485) hard-codes a forced tool
 * choice and a 4096-token cap and sends no effort, so only models whose
 * profile has exactly that shape can be swept for generation until the
 * pipeline adopts `toolCallRequest`. Anything else would either 400 on
 * the forced tool choice or run without the requested effort while the
 * report credited it.
 */
export function assertGenerationVariantSupported(variant: {
  readonly label: string;
  readonly models?: Partial<Record<Stage, ModelConfig>>;
  readonly efforts?: Partial<Record<Stage, Effort>>;
}): void {
  if (variant.efforts?.generation !== undefined) {
    throw new Error(
      `variant "${variant.label}": effort.generation is not supported — generation does not ` +
        `apply model profiles yet (#485 owns pipeline.ts)`,
    );
  }
  const model = variant.models?.generation?.model;
  if (model === undefined) return;
  const profile = profileFor(model);
  if (!(profile.forcedToolChoice && profile.efforts.length === 0 && profile.outputBudgetFactor === 1)) {
    throw new Error(
      `variant "${variant.label}": model.generation=${model} needs forced tool choice, no effort ` +
        `and budget factor 1; generation does not apply model profiles yet (#485 owns pipeline.ts)`,
    );
  }
}
