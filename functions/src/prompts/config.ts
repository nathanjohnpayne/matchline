/**
 * Active prompt versions by (stage, name).
 *
 * When a new version of a prompt ships (e.g. `resume.v2.md`), the
 * loader continues to serve v1 until the entry here flips. That
 * makes prompt iteration safe — v2 can exist on disk and be tested
 * via the eval harness's per-run override (deferred follow-on)
 * without affecting production calls.
 *
 * Every entry must reference a prompt file that actually exists —
 * `scripts/ci/check_prompt_schema_pairs` verifies the pair and
 * `loadPrompt()` throws with a clear message if config and disk
 * disagree.
 */

export const PROMPT_CONFIG = {
  extraction: {
    resume: "v1",
  },
  parsing: {
    jd: "v1",
  },
  validation: {
    claimExtraction: "v1",
    // #485: tags and dates as literal evidence; the v1 file stays for the eval harness.
    traceability: "v2",
    specificity: "v1",
  },
  generation: {
    // #485: shared Unit evidence text, target role framed as non-evidence;
    // the v1 file stays for the eval harness.
    resume: "v2",
    // #495 Phase 3: evaluated privately before any product surface uses it.
    fitBrief: "v1",
  },
} as const;

/** Stages with at least one prompt entry. */
export type PromptStage = keyof typeof PROMPT_CONFIG;

/** Valid prompt name for a given stage, narrowed from the config. */
export type PromptName<S extends PromptStage> = keyof (typeof PROMPT_CONFIG)[S];

/** Active version string for a (stage, name). */
export type PromptVersion<
  S extends PromptStage,
  N extends PromptName<S>,
> = (typeof PROMPT_CONFIG)[S][N];

/**
 * Look up the currently-active version for a prompt.
 * Narrow typing keeps callers from asking for prompts that aren't
 * configured; the loader throws on runtime drift from disk.
 */
export function activeVersion<S extends PromptStage, N extends PromptName<S>>(
  stage: S,
  name: N,
): PromptVersion<S, N> {
  return PROMPT_CONFIG[stage][name];
}
