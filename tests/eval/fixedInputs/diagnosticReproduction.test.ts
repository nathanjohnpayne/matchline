/**
 * Opt-in: the runner reproduces the read-only matching diagnostic's
 * numbers from its saved vectors, offline.
 *
 * Skipped unless both are set:
 *   MATCHLINE_DIAG_EMBEDDINGS  path to the diagnostic's emb-all.json
 *   MATCHLINE_DIAG_RECORDS     directory holding 2a-inc-ext-1/ and 2a-sonnet55-high-1/
 *
 * The cache is seeded first-wins in the diagnostic's order (incumbent
 * flows, Sonnet flows, then the gold texts per cell), which is what
 * makes a per-text cache reproduce per-flow vectors that jittered
 * between batches. No request is made: the client factory throws.
 *
 * Expected figures: the per-arm values are the diagnostic's (PR #652);
 * the mixed conditions are its four-way table on #648, which prints the
 * mean of the two arms at one decimal (its "today" row, 21.4 / 23.8 /
 * 27.4, is the mean of the per-arm record/record figures).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlowsJsonl } from "../flowRecord.ts";
import { loadExpectedMatches, loadExpectedUnits } from "../loadFixtures.ts";

import { parseFixedInputArgs } from "./args.ts";
import { cacheLinesFor } from "./embeddingCache.ts";
import { equalCellMean, type FlowResult } from "./report.ts";
import { runFixedInputs } from "./run.ts";
import { sumDecompositions } from "./evaluate.ts";
import type { ScorerName } from "./scorers.ts";

const EMB = process.env.MATCHLINE_DIAG_EMBEDDINGS;
const RECORDS = process.env.MATCHLINE_DIAG_RECORDS;
const ARMS = { incumbent: "2a-inc-ext-1", sonnet55high: "2a-sonnet55-high-1" } as const;

interface DiagEmbeddings {
  readonly flows: readonly { arm: keyof typeof ARMS; idx: number; unitEmb: number[][]; reqEmb: number[][] }[];
  readonly gold: Readonly<Record<string, { unitEmb: number[][]; reqEmb: number[][] }>>;
}

/** `value` (a share) prints as `printed` (a percentage) at one decimal, whichever way a tie rounds. */
function expectPrinted(value: number | null, printed: number): void {
  expect(value).not.toBeNull();
  expect(Math.abs(100 * value! - printed)).toBeLessThanOrEqual(0.05 + 1e-9);
}

describe.skipIf(EMB === undefined || RECORDS === undefined)("diagnostic reproduction (opt-in)", () => {
  it("reproduces incumbent 22.6, Sonnet 5.5 high 20.1 / 23.3 / 28.5, the mixed conditions and gold + gold 31.25 offline", async () => {
    const base = mkdtempSync(join(tmpdir(), "matchline-diag-"));
    try {
      const emb = JSON.parse(readFileSync(EMB!, "utf8")) as DiagEmbeddings;
      const rows = Object.fromEntries(
        Object.entries(ARMS).map(([arm, dir]) => {
          const path = join(RECORDS!, dir, "flows.jsonl");
          return [arm, parseFlowsJsonl(readFileSync(path, "utf8"), path)];
        }),
      );
      const entries: { text: string; vector: number[] }[] = [];
      for (const ef of emb.flows) {
        const r = rows[ef.arm]![ef.idx]!;
        r.units!.forEach((u, i) => entries.push({ text: String(u.normalized_summary), vector: ef.unitEmb[i]! }));
        r.requirements!.forEach((q, i) => entries.push({ text: String(q.normalized_requirement), vector: ef.reqEmb[i]! }));
      }
      for (const [cell, g] of Object.entries(emb.gold)) {
        const [rid, jid] = cell.split("__") as [string, string];
        loadExpectedUnits(rid).expected_units.forEach((u, i) => entries.push({ text: u.normalized_summary, vector: g.unitEmb[i]! }));
        loadExpectedMatches(rid, jid).expected_requirements.forEach((q, i) => entries.push({ text: q.text, vector: g.reqEmb[i]! }));
      }
      const cache = join(base, "embeddings.jsonl");
      writeFileSync(cache, cacheLinesFor(entries));

      const outcome = await runFixedInputs(
        parseFixedInputArgs([
          "--records",
          join(RECORDS!, ARMS.incumbent),
          join(RECORDS!, ARMS.sonnet55high),
          "--units",
          "gold",
          "--requirements",
          "gold",
          "--scorer",
          "current,renormalized,cosine",
          "--embeddings-cache",
          cache,
        ]),
        {
          env: {},
          openaiClient: () => {
            throw new Error("the seeded cache should serve every text");
          },
        },
      );
      // The one Sonnet jitter flip (below) is the only thing on stderr, and it does not fail the run.
      expect(outcome.stderr).toMatch(
        /^warning: record\/record under the current scorer does not reproduce 1 of 24 recorded flow\(s\): ext-sonnet55-high \S+ #\d+ \(recorded [\d.]+, rerun [\d.]+, [+-]?[\d.]+\)\. The run still exits 0; see "Reproduces the record" in the report\.$/u,
      );
      expect(outcome.code).toBe(0);
      const result = outcome.result!;
      expect(result.plan.uncachedTexts).toBe(0);
      const inc = result.flows.filter((f) => f.arm === "inc-ext");
      const son = result.flows.filter((f) => f.arm === "ext-sonnet55-high");
      expect(inc).toHaveLength(12);
      expect(son).toHaveLength(12);
      expect(equalCellMean(inc, "record/record", "current")).toBeCloseTo(0.2257, 4);
      expect(equalCellMean(inc, "record/record", "renormalized")).toBeCloseTo(0.2431, 3);
      expect(equalCellMean(inc, "record/record", "cosine")).toBeCloseTo(0.2639, 3);
      expect(equalCellMean(son, "record/record", "current")).toBeCloseTo(0.2014, 4);
      // Renormalized and cosine on Sonnet 5.5 high: 23.26 and 28.47, printed 23.3 and 28.5.
      expect(equalCellMean(son, "record/record", "renormalized")).toBeCloseTo(0.2326, 4);
      expect(equalCellMean(son, "record/record", "cosine")).toBeCloseTo(0.2847, 4);
      expect(outcome.stdout).toMatch(/\| ext-sonnet55-high \| `record\/record` \| 12 \| \d+ \| 20\.1 \| 23\.3 \| 28\.5 \|/);

      // The four-way table, as the mean of the two arms (each an equal-cell-weight mean).
      const bothArms = (flows: readonly FlowResult[][], condition: string, scorer: ScorerName): number =>
        flows.reduce((a, f) => a + equalCellMean(f, condition, scorer)!, 0) / flows.length;
      const table: Record<string, readonly [number, number, number]> = {
        "record/record": [21.4, 23.8, 27.4],
        "gold/record": [25.0, 31.6, 26.7],
        "record/gold": [28.3, 29.9, 31.1],
      };
      for (const [condition, [current, renormalized, cosine]] of Object.entries(table)) {
        expectPrinted(bothArms([inc, son], condition, "current"), current);
        expectPrinted(bothArms([inc, son], condition, "renormalized"), renormalized);
        expectPrinted(bothArms([inc, son], condition, "cosine"), cosine);
      }
      // 90 of 288 labelled pairs: printed 31.2 by the diagnostic, 31.3 by toFixed; the value is 0.3125.
      expect(equalCellMean(inc, "gold/gold", "current")).toBeCloseTo(0.3125, 9);
      expect(equalCellMean(son, "gold/gold", "current")).toBeCloseTo(0.3125, 9);
      const d = sumDecompositions(inc.map((f) => f.conditions["record/record"]!.current!.decomposition));
      expect([d.expected, d.A, d.B, d.C, d.found]).toEqual([288, 0, 10, 213, 65]);
      const ds = sumDecompositions(son.map((f) => f.conditions["record/record"]!.current!.decomposition));
      expect([ds.A, ds.B, ds.C, ds.found]).toEqual([4, 10, 216, 58]);
      // Reproduction of the recorded accuracies: incumbent 12/12, Sonnet 11/12 (one jitter flip).
      expect(outcome.stdout).toMatch(/\| inc-ext \| 12 \| 12 \| 12 \|/);
      expect(outcome.stdout).toMatch(/\| ext-sonnet55-high \| 12 \| 11 \| 12 \|/);
      // The flipped flow is listed by name.
      expect(result.reproductionMismatches).toHaveLength(1);
      expect(result.reproductionMismatches![0]).toMatchObject({ arm: "ext-sonnet55-high" });
      expect(result.reproductionMismatches![0]!.recordedMatchCount).toBe(result.reproductionMismatches![0]!.rerunMatchCount);
      expect(outcome.stdout).toContain("### Mismatched flows (1)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
