import { describe, expect, it } from "vitest";

import {
  byRun,
  byStage,
  percentile,
  productCalls,
  renderMarkdown,
  type CallRow,
} from "../scripts/latency/report.ts";

const row = (over: Partial<CallRow>): CallRow => ({
  stage: "validation",
  model: "claude-sonnet-4-6",
  latencyMs: 1000,
  createdAtMs: 10_000,
  ...over,
});

describe("latency report (#616)", () => {
  it("uses nearest-rank percentiles", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(10);
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([7], 0.5)).toBe(7);
  });

  it("drops eval-harness calls, which carry a runId", () => {
    const rows = [row({}), row({ runId: "eval-1" })];
    expect(productCalls(rows)).toHaveLength(1);
  });

  it("groups by stage and subtask and sorts by p95", () => {
    const rows = [
      row({ subtask: "traceability", latencyMs: 2000 }),
      row({ subtask: "traceability", latencyMs: 4000 }),
      row({ subtask: "specificity", latencyMs: 500 }),
      row({ stage: "generation", model: "claude-haiku-4-5", latencyMs: 9000 }),
    ];
    const stages = byStage(rows);
    expect(stages.map((s) => `${s.stage}/${s.subtask}`)).toEqual([
      "generation/",
      "validation/traceability",
      "validation/specificity",
    ]);
    expect(stages[1]).toMatchObject({ n: 2, p50Ms: 2000, p95Ms: 4000, maxMs: 4000 });
  });

  it("spans a run from the first call's start to the last call's end", () => {
    // Serial calls: 0-3 s, 3-5 s, 5-6 s. Sum 6 s, span 6 s.
    const rows = [
      row({ applicationId: "a", createdAtMs: 3000, latencyMs: 3000, subtask: "claim_extraction" }),
      row({ applicationId: "a", createdAtMs: 5000, latencyMs: 2000, subtask: "traceability" }),
      row({ applicationId: "a", createdAtMs: 6000, latencyMs: 1000, subtask: "specificity" }),
      row({ createdAtMs: 9000 }), // untagged: not a run
    ];
    const runs = byRun(rows);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ calls: 3, sumLatencyMs: 6000, spanMs: 6000, startMs: 0 });
  });

  it("renders without application ids", () => {
    const md = renderMarkdown([row({ applicationId: "secret-app-id" })], {
      sinceMs: 0,
      untilMs: 86_400_000,
    });
    expect(md).not.toContain("secret-app-id");
    expect(md).toContain("| validation |");
  });
});
