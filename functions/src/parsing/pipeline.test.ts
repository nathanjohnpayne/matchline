import { describe, expect, it, vi } from "vitest";

import type { JobRequirementUnit } from "../types/capability.ts";

import { JdParsingError } from "./errors.ts";
import { runJdParsingPipeline } from "./pipeline.ts";

function mockRequirement(
  overrides: Partial<JobRequirementUnit> = {},
): JobRequirementUnit {
  const base: JobRequirementUnit = {
    id: "id-1",
    owner_uid: "user-alice",
    role_id: "role-1",
    raw_text: "5+ years PM.",
    normalized_requirement: "5+ years PM experience.",
    category: "experience_level",
    keywords: [],
    tools: [],
    domains: [],
    priority: "high",
    must_have: true,
    extracted_from: "qualifications",
  };
  return { ...base, ...overrides };
}

const CTX = { ownerUid: "user-alice", roleId: "role-1" };

describe("runJdParsingPipeline", () => {
  it("parses, embeds, stamps embedding, persists atomically, and returns Units", async () => {
    const r1 = mockRequirement({ id: "id-1", normalized_requirement: "one" });
    const r2 = mockRequirement({ id: "id-2", normalized_requirement: "two" });
    const parse = vi.fn(async () => [r1, r2]);
    const embed = vi.fn(async () => [
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const persistBatch = vi.fn(async () => {});

    const result = await runJdParsingPipeline("JD text", CTX, {
      parse,
      embed,
      persistBatch,
    });

    expect(parse).toHaveBeenCalledWith("JD text", CTX);
    expect(embed).toHaveBeenCalledWith(["one", "two"], {
      ownerUid: "user-alice",
    });
    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(result[0]!.embedding).toEqual([0.1, 0.2]);
    expect(result[1]!.embedding).toEqual([0.3, 0.4]);
  });

  it("short-circuits when parse returns zero requirements", async () => {
    const parse = vi.fn(async () => []);
    const embed = vi.fn();
    const persistBatch = vi.fn();

    const result = await runJdParsingPipeline("empty", CTX, {
      parse,
      embed,
      persistBatch,
    });

    expect(result).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it("throws on embedding count mismatch before persisting", async () => {
    const parse = vi.fn(async () => [mockRequirement(), mockRequirement({ id: "id-2" })]);
    const embed = vi.fn(async () => [[0.1]]); // 1 embedding for 2 reqs
    const persistBatch = vi.fn();

    await expect(
      runJdParsingPipeline("JD text", CTX, { parse, embed, persistBatch }),
    ).rejects.toThrow(/Embedding count mismatch/);
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it("propagates JdParsingError unchanged", async () => {
    const parse = vi.fn(async () => {
      throw new JdParsingError("fail", [
        { attempt: 0, kind: "schema_error", message: "bad" },
      ]);
    });
    const embed = vi.fn();
    const persistBatch = vi.fn();

    await expect(
      runJdParsingPipeline("JD text", CTX, { parse, embed, persistBatch }),
    ).rejects.toBeInstanceOf(JdParsingError);
    expect(embed).not.toHaveBeenCalled();
    expect(persistBatch).not.toHaveBeenCalled();
  });

  it("persistBatch sees the full batch in one call (atomicity contract)", async () => {
    const reqs = Array.from({ length: 4 }, (_, i) =>
      mockRequirement({ id: `id-${i}` }),
    );
    const parse = vi.fn(async () => reqs);
    const embed = vi.fn(async () => reqs.map((_, i) => [i]));
    const persistBatch = vi.fn(async () => {});

    await runJdParsingPipeline("JD text", CTX, { parse, embed, persistBatch });

    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch.mock.calls[0]![0]).toHaveLength(4);
  });

  it("a batch-commit failure rejects the pipeline", async () => {
    const parse = vi.fn(async () => [mockRequirement()]);
    const embed = vi.fn(async () => [[0.1]]);
    const persistBatch = vi.fn(async () => {
      throw new Error("firestore batch failed");
    });

    await expect(
      runJdParsingPipeline("JD text", CTX, { parse, embed, persistBatch }),
    ).rejects.toThrow(/firestore batch failed/);
  });
});
