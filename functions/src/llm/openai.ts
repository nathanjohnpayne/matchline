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

export { openaiKey };
