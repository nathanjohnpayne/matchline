import Anthropic from "@anthropic-ai/sdk";
import { defineSecret } from "firebase-functions/params";

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

let client: Anthropic | undefined;

/**
 * Return a lazily-initialized Anthropic client. Call sites must list
 * `anthropicKey` in their function's `secrets` config so the secret is
 * materialized before this runs.
 *
 * **Cost tracking.** Every call to `client.messages.create(...)` must
 * be paired with a `recordUsage(...)` call after the response resolves,
 * passing `provider: "anthropic"`, the `stage`, the model identifier,
 * `response.usage.input_tokens`, and `response.usage.output_tokens`. A
 * follow-on CI lint will flag bare `.messages.create` sites that lack
 * an adjacent `recordUsage(` within the same function body (lands with
 * the first Phase 1 prompt ticket, #17).
 */
export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: anthropicKey.value() });
  }
  return client;
}

export { anthropicKey };
