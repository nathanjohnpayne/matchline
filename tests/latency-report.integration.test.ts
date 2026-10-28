/**
 * Latency report Firestore fixture (#616, Codex on #617).
 *
 * Exercises the report's read path end to end against the emulator:
 * the `createdAt` window (`--since` inclusive, `--until` exclusive),
 * the field projection, Timestamp conversion, and the hand-off to the
 * Markdown renderer. The aggregation itself is unit-tested in
 * `latency-report.test.ts`.
 *
 * Runs under `npm run test:rules`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getAdminDb, initializeAdminAppForTests } from "../functions/src/firestore/admin.ts";
import { LLM_CALLS_COLLECTION, loadCallRows } from "../scripts/latency/load.ts";
import { renderMarkdown } from "../scripts/latency/report.ts";

const PROJECT_ID = "matchline-latency-report-test";

const SINCE_MS = Date.UTC(2026, 9, 1);
const UNTIL_MS = Date.UTC(2026, 9, 2);

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "latency-report.integration.test.ts must run under " +
        "`firebase emulators:exec` — FIRESTORE_EMULATOR_HOST not set.",
    );
  }
  initializeAdminAppForTests(PROJECT_ID);
});

afterAll(async () => {
  // No deleteApp — same rationale as the other integration suites
  // (functions-package singleton, process-scoped).
});

const db = (): ReturnType<typeof getAdminDb> => getAdminDb();

beforeEach(async () => {
  const snap = await db().collection(LLM_CALLS_COLLECTION).get();
  const batch = db().batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  if (snap.docs.length > 0) await batch.commit();
});

async function seed(id: string, fields: Record<string, unknown>): Promise<void> {
  await db().collection(LLM_CALLS_COLLECTION).doc(id).set(fields);
}

describe("latency report Firestore read (#616)", () => {
  it("loads the window's calls and renders them without application ids", async () => {
    const call = { model: "claude-sonnet", uid: "user-alice", inputTokens: 1200 };
    await seed("at-since", {
      ...call,
      stage: "generation",
      latencyMs: 4_000,
      costUsd: 0.01,
      applicationId: "app-private-id",
      createdAt: new Date(SINCE_MS),
    });
    await seed("in-window", {
      ...call,
      stage: "validation",
      subtask: "traceability",
      latencyMs: 2_000,
      attempt: 1,
      costUsd: 0.002,
      applicationId: "app-private-id",
      createdAt: new Date(SINCE_MS + 10_000),
    });
    await seed("eval-harness", {
      ...call,
      stage: "validation",
      subtask: "specificity",
      latencyMs: 3_000,
      runId: "eval-run-1",
      createdAt: new Date(SINCE_MS + 3_600_000),
    });
    await seed("no-latency", { ...call, stage: "generation", createdAt: new Date(SINCE_MS + 60_000) });
    await seed("before-since", { ...call, stage: "generation", latencyMs: 1_000, createdAt: new Date(SINCE_MS - 1) });
    await seed("at-until", { ...call, stage: "generation", latencyMs: 1_000, createdAt: new Date(UNTIL_MS) });

    const rows = await loadCallRows(db(), { sinceMs: SINCE_MS, untilMs: UNTIL_MS });
    const sorted = [...rows].sort((a, b) => a.createdAtMs - b.createdAtMs);

    expect(sorted).toEqual([
      {
        stage: "generation",
        subtask: undefined,
        model: "claude-sonnet",
        latencyMs: 4_000,
        createdAtMs: SINCE_MS,
        applicationId: "app-private-id",
        runId: undefined,
        attempt: undefined,
        costUsd: 0.01,
      },
      {
        stage: "validation",
        subtask: "traceability",
        model: "claude-sonnet",
        latencyMs: 2_000,
        createdAtMs: SINCE_MS + 10_000,
        applicationId: "app-private-id",
        runId: undefined,
        attempt: 1,
        costUsd: 0.002,
      },
      {
        stage: "validation",
        subtask: "specificity",
        model: "claude-sonnet",
        latencyMs: 3_000,
        createdAtMs: SINCE_MS + 3_600_000,
        applicationId: undefined,
        runId: "eval-run-1",
        attempt: undefined,
        costUsd: undefined,
      },
    ]);

    const md = renderMarkdown(rows, { sinceMs: SINCE_MS, untilMs: UNTIL_MS });
    expect(md).toContain("Window: 2026-10-01 to 2026-10-02.");
    expect(md).toContain("2 product calls; 1 eval-harness calls");
    expect(md).toContain("Per-application runs (calls tagged with an `applicationId`): 1.");
    // One run: starts 4 s before SINCE (createdAt − latency), ends 10 s after.
    expect(md).toContain("| 1 | 2026-09-30 | 2 | generation, traceability | 6.0 s | 14.0 s |");
    expect(md).not.toContain("app-private-id");
  });

  it("returns no rows for an empty window", async () => {
    await seed("outside", {
      stage: "generation",
      model: "claude-sonnet",
      latencyMs: 1_000,
      createdAt: new Date(UNTIL_MS + 1),
    });
    expect(await loadCallRows(db(), { sinceMs: SINCE_MS, untilMs: UNTIL_MS })).toEqual([]);
  });
});
