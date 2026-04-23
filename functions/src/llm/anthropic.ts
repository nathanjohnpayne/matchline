import Anthropic from "@anthropic-ai/sdk";
import { defineSecret } from "firebase-functions/params";

const anthropicKey = defineSecret("ANTHROPIC_API_KEY");

let client: Anthropic | undefined;

/**
 * Return a lazily-initialized Anthropic client. Call sites must list
 * `anthropicKey` in their function's `secrets` config so the secret is
 * materialized before this runs.
 */
export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: anthropicKey.value() });
  }
  return client;
}

export { anthropicKey };
