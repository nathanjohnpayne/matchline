import { defineSecret } from "firebase-functions/params";
import OpenAI from "openai";

const openaiKey = defineSecret("OPENAI_API_KEY");

let client: OpenAI | undefined;

/**
 * Return a lazily-initialized OpenAI client. Call sites must list
 * `openaiKey` in their function's `secrets` config so the secret is
 * materialized before this runs.
 *
 * **Cost tracking.** Every call to `client.chat.completions.create(...)`
 * (or any other billed endpoint) must be paired with a `recordUsage(...)`
 * call after the response resolves, passing `provider: "openai"`, the
 * `stage`, the model identifier, `response.usage.prompt_tokens`, and
 * `response.usage.completion_tokens`. The `embed`/`embedMany` helpers
 * in `embeddings.ts` already handle this for the embedding endpoint;
 * new chat/completion call sites need to record usage explicitly.
 */
export function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: openaiKey.value() });
  }
  return client;
}

/**
 * CLI-only OpenAI client. Reads `OPENAI_API_KEY` from
 * `process.env` directly, bypassing `defineSecret` (which
 * only resolves inside the Cloud Functions runtime).
 *
 * Mirror of `anthropicForCli` — see that docstring for the
 * full rationale. Used by the eval harness to embed Units +
 * Requirements in-memory before running the matching
 * pipeline.
 *
 * Throws synchronously if `OPENAI_API_KEY` is missing.
 */
export function openaiForCli(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "openaiForCli: OPENAI_API_KEY is not set. " +
        "Export it in your shell before running the CLI: " +
        "`export OPENAI_API_KEY=$(op read 'op://...')` or similar.",
    );
  }
  return new OpenAI({ apiKey });
}

export { openaiKey };

/**
 * Re-export the OpenAI class type for tooling (eval harness,
 * tests) that lives outside `functions/` and therefore can't
 * resolve `openai` from its own node_modules. Importing
 * from this module routes resolution through `functions/`'s
 * own dependency tree, where the SDK is installed.
 */
export type { default as OpenAIClient } from "openai";
