/**
 * Cosine similarity for the matching engine's `semantic_similarity`
 * scoring component (parent issue #20, sub-issue #98). Pure
 * number-crunching on the embedding vectors that #78 / #19 already
 * cache on `ExperienceUnit` and `JobRequirementUnit` documents.
 *
 * Two exports:
 *
 *   - `cosineSimilarity(a, b)` returns the raw cosine value in
 *     [-1, 1]. Useful for callers that need the signed similarity
 *     (e.g. an analytics pass that wants to surface "diametrically
 *     opposite" pairs).
 *   - `semanticSimilarity(a, b)` clamps to [0, 1] — what the
 *     scoring composer (#97) plugs into the `semantic_similarity`
 *     slot of the `score()` formula. Negative values are vanishingly
 *     rare with OpenAI's `text-embedding-3-small` (vectors are
 *     unit-normalized server-side and the model emits semantically-
 *     coherent representations) but can theoretically appear if a
 *     future provider emits non-normalized vectors. Clamping keeps
 *     the matching weights in their documented [0, 1] range.
 *
 * Both throw on caller bugs (mismatched dimensions, empty vectors)
 * rather than returning a meaningless 0 — embeddings should always
 * be the configured model's dimensionality and never empty; a
 * silent 0 would mask the real issue (typically: an extraction or
 * parse path skipped embedding generation, leaving the document
 * with a missing or empty `embedding` field).
 */

/**
 * Caller bug: vectors have different dimensions. The embedding
 * model is fixed (`text-embedding-3-small`, 1536 dims), so a
 * dimension mismatch means either a stale doc from a previous
 * model or a hand-constructed test fixture.
 */
export class MismatchedDimensionsError extends Error {
  constructor(aLen: number, bLen: number) {
    super(
      `cosine: vector dimensions don't match (a=${aLen}, b=${bLen})`,
    );
    this.name = "MismatchedDimensionsError";
  }
}

/**
 * Caller bug: at least one vector is empty. The embedding model
 * never returns an empty array; an empty vector here means the
 * caller passed `[]` (test bug) or read a doc without a populated
 * `embedding` field (extraction/parse bug).
 */
export class EmptyVectorError extends Error {
  constructor() {
    super("cosine: at least one vector is empty");
    this.name = "EmptyVectorError";
  }
}

/**
 * Magnitude below which a vector is treated as effectively zero.
 * OpenAI's `text-embedding-3-small` returns unit-magnitude
 * vectors (||v|| ≈ 1.0), so anything in this band is either
 * pathologically corrupted or hand-zero in a test.
 */
const NEAR_ZERO_MAGNITUDE = 1e-12;

/**
 * Raw cosine similarity in [-1, 1]. Throws on caller bugs (see
 * `MismatchedDimensionsError` / `EmptyVectorError`). If either
 * vector has effectively-zero magnitude, returns 0 — neither
 * vector points anywhere meaningful, so no similarity claim is
 * defensible.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) {
    throw new EmptyVectorError();
  }
  if (a.length !== b.length) {
    throw new MismatchedDimensionsError(a.length, b.length);
  }
  let dot = 0;
  let aSquared = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    aSquared += ai * ai;
    bSquared += bi * bi;
  }
  const aMag = Math.sqrt(aSquared);
  const bMag = Math.sqrt(bSquared);
  if (aMag < NEAR_ZERO_MAGNITUDE || bMag < NEAR_ZERO_MAGNITUDE) {
    // Defensive: a near-zero magnitude vector divides to NaN.
    // Returning 0 means "no similarity claim defensible" — the
    // caller's matching pipeline treats it as no semantic signal,
    // which is the correct UX for a corrupt embedding.
    return 0;
  }
  return dot / (aMag * bMag);
}

/**
 * Cosine similarity clamped to [0, 1]. The matching engine's
 * `semantic_similarity` slot in the score composer (#97) consumes
 * this — keeping the range matched to every other scoring
 * component's documented [0, 1] is what makes the weighted-sum in
 * the PRD formula well-defined.
 */
export function semanticSimilarity(a: number[], b: number[]): number {
  return Math.max(0, cosineSimilarity(a, b));
}
