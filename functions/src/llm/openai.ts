import { defineSecret } from "firebase-functions/params";
import OpenAI from "openai";

const openaiKey = defineSecret("OPENAI_API_KEY");

let client: OpenAI | undefined;

/**
 * Return a lazily-initialized OpenAI client. Call sites must list
 * `openaiKey` in their function's `secrets` config so the secret is
 * materialized before this runs.
 */
export function openai(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: openaiKey.value() });
  }
  return client;
}

export { openaiKey };
