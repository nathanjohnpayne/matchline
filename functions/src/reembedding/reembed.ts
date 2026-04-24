/**
 * Re-embed pipeline for a single ExperienceUnit. Consumes a Unit
 * flagged `reembed_pending: true` (set by the service's
 * `updateFields` in #78 when a write touches `raw_text` or
 * `normalized_summary`, and by `buildManualUnit` in #78 when a
 * manual insert creates a Unit without an embedding), regenerates
 * its embedding from the current `normalized_summary`, and clears
 * the flag atomically with the embedding write.
 *
 * Composed as a pure-ish function with injectable dependencies so
 * the happy path, auth-ownership gating, and embedding-API failure
 * are each testable without the real Firestore admin client or
 * OpenAI.
 *
 * Atomicity note: the persist step writes `embedding` AND clears
 * `reembed_pending` in the same `update()` call so a failure
 * between the two can't leave a Unit with a fresh embedding but
 * a stale pending flag (or vice versa). Firestore's single-doc
 * update is atomic by contract.
 */

import { embed } from "../llm/embeddings.js";
import type { ExperienceUnit } from "../types/capability.js";

import { getAdminDb } from "../firestore/admin.js";

const COLLECTION = "experienceUnits";

export interface ReembedContext {
  readonly ownerUid: string;
  readonly unitId: string;
}

export interface ReembedDeps {
  /**
   * Read the Unit. Must return `undefined` when the doc doesn't
   * exist. The owner_uid check happens AFTER the read — the
   * callable wrapper collapses "not found" and "wrong owner" into
   * one `permission-denied` response for anti-enumeration, and
   * the core logic here treats both cases the same (throws
   * `ReembedNotFoundOrForbidden`).
   */
  readonly getUnit?: (unitId: string) => Promise<ExperienceUnit | undefined>;
  /** Embedding call. Default uses the OpenAI client + cost tracker. */
  readonly embed?: (
    input: string,
    options: { readonly ownerUid: string },
  ) => Promise<number[]>;
  /**
   * Persist the new embedding AND clear `reembed_pending` in one
   * atomic write.
   */
  readonly persistEmbedding?: (
    unitId: string,
    embedding: number[],
  ) => Promise<void>;
}

/**
 * Thrown when the requested Unit is missing or owned by a
 * different user. Both conditions collapse into one error so the
 * callable layer can respond with a single `permission-denied`
 * message and the caller can't tell the difference.
 */
export class ReembedNotFoundOrForbidden extends Error {
  constructor() {
    super("Unit not found or not owned by caller.");
    this.name = "ReembedNotFoundOrForbidden";
  }
}

/**
 * Thrown when the Unit's `normalized_summary` is empty. Defensive
 * — the embedding API rejects empty input, and emitting an empty
 * embedding would silently poison matching. If a caller hits
 * this, the Unit needs real content before re-embed can proceed.
 */
export class ReembedEmptyInput extends Error {
  constructor() {
    super("Unit has no normalized_summary; cannot re-embed.");
    this.name = "ReembedEmptyInput";
  }
}

/**
 * Thrown when the Unit's `reembed_pending` flag is not `true`.
 * The endpoint is meant to consume Units the state machine has
 * flagged for refresh — firing on unchanged Units would generate
 * unbounded paid embedding requests with no actual change to the
 * stored vector. Codex P2 on #91 caught the prior version which
 * embedded any owned Unit unconditionally.
 *
 * If a future use case needs forced re-embedding (e.g. prompt-
 * embedding-model swap), add an explicit `force: true` input to
 * the callable rather than removing this gate.
 */
export class ReembedNotPending extends Error {
  constructor() {
    super(
      "Unit does not need re-embedding (reembed_pending is not true).",
    );
    this.name = "ReembedNotPending";
  }
}

export async function reembedExperienceUnit(
  ctx: ReembedContext,
  deps: ReembedDeps = {},
): Promise<void> {
  const getUnit = deps.getUnit ?? defaultGetUnit;
  const embedFn = deps.embed ?? embed;
  const persistEmbedding = deps.persistEmbedding ?? defaultPersistEmbedding;

  const unit = await getUnit(ctx.unitId);
  // Anti-enumeration: collapse "not found" and "wrong owner" into
  // one error. Attackers can't probe the id space by observing
  // differential responses.
  if (unit === undefined || unit.owner_uid !== ctx.ownerUid) {
    throw new ReembedNotFoundOrForbidden();
  }

  // Pending-state gate. Codex P2 on #91: without this, an
  // authenticated caller could spam the endpoint and generate
  // unbounded paid embedding requests on unchanged Units. The
  // flag's whole purpose IS the gate — respect it. A legit
  // caller that wants forced re-embed (future: model swap, debug
  // tooling) should pass an explicit `force: true` — we don't
  // need that capability today.
  if (unit.reembed_pending !== true) {
    throw new ReembedNotPending();
  }

  // Defensive type guard on normalized_summary. Firestore docs
  // can be malformed (historic migration, manual console edit,
  // schema drift) and calling `.trim()` on a non-string would
  // throw a raw TypeError that bypasses the callable's error
  // mapping. Treating malformed content as "no content" funnels
  // into the same `failed-precondition` the empty-string case
  // gets, which is the right UX — both conditions mean "this
  // Unit needs real content before re-embed can proceed."
  // CodeRabbit Major on #91.
  const rawSummary = unit.normalized_summary;
  if (typeof rawSummary !== "string") {
    throw new ReembedEmptyInput();
  }
  const input = rawSummary.trim();
  if (input.length === 0) {
    throw new ReembedEmptyInput();
  }

  // If the embedding call throws, `reembed_pending` stays `true`
  // (we never wrote anything). The next trigger can retry. This
  // is the intended failure mode: transient API errors don't
  // corrupt the flag state, and the worker can re-pick-up the
  // same Unit later.
  const vector = await embedFn(input, { ownerUid: ctx.ownerUid });

  await persistEmbedding(ctx.unitId, vector);
}

async function defaultGetUnit(
  unitId: string,
): Promise<ExperienceUnit | undefined> {
  const snap = await getAdminDb().collection(COLLECTION).doc(unitId).get();
  return snap.exists ? (snap.data() as ExperienceUnit) : undefined;
}

async function defaultPersistEmbedding(
  unitId: string,
  embedding: number[],
): Promise<void> {
  // Atomic single-doc update: `embedding` set, `reembed_pending`
  // cleared. Firestore guarantees atomicity within a single
  // `update()` call — no half-written state between the two
  // fields. `updated_at` also stamped so the row's "most recent"
  // sort order reflects the refresh.
  await getAdminDb()
    .collection(COLLECTION)
    .doc(unitId)
    .update({
      embedding,
      reembed_pending: false,
      updated_at: new Date().toISOString(),
    });
}
