import { EMBEDDING_MODEL } from "./config.js";
import { openai } from "./openai.js";

/**
 * Generate an embedding for a single input string. Callers should
 * normalize inputs (trim, collapse whitespace, lowercase canonical
 * vocabulary) before handing text here so the cached embedding matches
 * the value stored on the document.
 */
export async function embed(input: string): Promise<number[]> {
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input,
  });
  const first = response.data[0];
  if (!first) {
    throw new Error("Embeddings API returned no data for input");
  }
  return first.embedding;
}

/**
 * Batch embedding for throughput. The embeddings API preserves input
 * order, so the returned array is index-aligned with `inputs`.
 */
export async function embedMany(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const response = await openai().embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
  });
  if (response.data.length !== inputs.length) {
    throw new Error(
      `Embedding count mismatch: expected ${inputs.length}, got ${response.data.length}`,
    );
  }
  return response.data.map((d) => d.embedding);
}
