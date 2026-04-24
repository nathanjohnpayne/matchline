import { describe, expect, it, vi } from "vitest";

import type { ExperienceUnit } from "../types/capability.js";

import {
  ReembedEmptyInput,
  ReembedNotFoundOrForbidden,
  ReembedNotPending,
  reembedExperienceUnit,
  type ReembedContext,
} from "./reembed.js";

/**
 * Tests for the re-embed pipeline. All paths are exercised through
 * dependency injection — no real Firestore admin or OpenAI client
 * is touched.
 */

function unit(
  partial: Partial<ExperienceUnit> & { id: string },
): ExperienceUnit {
  const defaults: Omit<ExperienceUnit, "id"> = {
    owner_uid: "user-alice",
    source_type: "resume",
    source_ref: "resume.pdf",
    raw_text: "raw",
    normalized_summary: "summary",
    unit_type: "achievement",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.8,
    user_approved: false,
    reembed_pending: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

describe("reembedExperienceUnit", () => {
  const CTX: ReembedContext = { ownerUid: "user-alice", unitId: "unit-1" };

  it("happy path: reads Unit, embeds normalized_summary, persists embedding + clears flag", async () => {
    const target = unit({
      id: "unit-1",
      normalized_summary: "Shipped playback SDK across 40M CTVs.",
    });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);
    const persistEmbedding = vi.fn<
      (
        unitId: string,
        embedding: number[],
        embeddedText: string,
        ctx: { readonly ownerUid: string },
      ) => Promise<"wrote" | "skipped_stale">
    >(async () => "wrote" as const);

    const result = await reembedExperienceUnit(CTX, {
      getUnit,
      embed: embedFn,
      persistEmbedding,
    });

    expect(result).toBe("wrote");
    expect(getUnit).toHaveBeenCalledWith("unit-1");
    expect(embedFn).toHaveBeenCalledWith(
      "Shipped playback SDK across 40M CTVs.",
      { ownerUid: "user-alice" },
    );
    // Persist receives the embedded text so it can compare-and-
    // set against the current Unit's summary, skipping stale
    // writes (Codex P1 on #91).
    // Persist receives: unitId, embedding, embeddedText, and the
    // caller's ownerUid (for the tx owner_uid re-check that
    // nathanpayne-codex Phase 4b caught).
    expect(persistEmbedding).toHaveBeenCalledWith(
      "unit-1",
      [0.1, 0.2, 0.3],
      "Shipped playback SDK across 40M CTVs.",
      { ownerUid: "user-alice" },
    );
  });

  it("threads ownerUid through to persistEmbedding (for the transactional ownership re-check)", async () => {
    // nathanpayne-codex Phase 4b on #91: the tx re-read must
    // re-verify owner_uid before writing, because the admin SDK
    // bypasses rules and a tombstone-then-recreate race could
    // land our embedding on a different owner's Unit. Pin that
    // the caller's uid is passed into persist — the transaction
    // itself is exercised in the integration path.
    const target = unit({ id: "unit-1", owner_uid: "user-alice" });
    const persistEmbedding = vi.fn<
      (
        unitId: string,
        embedding: number[],
        embeddedText: string,
        ctx: { readonly ownerUid: string },
      ) => Promise<"wrote" | "skipped_stale">
    >(async () => "wrote" as const);
    await reembedExperienceUnit(CTX, {
      getUnit: async () => target,
      embed: async () => [0.0],
      persistEmbedding,
    });
    const call = persistEmbedding.mock.calls[0]!;
    expect(call[3]).toEqual({ ownerUid: "user-alice" });
  });

  it("returns 'skipped_stale' when the persist step detects a concurrent edit", async () => {
    // Codex P1 on #91 caught the race: an edit during embedding
    // could leave the Unit with a stale embedding and a false
    // reembed_pending (no trigger to repair). The persist step
    // now compare-and-sets against normalized_summary; when it
    // returns "skipped_stale", the core pipeline propagates it so
    // callers/tests can observe the no-op.
    const target = unit({ id: "unit-1" });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn(async () => [0.0]);
    const persistEmbedding = vi.fn(async () => "skipped_stale" as const);

    const result = await reembedExperienceUnit(CTX, {
      getUnit,
      embed: embedFn,
      persistEmbedding,
    });
    expect(result).toBe("skipped_stale");
    // Embedding was still attempted (we had no way to know the
    // content was stale until the transactional re-read inside
    // persist). Cost is incurred even on stale-writes — that's
    // unavoidable at this level; preventing the paid call on
    // every stale race would require a second full transaction
    // around the embed itself, which isn't worth the latency.
    expect(embedFn).toHaveBeenCalled();
  });

  it("throws ReembedNotFoundOrForbidden when the Unit doesn't exist", async () => {
    const getUnit = vi.fn(async () => undefined);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedNotFoundOrForbidden);
    // Neither side effect ran
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("throws ReembedNotFoundOrForbidden when the Unit is owned by a different user (anti-enumeration)", async () => {
    // Distinct from "not found" at the storage layer, but the core
    // collapses both into the same error so the callable can emit
    // a single message. Pin the collapse.
    const target = unit({ id: "unit-1", owner_uid: "user-bob" });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedNotFoundOrForbidden);
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("throws ReembedEmptyInput when normalized_summary is blank (defensive)", async () => {
    const target = unit({ id: "unit-1", normalized_summary: "   " });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedEmptyInput);
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("throws ReembedEmptyInput when normalized_summary is a non-string (malformed Firestore data)", async () => {
    // Defensive guard: if Firestore ever returns a doc where
    // `normalized_summary` isn't a string (historic migration,
    // manual console edit, schema drift), calling `.trim()` on
    // it would throw a raw TypeError that bypasses the
    // callable's error mapping. The guard funnels malformed
    // content into the same `failed-precondition` the empty
    // case gets. CodeRabbit Major on #91.
    const malformed = unit({
      id: "unit-1",
      normalized_summary: null as unknown as string,
    });
    const getUnit = vi.fn(async () => malformed);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedEmptyInput);
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("throws ReembedNotPending when reembed_pending is false (prevents paid-embed spam)", async () => {
    // Codex P2 on #91: without this gate, an authenticated caller
    // could call the endpoint repeatedly on an unchanged Unit
    // and trigger unbounded paid embedding requests. The flag's
    // whole purpose is the gate — a Unit whose embedding is
    // current shouldn't get re-embedded.
    const target = unit({ id: "unit-1", reembed_pending: false });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedNotPending);
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("throws ReembedNotPending when reembed_pending is missing entirely (undefined)", async () => {
    // Optional field — `reembed_pending?: boolean` in the type.
    // A Unit that was never flagged (e.g. extracted resume Unit
    // with embedding already in place) has no such field. The
    // strict `=== true` check treats both `false` and
    // `undefined` as "not pending", which is correct.
    const target = unit({ id: "unit-1", reembed_pending: undefined });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn();
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toBeInstanceOf(ReembedNotPending);
    expect(embedFn).not.toHaveBeenCalled();
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("does NOT persist when the embedding API throws (reembed_pending stays true for retry)", async () => {
    // This is the intended failure mode: transient API errors don't
    // corrupt the flag state. The worker / callable can re-trigger
    // the same Unit later.
    const target = unit({ id: "unit-1" });
    const getUnit = vi.fn(async () => target);
    const embedFn = vi.fn(async () => {
      throw new Error("Embeddings API timed out");
    });
    const persistEmbedding = vi.fn();

    await expect(
      reembedExperienceUnit(CTX, { getUnit, embed: embedFn, persistEmbedding }),
    ).rejects.toThrow(/timed out/);
    expect(persistEmbedding).not.toHaveBeenCalled();
  });

  it("passes ownerUid through to the embedding call for cost attribution", async () => {
    // The embedding call records usage via `recordUsage` with the
    // ownerUid, so the per-user spend rollup sees the re-embed.
    // Pin that the ctx's ownerUid is threaded through the embed
    // call.
    const target = unit({ id: "unit-1", owner_uid: "user-alice" });
    const embedFn = vi.fn(async () => [0.0]);
    await reembedExperienceUnit(
      { ownerUid: "user-alice", unitId: "unit-1" },
      {
        getUnit: async () => target,
        embed: embedFn,
        persistEmbedding: async () => {},
      },
    );
    expect(embedFn).toHaveBeenCalledWith(expect.any(String), {
      ownerUid: "user-alice",
    });
  });

  it("trims the normalized_summary before embedding (consistency with extraction pipeline)", async () => {
    // The extraction + matching prompts normalize inputs with
    // leading/trailing whitespace trimmed so the embedding matches
    // the stored value's semantic content. Pin the same here.
    const target = unit({
      id: "unit-1",
      normalized_summary: "   Leading and trailing space   ",
    });
    const embedFn = vi.fn(async () => [0.0]);
    await reembedExperienceUnit(CTX, {
      getUnit: async () => target,
      embed: embedFn,
      persistEmbedding: async () => {},
    });
    expect(embedFn).toHaveBeenCalledWith(
      "Leading and trailing space",
      { ownerUid: "user-alice" },
    );
  });
});
