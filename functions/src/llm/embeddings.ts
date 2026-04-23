import { EMBEDDING_MODEL } from "./config.js";
import { recordUsage } from "./cost.js";
import { openai } from "./openai.js";

export interface EmbedOptions {
  readonly ownerUid?: string;
  readonly applicationId?: string;
}

/**
 * Generate an embedding for a single input string. Callers should
 * normalize inputs (trim, collapse whitespace, lowercase canonical
 * vocabulary) before handing text here so the cached embedding matches
 * the value stored on the document.
 *
 * Token usage is recorded via `recordUsage` on every call; pass caller
 * context (`ownerUid`, `applicationId`) when available so per-user and
 * per-application spend can be rolled up.
 */
export async function embed(input: string, options: EmbedOptions = {}): Promise<number[]> {
  const start = Date.now();
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  const first = response.data[0];
  if (!first) {
    throw new Error("Embeddings API returned no data for input");
  }
  await recordUsage({
    stage: "embedding",
    provider: "openai",
    model: EMBEDDING_MODEL,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: 0,
    latencyMs: Date.now() - start,
    ownerUid: options.ownerUid,
    applicationId: options.applicationId,
  });
  return first.embedding;
}

/**
 * Batch embedding for throughput. The embeddings API preserves input
 * order, so the returned array is index-aligned with `inputs`.
 */
export async function embedMany(
  inputs: string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const start = Date.now();
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
  });
  if (response.data.length !== inputs.length) {
    throw new Error(
      `Embedding count mismatch: expected ${inputs.length}, got ${response.data.length}`,
    );
  }
  await recordUsage({
    stage: "embedding",
    provider: "openai",
    model: EMBEDDING_MODEL,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: 0,
    latencyMs: Date.now() - start,
    ownerUid: options.ownerUid,
    applicationId: options.applicationId,
  });
  return response.data.map((d) => d.embedding);
}
