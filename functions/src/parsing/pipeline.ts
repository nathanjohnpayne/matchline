/**
 * JD parsing pipeline. Composes:
 *
 *   paste + roleId
 *     → parseJobRequirements — LLM parse + retry + cost
 *     → embedMany             — OpenAI embeddings + cost
 *     → stamp embedding
 *     → atomic batch write   — Firestore WriteBatch (all-or-none)
 *     → JobRequirementUnit[]  (returned)
 *
 * Mirrors `extraction/pipeline.ts` — same atomic-batch persist
 * discipline so a mid-batch Firestore failure can't leave partial
 * Requirements under a Role (which would corrupt the matcher's
 * view of that Role's ask set).
 */

import { embedMany } from "../llm/embeddings.js";
import type { JobRequirementUnit } from "../types/capability.js";

import { getAdminDb } from "../firestore/admin.js";
import { parseJobRequirements, type JdParsingContext } from "./jd.js";

const COLLECTION = "jobRequirementUnits";

export interface JdPipelineDeps {
  readonly parse?: typeof parseJobRequirements;
  readonly embed?: typeof embedMany;
  readonly persistBatch?: (units: readonly JobRequirementUnit[]) => Promise<void>;
}

export async function runJdParsingPipeline(
  text: string,
  ctx: JdParsingContext,
  deps: JdPipelineDeps = {},
): Promise<JobRequirementUnit[]> {
  const parse = deps.parse ?? parseJobRequirements;
  const embed = deps.embed ?? embedMany;
  const persistBatch = deps.persistBatch ?? writeRequirementsAsBatch;

  const units = await parse(text, ctx);
  if (units.length === 0) return [];

  const embeddings = await embed(
    units.map((u) => u.normalized_requirement),
    { ownerUid: ctx.ownerUid },
  );

  if (embeddings.length !== units.length) {
    throw new Error(
      `Embedding count mismatch: ${embeddings.length} embeddings for ${units.length} requirements.`,
    );
  }

  const stamped: JobRequirementUnit[] = units.map((u, i) => ({
    ...u,
    embedding: embeddings[i],
  }));

  await persistBatch(stamped);

  return stamped;
}

async function writeRequirementsAsBatch(
  units: readonly JobRequirementUnit[],
): Promise<void> {
  const db = getAdminDb();
  const batch = db.batch();
  for (const u of units) {
    batch.set(db.collection(COLLECTION).doc(u.id), u);
  }
  await batch.commit();
}
