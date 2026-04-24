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
import type { ExperienceUnit } from "../types/capability.js";

import { extractFromResume, type ExtractionContext } from "./resume.js";
import { getAdminDb } from "../firestore/admin.js";

const COLLECTION = "experienceUnits";

export interface PipelineDeps {
  /** Override for tests; defaults to the production extractor. */
  readonly extract?: typeof extractFromResume;
  /** Override for tests; defaults to the OpenAI embeddings wrapper. */
  readonly embed?: typeof embedMany;
  /** Override for tests; defaults to admin-SDK Firestore write. */
  readonly persist?: (unit: ExperienceUnit) => Promise<void>;
}

export async function runExtractionPipeline(
  text: string,
  ctx: ExtractionContext,
  deps: PipelineDeps = {},
): Promise<ExperienceUnit[]> {
  const extract = deps.extract ?? extractFromResume;
  const embed = deps.embed ?? embedMany;
  const persist = deps.persist ?? writeUnitToFirestore;

  // Step 1: LLM extraction. Throws ExtractionError on retry-budget
  // exhaustion; the callable maps that to "needs manual review".
  const units = await extract(text, ctx);
  if (units.length === 0) return [];

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

  // Step 3: persist. Parallel writes — each unit is independent.
  // If any single write fails, the whole batch rejects; the
  // callable surfaces that as a non-ExtractionError and the
  // frontend retries from scratch.
  await Promise.all(stamped.map((u) => persist(u)));

  return stamped;
}

async function writeUnitToFirestore(unit: ExperienceUnit): Promise<void> {
  await getAdminDb().collection(COLLECTION).doc(unit.id).set(unit);
}
