import { describe, expect, it, vi } from "vitest";

import type { ExperienceUnit } from "../types/capability.js";

import {
  ReembedEmptyInput,
  ReembedNotFoundOrForbidden,
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
    const persistEmbedding = vi.fn(async () => {});

    await reembedExperienceUnit(CTX, {
      getUnit,
      embed: embedFn,
      persistEmbedding,
    });

    expect(getUnit).toHaveBeenCalledWith("unit-1");
    expect(embedFn).toHaveBeenCalledWith(
      "Shipped playback SDK across 40M CTVs.",
      { ownerUid: "user-alice" },
    );
    expect(persistEmbedding).toHaveBeenCalledWith("unit-1", [0.1, 0.2, 0.3]);
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
