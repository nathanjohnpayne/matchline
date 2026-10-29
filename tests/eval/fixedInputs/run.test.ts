import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseFixedInputArgs } from "./args.ts";
import { CORRECTIONS_MANIFEST_PATH, MANIFEST_NOT_COMMITTED, sha256File, type GitRunner } from "./corrections.ts";
import { DIAGNOSTIC_BANNER, GOLD_DEFINITION } from "./report.ts";
import { REPEATED_REPLAY_REASON, repeatedReplays, REPORT_FILE, RESULT_FILE, runFixedInputs, type FixedInputsDeps } from "./run.ts";
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

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A fake git: `rev-parse HEAD` answers `head` (or fails on null), `git diff --quiet` exits `diffStatus`. */
function fakeGit(diffStatus = 0, head: string | null = HEAD_SHA): GitRunner & ReturnType<typeof vi.fn> {
  return vi.fn((args: readonly string[]) => {
    if (args[0] === "rev-parse") return head === null ? { status: 128, stdout: "" } : { status: 0, stdout: `${head}\n` };
    if (args[0] === "diff") return { status: diffStatus, stdout: "" };
    throw new Error(`unexpected git ${args.join(" ")}`);
  }) as unknown as GitRunner & ReturnType<typeof vi.fn>;
}

function deps(extra: Partial<FixedInputsDeps> = {}): FixedInputsDeps {
  return { root, openaiClient: factory as unknown as () => typeof client, env: {}, git: fakeGit(), ...extra };
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
    // Provenance: the worktree HEAD, and no manifest pin without corrections.
    expect(result.head).toBe(HEAD_SHA);
    expect(result.manifest).toBeNull();
    expect(md).toContain(`- Worktree HEAD: ${HEAD_SHA}.`);
    const written = JSON.parse(readFileSync(join(out, RESULT_FILE), "utf8")) as Record<string, unknown>;
    expect(written.flows).toHaveLength(3);
    expect(written.head).toBe(HEAD_SHA);
    expect(written.manifest).toBeNull();
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

  it("refuses on the byte-length bound when the chars/4 estimate would fit", async () => {
    const dry = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--dry-run")), deps());
    const { estimatedUsd, boundUsd } = (() => {
      const m = /~\d+ tokens, \$([0-9.]+); the guard checks the UTF-8 byte-length bound, \d+ tokens, \$([0-9.]+)/u.exec(dry.stdout)!;
      return { estimatedUsd: Number(m[1]), boundUsd: Number(m[2]) };
    })();
    expect(boundUsd).toBeGreaterThan(estimatedUsd);
    const maxUsd = ((estimatedUsd + boundUsd) / 2).toPrecision(6);
    const between = await runFixedInputs(parseFixedInputArgs(argv("--units", "gold", "--max-usd", maxUsd)), deps());
    expect(between.code).toBe(1);
    expect(between.stderr).toMatch(/bounded at \$[0-9.]+ \(\d+ UTF-8 bytes as tokens; estimate \$[0-9.]+\), above --max-usd/);
    expect(factory).not.toHaveBeenCalled();
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

    // The mismatched flow is listed by arm, cell and sample, with both accuracies and the difference
    // (and its match count, which differs too: it saved other inputs than sample 0).
    expect(count).not.toBe(second.result!.flows.find((f) => f.sampleIndex === 1)!.conditions["record/record"]!.current!.matchCount);
    const rerun = second.result!.flows.find((f) => f.sampleIndex === 1)!.conditions["record/record"]!.current!;
    expect(second.result!.reproductionMismatches).toEqual([
      {
        arm: "arm-a",
        invocationId: "inv-c",
        cell: CELL,
        sampleIndex: 1,
        recordedAccuracy: acc + 0.5,
        rerunAccuracy: rerun.accuracy,
        difference: rerun.accuracy - (acc + 0.5),
        recordedMatchCount: count,
        rerunMatchCount: rerun.matchCount,
      },
    ]);
    const pct = (v: number): string => (100 * v).toFixed(1);
    expect(second.stdout).toContain("### Mismatched flows (1)");
    expect(second.stdout).toContain(
      `| arm-a | ${CELL} | 1 | ${pct(acc + 0.5)} | ${pct(rerun.accuracy)} | ${pct(rerun.accuracy - (acc + 0.5))} | ${count} | ${rerun.matchCount} |`,
    );
    expect(second.stderr).toContain(
      `warning: record/record under the current scorer does not reproduce 1 of 2 recorded flow(s): arm-a ${CELL} #1 (recorded ${pct(acc + 0.5)}, rerun ${pct(rerun.accuracy)}, ${pct(rerun.accuracy - (acc + 0.5))}, ` +
        `match count ${count} vs ${rerun.matchCount}). The run still exits 0`,
    );
    // A reproduction mismatch is a warning, not a failure.
    expect(second.code).toBe(0);

    // A run that reproduces every flow says so and warns about nothing.
    const clean = writeFlows(join(base, "records-d"), [
      flowFor("arm-a", "inv-d", 0, savedItems(0, { dropUnits: 2 }), { matchAccuracy: acc, matchCount: count }),
    ]);
    const third = await runFixedInputs(parseFixedInputArgs(["--records", clean, "--embeddings-cache", cachePath]), deps());
    expect(third.result!.reproductionMismatches).toEqual([]);
    expect(third.stdout).toContain("Every flow with a recorded accuracy reproduces its accuracy and match count.");
    expect(third.stderr).not.toMatch(/does not reproduce/);
  });

  it("skips repeated cache replays by the eval:analyze rule", async () => {
    const replay = (f: ReturnType<typeof flowFor>, hits: Record<string, boolean>): ReturnType<typeof flowFor> => ({
      ...f,
      stepCacheHits: hits,
    });
    const both = { extraction: true, requirement_parsing: true };
    const live = flowFor("arm-r", "inv-r", 0, savedItems(0));
    const copyOfLive = replay(flowFor("arm-r", "inv-r", 1, savedItems(0)), both);
    const newReplay = replay(flowFor("arm-r", "inv-r", 2, savedItems(3)), both);
    const copyOfReplay = replay(flowFor("arm-r", "inv-r", 3, savedItems(3)), both);
    const halfReplay = replay(flowFor("arm-r", "inv-r", 4, savedItems(0)), { extraction: true, requirement_parsing: false });
    const otherArm = replay(flowFor("arm-s", "inv-s", 0, savedItems(0)), both);
    const flows = [copyOfLive, live, newReplay, copyOfReplay, halfReplay, otherArm];
    expect([...repeatedReplays(flows)]).toEqual([copyOfLive, copyOfReplay]);

    const dir = writeFlows(join(base, "records-replays"), flows);
    const outcome = await runFixedInputs(parseFixedInputArgs(["--records", dir, "--embeddings-cache", cachePath]), deps());
    expect(outcome.code).toBe(0);
    expect(outcome.result!.flows.map((f) => `${f.arm}#${f.sampleIndex}`)).toEqual(["arm-r#0", "arm-r#2", "arm-r#4", "arm-s#0"]);
    expect(outcome.result!.skipped).toEqual([{ reason: REPEATED_REPLAY_REASON, flows: [`arm-r ${CELL} #1`, `arm-r ${CELL} #3`] }]);
    expect(outcome.stdout).toContain(`Skipped 2 flow(s): ${REPEATED_REPLAY_REASON}`);
  });

  it("reports recall@k when --k is given", async () => {
    const outcome = await runFixedInputs(parseFixedInputArgs(argv("--k", "500")), deps());
    expect(outcome.result!.metric).toBe("recall@500");
    expect(outcome.result!.reproductionMismatches).toBeNull();
    for (const f of outcome.result!.flows) {
      const d = f.conditions["record/record"]!.current!.decomposition;
      expect(d.C).toBe(0); // every mapped pair is inside a 500-wide window
    }
    expect(outcome.stdout).not.toContain("## Reproduces the record");
  });
});

describe("runFixedInputs with owner corrections", () => {
  function correctionsFile(name: string, sample: number, items: ReturnType<typeof savedItems>, opts: { add?: boolean } = {}): string {
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
    if (opts.add) body.units.push({ owner_verdict: "add", raw_text: "A missed fact.", normalized_summary: "A missed fact about launches", skills: ["launch"] } as never);
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
    const file = correctionsFile("c.json", 1, savedItems(1, { dropReqs: 2 }), { add: true });
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
    expect(result.corrections[0]!.provenance.added).toEqual([
      expect.objectContaining({ id: "added_1", confidence_score: 0.9, confidence_from: "source median", date_range: null, seniority_signals: [] }),
    ]);
    expect(outcome.stdout).toContain(
      'added_1 "A missed fact about launches" (confidence_score 0.9 from source median; date_range none; seniority_signals none)',
    );
    // One saved Unit dropped, one added.
    expect(result.flows[0]!.unitCount).toBe(savedItems(1).units.length);
  });

  it("tags fixes the matcher never reads and warns when a side changes only those", async () => {
    const items = savedItems(1, { dropReqs: 2 });
    const body = {
      resumeId: RESUME,
      jdId: JD,
      units: items.units.map((u, i) => ({
        ...u,
        owner_verdict: i === 0 ? "fix" : "keep",
        owner_corrected_raw_text: i === 0 ? "Owner-corrected raw text only." : null,
      })),
      requirements: items.requirements.map((q, i) => ({
        ...q,
        owner_verdict: i === 0 ? "fix" : "keep",
        owner_corrected_text: null,
        owner_must_have: i === 0 ? !q.must_have : q.must_have,
      })),
    };
    const file = join(base, "ignored.json");
    writeFileSync(file, JSON.stringify(body, null, 2));
    const outcome = await runFixedInputs(
      parseFixedInputArgs(argv("--units", file, "--requirements", file)),
      deps({ manifestPath: manifest(file) }),
    );
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("unit-1-0 [raw_text (no effect on matching)]");
    expect(outcome.stdout).toContain("req-1-0 [must_have (no effect on matching)]");
    expect(outcome.stdout).toMatch(/Override req-1-0: must_have (true|false) \(no effect on matching\)/);
    expect(outcome.stdout).toContain("the matcher sees the record side's inputs");
    expect(outcome.stderr).toMatch(/warning: .*ignored\.json: every units fix changes only fields the matcher does not read/);
    expect(outcome.stderr).toMatch(/warning: .*ignored\.json: every requirements fix changes only fields/);
    // The corrected sides are the record inputs as far as the matcher can tell.
    const c = outcome.result!.flows[0]!.conditions;
    expect(c["corrected/corrected"]!.current!.accuracy).toBe(c["record/record"]!.current!.accuracy);
  });

  it("records HEAD and whether the manifest is committed; an uncommitted manifest warns and is marked, not refused", async () => {
    const file = correctionsFile("c.json", 1, savedItems(1, { dropReqs: 2 }));
    const manifestPath = manifest(file);
    const committedGit = fakeGit(0);
    const committed = await runFixedInputs(parseFixedInputArgs(argv("--units", file)), deps({ manifestPath, git: committedGit }));
    expect(committed.code).toBe(0);
    expect(committedGit.mock.calls).toEqual([
      [["rev-parse", "HEAD"], dirname(manifestPath)],
      [["diff", "--quiet", "HEAD", "--", manifestPath], dirname(manifestPath)],
    ]);
    expect(committed.result!.head).toBe(HEAD_SHA);
    expect(committed.result!.manifest).toEqual({ path: manifestPath, head: HEAD_SHA, differsFromHead: false, status: "committed at HEAD" });
    expect(committed.result!.corrections[0]!.manifestStatus).toBe("committed at HEAD");
    expect(committed.stdout).toContain(`- Corrections manifest ${manifestPath}: committed at HEAD.`);
    expect(committed.stdout).not.toContain(MANIFEST_NOT_COMMITTED);
    expect(committed.stderr).not.toMatch(/warning: .*manifest/);

    const out = join(base, "out-dirty");
    const dirty = await runFixedInputs(parseFixedInputArgs(argv("--units", file, "--out", out)), deps({ manifestPath, git: fakeGit(1) }));
    expect(dirty.code).toBe(0);
    expect(dirty.result!.manifest).toEqual({ path: manifestPath, head: HEAD_SHA, differsFromHead: true, status: MANIFEST_NOT_COMMITTED });
    expect(dirty.result!.corrections[0]!.manifestStatus).toBe(MANIFEST_NOT_COMMITTED);
    expect(dirty.stderr).toContain(`warning: ${manifestPath} differs from HEAD ${HEAD_SHA} (manifest not committed)`);
    expect(dirty.stdout).toContain(`- Corrections manifest ${manifestPath}: **manifest not committed**.`);
    expect(dirty.stdout).toContain(`(${file}); manifest not committed.`);
    expect(dirty.stdout).toContain("- Manifest: manifest not committed.");
    const written = JSON.parse(readFileSync(join(out, RESULT_FILE), "utf8")) as {
      head: string;
      manifest: { status: string; differsFromHead: boolean };
      corrections: { manifestStatus: string }[];
    };
    expect(written.head).toBe(HEAD_SHA);
    expect(written.manifest).toMatchObject({ status: MANIFEST_NOT_COMMITTED, differsFromHead: true });
    expect(written.corrections[0]!.manifestStatus).toBe(MANIFEST_NOT_COMMITTED);

    // No git answer: the status is unknown, warned, and diff is not attempted without a HEAD.
    const noGit = fakeGit(0, null);
    const unknown = await runFixedInputs(parseFixedInputArgs(argv("--units", file)), deps({ manifestPath, git: noGit }));
    expect(unknown.code).toBe(0);
    expect(unknown.result!.head).toBeNull();
    expect(unknown.result!.manifest).toMatchObject({ differsFromHead: null, status: "commit status unknown" });
    expect(unknown.stderr).toMatch(/warning: could not tell whether .* is committed at HEAD/);
    expect(noGit.mock.calls.map(([a]) => (a as string[])[0])).toEqual(["rev-parse"]);
  });

  it("asks git about the in-repo manifest by default", async () => {
    const git = fakeGit();
    await runFixedInputs(parseFixedInputArgs(argv("--dry-run")), deps({ git }));
    expect(git.mock.calls).toEqual([[["rev-parse", "HEAD"], dirname(CORRECTIONS_MANIFEST_PATH)]]);
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
