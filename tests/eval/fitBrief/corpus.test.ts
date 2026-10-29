import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { symlinksSupported } from "../fixedInputs/testSupport.ts";

import { assertOutsideRepo, eventualRealpath, loadCorpus, MANIFEST_FILENAME, MAX_SYMLINKS, repoRoot } from "./corpus.ts";

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

// Skipped where the platform cannot make symlinks.
describe.runIf(symlinksSupported())("eventualRealpath (#657)", () => {
  it("is the real path of an existing path, with a missing tail appended as named", () => {
    const real = realpathSync.native(dir);
    expect(eventualRealpath(join(dir, "a", "jd.md"))).toBe(join(real, "a", "jd.md"));
    expect(eventualRealpath(join(dir, "new", "run-1"))).toBe(join(real, "new", "run-1"));
    expect(eventualRealpath(dir)).toBe(real);
  });

  it("follows a dangling symlink to the file a write through it would create, relative to the link's directory", () => {
    const real = realpathSync.native(dir);
    symlinkSync(join("..", "elsewhere", "out.jsonl"), join(dir, "a", "link"));
    expect(eventualRealpath(join(dir, "a", "link"))).toBe(join(real, "elsewhere", "out.jsonl"));
    expect(eventualRealpath(join(dir, "a", "link", "sub"))).toBe(join(real, "elsewhere", "out.jsonl", "sub"));
  });

  it("resolves `..` in a link target after a symlinked directory physically, not lexically", () => {
    const real = realpathSync.native(dir);
    mkdirSync(join(dir, "deep", "inner"), { recursive: true });
    symlinkSync(join("deep", "inner"), join(dir, "shortcut"));
    // shortcut/.. is deep (the parent of the link's target), not dir. The
    // targets are joined by hand: path.join would collapse the `..`.
    symlinkSync(["shortcut", "..", "x.jsonl"].join(sep), join(dir, "link"));
    expect(eventualRealpath(join(dir, "link"))).toBe(join(real, "deep", "x.jsonl"));
    // A `..` below a missing directory steps back out of it.
    symlinkSync(["missing", "..", "a", "new.md"].join(sep), join(dir, "back-out"));
    expect(eventualRealpath(join(dir, "back-out"))).toBe(join(real, "a", "new.md"));
  });

  it("refuses a symlink loop, a self-loop included", () => {
    symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
    symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
    symlinkSync("self", join(dir, "self"));
    expect(() => eventualRealpath(join(dir, "loop-a"))).toThrow(
      new RegExp(`symlink loop: more than ${MAX_SYMLINKS} symbolic links followed resolving`),
    );
    expect(() => eventualRealpath(join(dir, "self", "out"))).toThrow(/symlink loop/);
  });

  it("assertOutsideRepo refuses a dangling symlink into the repository and accepts one that points outside it", () => {
    const inside = join(repoRoot(), "tests", "eval", ".dangling-should-not-exist", "units.json");
    symlinkSync(inside, join(dir, "into-repo"));
    expect(() => assertOutsideRepo(join(dir, "into-repo"), "--units-from")).toThrow(/--units-from resolves inside this repository/);
    expect(() => assertOutsideRepo(join(dir, "into-repo"), "--out")).toThrow(/--out resolves inside this repository/);
    expect(existsSync(join(repoRoot(), "tests", "eval", ".dangling-should-not-exist"))).toBe(false);
    symlinkSync(join(dir, "elsewhere", "out"), join(dir, "outside"));
    expect(() => assertOutsideRepo(join(dir, "outside"), "--out")).not.toThrow();
    symlinkSync("loop", join(dir, "loop"));
    expect(() => assertOutsideRepo(join(dir, "loop"), "--out")).toThrow(
      /--out .*loop: cannot confirm it is outside this repository \(symlink loop/,
    );
  });
});
