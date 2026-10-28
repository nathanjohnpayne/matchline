/**
 * How each Anthropic model must be called for a structured tool answer.
 *
 * Every text stage asks the model to answer by calling one named tool.
 * Through Claude 4.6 that was enforced with a forced
 * `tool_choice: { type: "tool" }`. The Claude 5.5 family changed three
 * things that this file absorbs so call sites don't have to (#495):
 *
 * - **Forced tool use.** Opus 5.5 and Sonnet 5.5 reject a forced
 *   `tool_choice` with a 400. They get `tool_choice: auto` plus a
 *   system instruction to answer only through the tool; the stage's
 *   existing `no_tool_use` failure and retry cover a model that
 *   answers in text anyway. Haiku 5.5 still accepts a forced choice.
 * - **Thinking and the tokenizer.** On Opus/Sonnet 5.5 thinking is on
 *   and counts toward `max_tokens`, and all three 5.5 models count the
 *   same text as roughly 30–35% more tokens. Their output budget is
 *   scaled up so a long resume isn't truncated mid-tool-call.
 * - **Effort.** `output_config.effort` replaces thinking budgets. Opus
 *   5.5 and Haiku 5.5 default to `medium`, Sonnet 5.5 to `high`, so it
 *   is always sent explicitly and recorded, never left to a default.
 *
 * Unknown models throw, like `rateFor`: a model has to be described
 * here before any stage can call it, so a new model can't silently get
 * the wrong request shape.
 */

import type Anthropic from "@anthropic-ai/sdk";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

export interface ModelProfile {
  /** Whether `tool_choice: { type: "tool" }` is accepted. */
  readonly forcedToolChoice: boolean;
  /** Effort levels the model accepts; empty means `effort` must not be sent. */
  readonly efforts: readonly Effort[];
  /** Effort sent when the caller sets none. Absent when `efforts` is empty. */
  readonly defaultEffort?: Effort;
  /** Multiplier applied to a stage's base `max_tokens`. */
  readonly outputBudgetFactor: number;
}

const LEGACY_FORCED: ModelProfile = Object.freeze({
  forcedToolChoice: true,
  efforts: [],
  outputBudgetFactor: 1,
});

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  // Current pins. Requests are unchanged from before this module.
  "claude-sonnet-4-6": LEGACY_FORCED,
  "claude-haiku-4-5-20251001": LEGACY_FORCED,

  // Claude 5.5 family, registered for the #495 sweep.
  "claude-haiku-5-5": Object.freeze({
    forcedToolChoice: true,
    efforts: EFFORTS,
    defaultEffort: "medium",
    outputBudgetFactor: 2,
  }),
  "claude-sonnet-5-5": Object.freeze({
    forcedToolChoice: false,
    efforts: EFFORTS,
    defaultEffort: "high",
    outputBudgetFactor: 2,
  }),
  "claude-opus-5-5": Object.freeze({
    forcedToolChoice: false,
    efforts: EFFORTS,
    defaultEffort: "medium",
    outputBudgetFactor: 2,
  }),
  // Claude Fable 5.1 (frontier tier), registered for the #495 comparison
  // by design amendment 1. Like Opus/Sonnet 5.5 it rejects a forced
  // tool_choice (400) and thinks adaptively on every request; its effort
  // default is high; same tokenizer as Opus 4.8, so the doubled output
  // budget applies.
  "claude-fable-5-1": Object.freeze({
    forcedToolChoice: false,
    efforts: EFFORTS,
    defaultEffort: "high",
    outputBudgetFactor: 2,
  }),
});

export function profileFor(model: string): ModelProfile {
  const profile = Object.hasOwn(MODEL_PROFILES, model) ? MODEL_PROFILES[model] : undefined;
  if (!profile) {
    throw new Error(
      `No request profile registered for model: ${model}. Add it to functions/src/llm/modelProfile.ts.`,
    );
  }
  return profile;
}

/**
 * Above this `max_tokens` the SDK refuses a non-streaming request
 * unless the call passes its own timeout (the SDK models 128K tokens
 * per hour, so 10 minutes ≈ 21,333 tokens).
 */
const SDK_NONSTREAMING_TOKEN_LIMIT = 21_333;

/** Timeout for a non-streaming request above that limit. */
export const LONG_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export interface ToolCallRequest {
  readonly max_tokens: number;
  readonly tool_choice: Anthropic.Messages.ToolChoice;
  readonly output_config?: Anthropic.Messages.OutputConfig;
  /** Appended to the system prompt; empty when the tool choice is forced. */
  readonly systemSuffix: string;
  /** Request options for `messages.create`; carries a timeout only when one is needed. */
  readonly requestOptions?: { readonly timeout: number };
  /** Effort actually sent, for usage records and cache keys. */
  readonly effort?: Effort;
}

/**
 * The model-specific parts of a single-tool request.
 *
 * Throws when `effort` is set for a model that accepts none, or names a
 * level the model doesn't support: a sweep variant that asked for an
 * effort must get it, or refuse, never run without it.
 */
export function toolCallRequest(args: {
  readonly model: string;
  readonly toolName: string;
  readonly baseMaxTokens: number;
  readonly effort?: Effort;
}): ToolCallRequest {
  const profile = profileFor(args.model);

  if (args.effort !== undefined && !profile.efforts.includes(args.effort)) {
    throw new Error(
      profile.efforts.length === 0
        ? `Model ${args.model} does not accept an effort setting (got ${JSON.stringify(args.effort)}).`
        : `Model ${args.model} does not accept effort ${JSON.stringify(args.effort)}; ` +
            `supported: ${profile.efforts.join(", ")}.`,
    );
  }
  const effort = args.effort ?? profile.defaultEffort;

  const max_tokens = Math.round(args.baseMaxTokens * profile.outputBudgetFactor);

  return {
    max_tokens,
    tool_choice: profile.forcedToolChoice
      ? { type: "tool", name: args.toolName }
      : { type: "auto" },
    ...(effort !== undefined && { output_config: { effort }, effort }),
    systemSuffix: profile.forcedToolChoice
      ? ""
      : `\n\nRespond only by calling the \`${args.toolName}\` tool, exactly once, with your complete answer. Do not reply in text.`,
    ...(max_tokens > SDK_NONSTREAMING_TOKEN_LIMIT && {
      requestOptions: { timeout: LONG_REQUEST_TIMEOUT_MS },
    }),
  };
}
