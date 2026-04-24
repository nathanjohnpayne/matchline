import { describe, expect, it, vi } from "vitest";

import type { ExperienceUnit } from "../types/capability.ts";

import { ExtractionError } from "./errors.ts";
import { runExtractionPipeline } from "./pipeline.ts";

/**
 * Build a fake extracted Unit matching the shape #67 produces.
 * Embedding is absent — the pipeline under test stamps it from the
 * mocked embedMany result.
 */
function mockUnit(overrides: Partial<ExperienceUnit> = {}): ExperienceUnit {
  const base: ExperienceUnit = {
    id: "id-1",
    owner_uid: "user-alice",
    source_type: "resume",
    source_ref: "resume:abcd1234abcd1234:0",
    raw_text: "Did a thing.",
    normalized_summary: "Did a thing.",
    unit_type: "project",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 0.9,
    user_approved: false,
    created_at: "2026-04-24T00:00:00.000Z",
    updated_at: "2026-04-24T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}

describe("runExtractionPipeline", () => {
  it("extracts, embeds, stamps embedding, persists, and returns Units", async () => {
    const u1 = mockUnit({ id: "id-1", normalized_summary: "one" });
    const u2 = mockUnit({
      id: "id-2",
      normalized_summary: "two",
      source_ref: "resume:abcd1234abcd1234:1",
    });

    const extract = vi.fn(async () => [u1, u2]);
    const embed = vi.fn(async () => [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    const persisted: ExperienceUnit[] = [];
    const persist = vi.fn(async (u: ExperienceUnit) => {
      persisted.push(u);
    });

    const result = await runExtractionPipeline(
      "Pasted resume text",
      { ownerUid: "user-alice" },
      { extract, embed, persist },
    );

    // Extraction called with the input text and context.
    expect(extract).toHaveBeenCalledWith("Pasted resume text", {
      ownerUid: "user-alice",
    });

    // Embeddings called on normalized_summary array in input order,
    // with owner context threaded through for cost attribution.
    expect(embed).toHaveBeenCalledWith(["one", "two"], {
      ownerUid: "user-alice",
    });

    // Persist called once per unit.
    expect(persist).toHaveBeenCalledTimes(2);

    // Each returned Unit carries its index-aligned embedding.
    expect(result[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result[1]!.embedding).toEqual([0.4, 0.5, 0.6]);

    // Persisted Units match the returned Units (embedding included).
    expect(persisted).toHaveLength(2);
    expect(persisted[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(persisted[1]!.embedding).toEqual([0.4, 0.5, 0.6]);
  });

  it("short-circuits when extraction returns zero units (no embed, no persist)", async () => {
    const extract = vi.fn(async () => []);
    const embed = vi.fn();
    const persist = vi.fn();

    const result = await runExtractionPipeline(
      "empty-ish input",
      { ownerUid: "user-alice" },
      { extract, embed, persist },
    );

    expect(result).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("throws when embedMany returns a mismatched count (defensive check)", async () => {
    const extract = vi.fn(async () => [mockUnit(), mockUnit({ id: "id-2" })]);
    const embed = vi.fn(async () => [[0.1, 0.2]]); // 1 embedding for 2 units
    const persist = vi.fn();

    await expect(
      runExtractionPipeline(
        "paste",
        { ownerUid: "user-alice" },
        { extract, embed, persist },
      ),
    ).rejects.toThrow(/Embedding count mismatch/);
    // Persist never fired — the mismatch is caught before step 3.
    expect(persist).not.toHaveBeenCalled();
  });

  it("propagates ExtractionError unchanged (doesn't embed or persist)", async () => {
    const extract = vi.fn(async () => {
      throw new ExtractionError("Failed after retries.", [
        { attempt: 0, kind: "schema_error", message: "bad shape" },
      ]);
    });
    const embed = vi.fn();
    const persist = vi.fn();

    await expect(
      runExtractionPipeline(
        "paste",
        { ownerUid: "user-alice" },
        { extract, embed, persist },
      ),
    ).rejects.toBeInstanceOf(ExtractionError);

    expect(embed).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("source_ref is determined upstream by extract — pipeline preserves it verbatim", async () => {
    // The idempotence property ("same input → same source_refs")
    // lives in #67's stampServerFields. The pipeline's job is to
    // not destroy it on the way through.
    const u = mockUnit({ source_ref: "resume:deadbeefdeadbeef:0" });
    const extract = vi.fn(async () => [u]);
    const embed = vi.fn(async () => [[0.1]]);
    const persist = vi.fn(async () => {});

    const [result] = await runExtractionPipeline(
      "same-input",
      { ownerUid: "user-alice" },
      { extract, embed, persist },
    );

    expect(result!.source_ref).toBe("resume:deadbeefdeadbeef:0");
    // Persist receives the same source_ref (not mutated by pipeline).
    expect(persist.mock.calls[0]![0].source_ref).toBe(
      "resume:deadbeefdeadbeef:0",
    );
  });

  it("propagates a persist failure (one write fails → Promise.all rejects)", async () => {
    const extract = vi.fn(async () => [mockUnit(), mockUnit({ id: "id-2" })]);
    const embed = vi.fn(async () => [[0.1], [0.2]]);
    const persist = vi.fn(async (u: ExperienceUnit) => {
      if (u.id === "id-2") throw new Error("firestore blew up");
    });

    await expect(
      runExtractionPipeline(
        "paste",
        { ownerUid: "user-alice" },
        { extract, embed, persist },
      ),
    ).rejects.toThrow(/firestore blew up/);
  });
});
