import Anthropic from "@anthropic-ai/sdk";
import { defineSecret } from "firebase-functions/params";

import { normalizeApiKey } from "./apiKey.js";

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
    // normalizeApiKey, not the raw value: a secret written with
    // `echo` carries a trailing newline that Secret Manager mounts
    // verbatim, producing a malformed x-api-key header (#426).
    client = new Anthropic({
      apiKey: normalizeApiKey(anthropicKey.value()),
    });
  }
  return client;
}

/**
 * CLI-only Anthropic client. Reads `ANTHROPIC_API_KEY` from
 * `process.env` directly, bypassing `defineSecret` (which only
 * resolves inside the Cloud Functions runtime).
 *
 * Used by the eval harness (`tests/eval/run.ts`) and any other
 * CLI tooling that needs to make Anthropic calls outside the
 * Functions runtime. The returned client is a fresh instance
 * per call — callers can pass it as a `client` dep into the
 * pipelines (`extractFromResume`, `parseJobRequirements`,
 * `runGenerationPipeline`) which all accept that injection.
 *
 * Throws synchronously if `ANTHROPIC_API_KEY` is missing.
 * That's intentional — the CLI should fail loudly at the
 * setup boundary, not produce mysterious 401s mid-run.
 */
export function anthropicForCli(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "anthropicForCli: ANTHROPIC_API_KEY is not set. " +
        "Export it in your shell before running the CLI: " +
        "`export ANTHROPIC_API_KEY=$(op read 'op://...')` or similar.",
    );
  }
  // Normalized on this path too, so a CLI reproduction behaves the
  // same way the deployed function does. Shell command substitution
  // already strips a trailing newline, which is precisely why #426
  // reproduced clean locally while production failed — the CLI path
  // must not be quietly more forgiving than the runtime one.
  return new Anthropic({ apiKey: normalizeApiKey(apiKey) });
}

export { anthropicKey };

/**
 * Re-export the Anthropic class type for tooling (eval harness,
 * tests) that lives outside `functions/` and therefore can't
 * resolve `@anthropic-ai/sdk` from its own node_modules. Importing
 * from this module routes resolution through `functions/`'s own
 * dependency tree, where the SDK is installed.
 */
export type { default as AnthropicClient } from "@anthropic-ai/sdk";
