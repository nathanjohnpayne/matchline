import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertOutsideRepo, loadCorpus, MANIFEST_FILENAME, repoRoot } from "./corpus.ts";

// Synthetic corpus only. Nothing here comes from a real job search.
let dir: string;

function write(rel: string, text: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

function manifest(m: unknown): void {
  write(MANIFEST_FILENAME, JSON.stringify(m));
}

const GOOD = {
  resume: "resume.md",
  claimRules: "rules.md",
  pairs: [
    { id: "role-a", jd: "a/jd.md", reference: "a/brief.md", split: "dev" },
    { id: "role-b", jd: "b/jd.md", reference: "b/brief.md", split: "test" },
  ],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fit-brief-corpus-"));
  write("resume.md", "- Owned the checkout API.");
  write("rules.md", "Never claim PCI certification.");
  write("a/jd.md", "JD A");
  write("a/brief.md", "Brief A");
  write("b/jd.md", "JD B");
  write("b/brief.md", "Brief B");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadCorpus", () => {
  it("loads the résumé, claim rules and pairs from a directory outside the repo", () => {
    manifest(GOOD);
    const corpus = loadCorpus(dir);
    expect(corpus.resumeText).toContain("checkout API");
    expect(corpus.claimRulesText).toContain("PCI");
    expect(corpus.inventoryText).toBeUndefined();
    expect(corpus.pairs.map((p) => [p.id, p.split, p.jdText])).toEqual([
      ["role-a", "dev", "JD A"],
      ["role-b", "test", "JD B"],
    ]);
  });

  it("refuses a corpus directory inside the repository", () => {
    expect(() => loadCorpus(join(repoRoot(), "tests"))).toThrow(/inside this repository/);
  });

  it("refuses a corpus reached through a symlink into the repository", () => {
    const link = join(dir, "link-into-repo");
    symlinkSync(join(repoRoot(), "tests"), link);
    expect(() => loadCorpus(link)).toThrow(/inside this repository/);
  });

  it("refuses manifest paths that leave the corpus directory", () => {
    manifest({ ...GOOD, resume: "../outside.md" });
    expect(() => loadCorpus(dir)).toThrow(/outside the corpus directory/);
  });

  it("refuses absolute manifest paths", () => {
    manifest({ ...GOOD, resume: "/etc/hosts" });
    expect(() => loadCorpus(dir)).toThrow(/relative to the corpus directory/);
  });

  it("refuses duplicate pair ids and unknown splits", () => {
    manifest({ ...GOOD, pairs: [GOOD.pairs[0], GOOD.pairs[0]] });
    expect(() => loadCorpus(dir)).toThrow(/unique/);
    manifest({ ...GOOD, pairs: [{ ...GOOD.pairs[0], split: "train" }] });
    expect(() => loadCorpus(dir)).toThrow(/Invalid/);
  });

  it("accepts a corpus file whose name starts with '..' (it is inside the corpus)", () => {
    write("..notes.md", "Never claim PCI certification.");
    manifest({ ...GOOD, claimRules: "..notes.md" });
    expect(loadCorpus(dir).claimRulesText).toContain("PCI");
  });

  it("reports a missing file by its manifest label", () => {
    manifest({ ...GOOD, pairs: [{ ...GOOD.pairs[0], jd: "a/missing.md" }] });
    expect(() => loadCorpus(dir)).toThrow(/pair role-a jd not found/);
  });

  it("refuses a blank reference brief, JD or résumé before any paid call (Codex P2, #581)", () => {
    write("b/brief.md", "  \n\t\n");
    manifest(GOOD);
    expect(() => loadCorpus(dir)).toThrow(/pair role-b reference is empty/);
  });

  it("requires a manifest", () => {
    expect(() => loadCorpus(dir)).toThrow(/No matchline-fit-brief-manifest.json/);
  });
});

describe("assertOutsideRepo", () => {
  it("accepts an output directory that does not exist yet, outside the repo", () => {
    expect(() => assertOutsideRepo(join(dir, "out", "run-1"), "--out")).not.toThrow();
  });

  it("refuses a path inside the repo whose first segment merely starts with '..' (CodeRabbit, #581)", () => {
    expect(() => assertOutsideRepo(join(repoRoot(), "..fit-brief-out", "run-1"), "--out")).toThrow(
      /inside this repository/,
    );
  });

  it.runIf(process.platform === "darwin")(
    "refuses a repo path that differs only in letter case on a case-insensitive volume (CodeRabbit, #581)",
    () => {
      const root = repoRoot();
      const variant = root.toUpperCase();
      expect(variant).not.toBe(root);
      expect(() => assertOutsideRepo(join(variant, "out"), "--out", root)).toThrow(/inside this repository/);
    },
  );

  it("refuses an output directory inside the repo, even one that does not exist yet", () => {
    expect(() => assertOutsideRepo(join(repoRoot(), "tests", "eval", ".private-out"), "--out")).toThrow(
      /--out resolves inside this repository/,
    );
  });
});
