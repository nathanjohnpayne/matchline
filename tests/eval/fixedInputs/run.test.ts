import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseFixedInputArgs } from "./args.ts";
import { sha256File } from "./corrections.ts";
import { DIAGNOSTIC_BANNER, GOLD_DEFINITION } from "./report.ts";
import { REPORT_FILE, RESULT_FILE, runFixedInputs, type FixedInputsDeps } from "./run.ts";
import { CELL, flowFor, gitRepo, JD, mockOpenAi, RESUME, savedItems, writeFlows } from "./testSupport.ts";

let base: string;
let root: string;
let records: string;
let cachePath: string;
let client: ReturnType<typeof mockOpenAi>;
let factory: ReturnType<typeof vi.fn>;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "matchline-fixed-inputs-"));
  root = gitRepo(join(base, "repo"));
  cachePath = join(base, "cache", "embeddings.jsonl");
  records = writeFlows(join(base, "records-a"), [
    flowFor("arm-a", "inv-a", 0, savedItems(0, { dropUnits: 2 })),
    flowFor("arm-a", "inv-a", 1, savedItems(1, { dropReqs: 2 })),
    flowFor("arm-a", "inv-a", 2, null),
  ]);
  writeFlows(join(base, "records-b"), [flowFor("arm-b", "inv-b", 0, savedItems(5, { dropUnits: 4, dropReqs: 1 }))]);
  client = mockOpenAi();
  factory = vi.fn(() => client);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function deps(extra: Partial<FixedInputsDeps> = {}): FixedInputsDeps {
  return { root, openaiClient: factory as unknown as () => typeof client, env: {}, ...extra };
}

const argv = (...rest: string[]): string[] => [
  "--records",
  records,
  join(base, "records-b"),
  "--embeddings-cache",
  cachePath,
  ...rest,
];

describe("runFixedInputs", () => {
  it("runs the 2×2 end to end, prints every section and writes the result", async () => {
    const out = join(base, "out");
    const outcome = await runFixedInputs(
      parseFixedInputArgs(argv("--units", "gold", "--requirements", "gold", "--scorer", "current,cosine", "--out", out)),
      deps(),
    );
    expect(outcome.stderr).not.toMatch(/failed|refused/);
    expect(outcome.code).toBe(0);
    const md = outcome.stdout;
    expect(md).toContain(DIAGNOSTIC_BANNER);
    expect(md).toContain("#636");
    expect(md).toContain(GOLD_DEFINITION);
    for (const h of ["## Plan", "## By condition", "## By cell", "## Missed labelled pairs", "## Reproduces the record"]) {
      expect(md).toContain(h);
    }
    expect(md).toMatch(/\| arm-a \| `gold\/gold` \| 2 \| 1 \|/);
    expect(md).toMatch(/\| arm-b \| `record\/record` \| 1 \| 1 \|/);
    expect(md).toContain("Skipped 1 flow(s): saved no Units or no Requirements");
    const result = outcome.result!;
    expect(result.conditions).toEqual(["record/record", "gold/record", "record/gold", "gold/gold"]);
    expect(result.flows).toHaveLength(3);
    for (const f of result.flows) {
      for (const c of result.conditions) {
        for (const s of ["current", "cosine"] as const) {
          const cell = f.conditions[c]![s]!;
          const d = cell.decomposition;
          expect(d.found + d.A + d.B + d.C).toBe(d.expected);
          expect(cell.accuracy).toBeCloseTo(d.found / d.expected, 12);
        }
      }
      // Gold sides map by identity, so nothing is missing for representation.
      expect(f.conditions["gold/gold"]!.current!.decomposition.A + f.conditions["gold/gold"]!.current!.decomposition.B).toBe(0);
    }
    // Dropped Units show up as A on the record side.
    const dropped = result.flows.find((f) => f.arm === "arm-b")!;
    expect(dropped.conditions["record/record"]!.current!.decomposition.A).toBeGreaterThan(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(out, RESULT_FILE), "utf8")).flows).toHaveLength(3);
    expect(readFileSync(join(out, REPORT_FILE), "utf8")).toBe(md);

    // Same output directory again: refused, nothing overwritten.
    const again = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--out", out)), deps());
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/already holds fixed-inputs.json/);

    // Same texts again: the cache serves every one, no client is built.
    factory.mockClear();
    const warm = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--requirements", "gold")), deps());
    expect(warm.code).toBe(0);
    expect(warm.result!.plan.uncachedTexts).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it("refuses an in-repo --out or cache before reading anything", async () => {
    const inRepoOut = await runFixedInputs(parseFixedInputArgs(argv("--out", join(root, "out"))), deps());
    expect(inRepoOut.code).toBe(2);
    expect(inRepoOut.stderr).toMatch(/--out .* inside this repository/);
    const inRepoCache = await runFixedInputs(
      parseFixedInputArgs(["--records", records, "--embeddings-cache", join(root, "c.jsonl")]),
      deps(),
    );
    expect(inRepoCache.stderr).toMatch(/--embeddings-cache .* inside this repository/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("prices before any request: above --max-usd it refuses without a client", async () => {
    const outcome = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--max-usd", "0.0000001")), deps());
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toMatch(/above --max-usd \$1e-7\. No request was sent/);
    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("--dry-run prints the plan and estimate and never builds a client", async () => {
    const outcome = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--dry-run")), deps());
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toMatch(/dry run/);
    expect(outcome.stdout).toMatch(/distinct texts, 0 cached, \d+ uncached/);
    expect(outcome.stdout).toMatch(/Estimated embedding spend .* \$0\.0000/);
    expect(outcome.stdout).toMatch(/needs OPENAI_API_KEY/);
    expect(factory).not.toHaveBeenCalled();
  });

  it("without a key: refuses when texts are uncached, completes when the cache is warm", async () => {
    const noKey = { root, env: {} };
    const cold = await runFixedInputs(parseFixedInputArgs(argv()), noKey);
    expect(cold.code).toBe(1);
    expect(cold.stderr).toMatch(/uncached; export OPENAI_API_KEY or seed the cache/);
    await runFixedInputs(parseFixedInputArgs(argv()), deps());
    const warm = await runFixedInputs(parseFixedInputArgs(argv()), noKey);
    expect(warm.code).toBe(0);
    expect(warm.result!.fill).toBeNull();
  });

  it("flags flows whose recorded accuracy the record/record run reproduces", async () => {
    const first = await runFixedInputs(parseFixedInputArgs(["--records", records, "--embeddings-cache", cachePath]), deps());
    const f0 = first.result!.flows.find((f) => f.sampleIndex === 0)!;
    const acc = f0.conditions["record/record"]!.current!.accuracy;
    const count = f0.conditions["record/record"]!.current!.matchCount;
    const again = writeFlows(join(base, "records-c"), [
      flowFor("arm-a", "inv-c", 0, savedItems(0, { dropUnits: 2 }), { matchAccuracy: acc, matchCount: count }),
      flowFor("arm-a", "inv-c", 1, savedItems(1, { dropReqs: 2 }), { matchAccuracy: acc + 0.5, matchCount: count }),
    ]);
    const second = await runFixedInputs(parseFixedInputArgs(["--records", again, "--embeddings-cache", cachePath]), deps());
    expect(second.stdout).toMatch(/\| arm-a \| 2 \| 1 \| 1 \|/);
  });

  it("reports recall@k when --k is given", async () => {
    const outcome = await runFixedInputs(parseFixedInputArgs(argv("--k", "500")), deps());
    expect(outcome.result!.metric).toBe("recall@500");
    for (const f of outcome.result!.flows) {
      const d = f.conditions["record/record"]!.current!.decomposition;
      expect(d.C).toBe(0); // every mapped pair is inside a 500-wide window
    }
    expect(outcome.stdout).not.toContain("## Reproduces the record");
  });
});

describe("runFixedInputs with owner corrections", () => {
  function correctionsFile(name: string, sample: number, items: ReturnType<typeof savedItems>): string {
    const body = {
      resumeId: RESUME,
      jdId: JD,
      units: items.units.map((u, i) => ({
        ...u,
        owner_verdict: i === 0 ? "drop" : "keep",
        owner_corrected_raw_text: null,
      })),
      requirements: items.requirements.map((q, i) => ({
        ...q,
        owner_verdict: i === 0 ? "fix" : "keep",
        owner_corrected_text: i === 0 ? `${q.normalized_requirement} (corrected)` : null,
        owner_must_have: null,
      })),
      notes: `sample ${sample}`,
    };
    const path = join(base, name);
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
  }

  function manifest(...paths: string[]): string {
    const m = join(base, "manifest.json");
    writeFileSync(m, JSON.stringify({ version: 1, entries: paths.map((p, i) => ({ sha256: sha256File(p), name: `set ${i + 1}`, cell: CELL })) }));
    return m;
  }

  it("runs the source flow only, names the set by hash and lists the corrected items", async () => {
    const file = correctionsFile("c.json", 1, savedItems(1, { dropReqs: 2 }));
    const outcome = await runFixedInputs(
      parseFixedInputArgs(argv("--units", file, "--requirements", file)),
      deps({ manifestPath: manifest(file) }),
    );
    expect(outcome.stderr).not.toMatch(/failed|refused/);
    expect(outcome.code).toBe(0);
    const result = outcome.result!;
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]!.sampleIndex).toBe(1);
    expect(result.conditions).toEqual(["record/record", "corrected/record", "record/corrected", "corrected/corrected"]);
    expect(result.corrections.map((c) => [c.side, c.name, c.sha256])).toEqual([
      ["units", "set 1", sha256File(file)],
      ["requirements", "set 1", sha256File(file)],
    ]);
    expect(result.corrections[0]!.provenance.dropped).toEqual(["unit-1-0"]);
    expect(result.corrections[1]!.overrides).toEqual([
      { id: "req-1-0", normalized_requirement: `${savedItems(1, { dropReqs: 2 }).requirements[0]!.normalized_requirement} (corrected)` },
    ]);
    expect(outcome.stdout).toContain("## Corrected items");
    expect(outcome.stdout).toContain(`sha256 ${sha256File(file)}`);
    expect(result.flows[0]!.unitCount).toBe(savedItems(1).units.length);
  });

  it("refuses an unlisted file with its hash, and two sides from different flows", async () => {
    const file = correctionsFile("c.json", 1, savedItems(1, { dropReqs: 2 }));
    const unlisted = await runFixedInputs(parseFixedInputArgs(argv("--units", file)), deps({ manifestPath: manifest() }));
    expect(unlisted.code).toBe(1);
    expect(unlisted.stderr).toContain(`sha256 ${sha256File(file)} is not listed`);
    const other = correctionsFile("d.json", 0, savedItems(0, { dropUnits: 2 }));
    const mixed = await runFixedInputs(
      parseFixedInputArgs(argv("--units", file, "--requirements", other)),
      deps({ manifestPath: manifest(file, other) }),
    );
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toMatch(/both sides must correct the same flow/);
  });
});
