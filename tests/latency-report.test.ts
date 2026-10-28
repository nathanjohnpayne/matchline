import { describe, expect, it } from "vitest";

import {
  byRun,
  byStage,
  parseIsoDate,
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

  it("splits one Application's calls into separate runs after an idle gap", () => {
    // Two one-second validations a day apart are two runs, not one
    // day-long run (Codex on #617).
    const day = 86_400_000;
    const rows = [
      row({ applicationId: "a", createdAtMs: 1000, latencyMs: 1000 }),
      row({ applicationId: "a", createdAtMs: day + 1000, latencyMs: 1000 }),
    ];
    const runs = byRun(rows);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.spanMs)).toEqual([1000, 1000]);
  });

  it("keeps back-to-back calls in one run", () => {
    const rows = [
      row({ applicationId: "a", createdAtMs: 2000, latencyMs: 2000 }),
      row({ applicationId: "a", createdAtMs: 40_000, latencyMs: 1000 }), // 37 s idle < RUN_GAP_MS
    ];
    expect(byRun(rows)).toHaveLength(1);
  });

  it("accepts ISO dates and rejects impossible or non-ISO ones", () => {
    expect(parseIsoDate("since", "2026-10-01")).toBe(Date.UTC(2026, 9, 1));
    expect(parseIsoDate("since", "2026-10-01T12:00:00Z")).toBe(Date.UTC(2026, 9, 1, 12));
    expect(() => parseIsoDate("since", "2026-02-30")).toThrow(/calendar date/);
    expect(() => parseIsoDate("since", "2026-02-30T12:00:00Z")).toThrow(/calendar date/);
    expect(() => parseIsoDate("since", "10/01/2026")).toThrow(/ISO date/);
    expect(() => parseIsoDate("since", "2026-13-01")).toThrow();
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
