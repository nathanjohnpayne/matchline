/**
 * Resume extraction pipeline. Composes:
 *
 *   pasted-text
 *     → extractFromResume (#67)     — LLM extraction + retry + cost
 *     → embedMany (#47)             — OpenAI embeddings + cost
 *     → writeUnitToFirestore        — admin SDK persist
 *     → ExperienceUnit[] (returned)
 *
 * Single callable invocation runs the whole Step 1 of the core loop
 * so the frontend gets persisted Units back in one call rather than
 * orchestrating N round trips.
 *
 * Idempotent on source_ref: running the pipeline twice on the same
 * `text` produces the same `source_ref` prefix per Unit (inherited
 * from #67's `sha256(text).slice(0,16):idx` stamp). The write path
 * uses the Unit's `id` (a fresh UUID per Unit per run) so repeat
 * pastes do re-create docs at new ids — callers that want dedup-on-
 * paste should check `source_ref` prefix before calling.
 */

import { embedMany } from "../llm/embeddings.js";
import { safeProgress, type ProgressReporter } from "../llm/progress.js";
import type { ExperienceUnit } from "../types/capability.js";

import { extractFromResume, type ExtractionContext } from "./resume.js";
import { getAdminDb } from "../firestore/admin.js";

const COLLECTION = "experienceUnits";

export interface PipelineDeps {
  /** Override for tests; defaults to the production extractor. */
  readonly extract?: typeof extractFromResume;
  /** Override for tests; defaults to the OpenAI embeddings wrapper. */
  readonly embed?: typeof embedMany;
  /**
   * Override for tests; defaults to an atomic Firestore batch write.
   * Receives the full stamped batch so implementations can commit
   * all-or-nothing. Partial-write recovery is the caller's problem
   * only if it provides a non-atomic persist.
   */
  readonly persistBatch?: (units: readonly ExperienceUnit[]) => Promise<void>;
  /**
   * Optional progress sink (#428), forwarded to the extractor so its
   * per-attempt events reach the caller too.
   */
  readonly onProgress?: ProgressReporter;
}

export async function runExtractionPipeline(
  text: string,
  ctx: ExtractionContext,
  deps: PipelineDeps = {},
): Promise<ExperienceUnit[]> {
  const extract = deps.extract ?? extractFromResume;
  const embed = deps.embed ?? embedMany;
  const persistBatch = deps.persistBatch ?? writeUnitsAsBatch;
  const report = safeProgress(deps.onProgress);

  // Step 1: LLM extraction. Throws ExtractionError on retry-budget
  // exhaustion; the callable maps that to "needs manual review".
  const units = await extract(text, ctx, { onProgress: deps.onProgress });
  if (units.length === 0) return [];

  report({ stage: "embedding" });

  // Step 2: batch embeddings. The embedMany contract preserves
  // input order, so `embeddings[i]` corresponds to `units[i]`.
  const embeddings = await embed(
    units.map((u) => u.normalized_summary),
    { ownerUid: ctx.ownerUid },
  );

  if (embeddings.length !== units.length) {
    // embedMany already enforces this and throws, but mirror the
    // check here so the failure is attributed to this module in
    // logs rather than bubbling unattributed.
    throw new Error(
      `Embedding count mismatch: ${embeddings.length} embeddings for ${units.length} units.`,
    );
  }

  const stamped: ExperienceUnit[] = units.map((u, i) => ({
    ...u,
    embedding: embeddings[i],
  }));

  // Step 3: persist atomically. Firestore WriteBatch commits
  // all-or-none (up to 500 ops per batch — well above any single
  // extraction run). Without atomicity, a mid-batch failure would
  // leave partial data + fresh-id retries would duplicate the
  // survivors — a data-corruption shape Codex caught on this PR.
  report({ stage: "saving" });
  await persistBatch(stamped);

  return stamped;
}

async function writeUnitsAsBatch(
  units: readonly ExperienceUnit[],
): Promise<void> {
  const db = getAdminDb();
  const batch = db.batch();
  for (const u of units) {
    batch.set(db.collection(COLLECTION).doc(u.id), u);
  }
  await batch.commit();
}
