/**
 * Private fit-brief corpus loader (#495 Phase 3).
 *
 * The corpus is the owner's real job descriptions and approved fit
 * briefs. It lives in a private repository; this repository is public.
 * Two rules follow, and this module enforces both before anything else
 * runs:
 *
 * 1. The corpus is read only from a directory outside this repository,
 *    named by `MATCHLINE_PRIVATE_CORPUS`. Nothing from it is committed.
 * 2. Everything the harness writes (generated briefs, judge output,
 *    per-pair scores) goes outside this repository too.
 *
 * The corpus directory holds a manifest, `matchline-fit-brief-manifest.json`:
 *
 * ```json
 * {
 *   "resume": "path/to/canonical-resume.md",
 *   "inventory": "path/to/skills-inventory.md",
 *   "claimRules": "path/to/claim-rules.md",
 *   "pairs": [
 *     { "id": "role-a", "jd": "role-a/jd.md", "reference": "role-a/fit-brief.md", "split": "dev" }
 *   ]
 * }
 * ```
 *
 * Paths are relative to the corpus directory and may not leave it.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

export const MANIFEST_FILENAME = "matchline-fit-brief-manifest.json";

const relPath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p), "must be relative to the corpus directory");

const ManifestSchema = z
  .object({
    resume: relPath,
    inventory: relPath.optional(),
    claimRules: relPath.optional(),
    pairs: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9._-]+$/, "id must be [A-Za-z0-9._-]"),
            jd: relPath,
            reference: relPath,
            split: z.enum(["dev", "test"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((m) => new Set(m.pairs.map((p) => p.id)).size === m.pairs.length, {
    message: "pair ids must be unique",
  });

export type FitBriefManifest = z.infer<typeof ManifestSchema>;
export type Split = "dev" | "test";

export interface CorpusPair {
  readonly id: string;
  readonly split: Split;
  readonly jdText: string;
  readonly referenceText: string;
}

export interface FitBriefCorpus {
  readonly resumeText: string;
  readonly inventoryText?: string;
  readonly claimRulesText?: string;
  readonly pairs: readonly CorpusPair[];
}

/**
 * True when `rel` (from path.relative) stays at or below its base. Checks
 * the first segment, so `..cache` is inside and `../x` is not (CodeRabbit
 * on #581: a bare `startsWith("..")` treated `<repo>/..out` as outside).
 */
function isWithin(rel: string): boolean {
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Case-fold on the platforms whose default file systems are
 * case-insensitive, so `~/code/MatchLine` cannot pass for a path outside
 * `~/code/matchline` (CodeRabbit on #581).
 */
function comparable(path: string): string {
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/** This repository's root, derived from this file's location. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Symbolic links one path may pass through before it is refused as a loop (Linux's MAXSYMLINKS). */
export const MAX_SYMLINKS = 40;

/**
 * The real path `path` reaches, or would reach once created. The path is
 * walked one component at a time, as the kernel does: symlinks are
 * followed, including a dangling one, whose target (read with readlink,
 * relative to the link's own directory) is the file a write through it
 * would create. So a link outside the repository to a file not yet made
 * inside it resolves inside (#657). The rest of the path after its first
 * missing component is appended as named, as a recursive mkdir would
 * create it. Throws on a symlink loop (more than MAX_SYMLINKS links).
 */
export function eventualRealpath(path: string): string {
  const start = resolve(path);
  let dir = parse(start).root;
  let pending = components(start.slice(dir.length));
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name === "..") {
      // Every component of `dir` is a real directory, so its lexical parent is its real parent.
      dir = dirname(dir);
      continue;
    }
    const next = join(dir, name);
    const stat = lstatOrMissing(next);
    if (stat === undefined) {
      if (!pending.includes("..")) return join(realpathSync.native(dir), name, ...pending);
      // A `..` below a missing directory steps back out of a directory a
      // write would create first; drop the pair and keep walking.
      pending = components(join(name, ...pending));
      continue;
    }
    if (!stat.isSymbolicLink()) {
      dir = next;
      continue;
    }
    links += 1;
    if (links > MAX_SYMLINKS) {
      throw new Error(`symlink loop: more than ${MAX_SYMLINKS} symbolic links followed resolving ${path} (at ${next})`);
    }
    // A relative target resolves against the link's directory, `dir`; an absolute one restarts at its root.
    const target = readlinkSync(next);
    const targetRoot = isAbsolute(target) ? parse(target).root : "";
    if (targetRoot !== "") dir = targetRoot;
    pending = [...components(target.slice(targetRoot.length)), ...pending];
  }
  // `.native` returns the on-disk letter case where the platform has one.
  return realpathSync.native(dir);
}

/** The non-empty, non-`.` components of a relative path. */
function components(rel: string): string[] {
  return rel.split(sep === "/" ? "/" : /[\\/]/u).filter((c) => c !== "" && c !== ".");
}

/** `lstat`, or undefined when nothing is there (a missing entry, or a parent that is not a directory). */
function lstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/**
 * Throw when `path` resolves inside the repository. Symlinks are
 * resolved first (`eventualRealpath`), so a link from outside into the
 * repo is refused too, dangling or not. A path that cannot be resolved
 * (a symlink loop) is refused.
 */
export function assertOutsideRepo(path: string, label: string, root: string = repoRoot()): void {
  let target: string;
  try {
    target = eventualRealpath(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${label} ${path}: cannot confirm it is outside this repository (${reason}). ` +
        `Refusing rather than risk writing into the repository.`,
    );
  }
  const rootReal = realpathSync.native(root);
  if (isWithin(relative(comparable(rootReal), comparable(target)))) {
    throw new Error(
      `${label} resolves inside this repository (${target}). This repository is public; ` +
        `the fit-brief corpus and everything generated from it must stay outside it.`,
    );
  }
}

function readInside(dir: string, rel: string, label: string): string {
  const full = resolve(dir, rel);
  // Both paths exist and are resolved to their on-disk case, so compare
  // them as-is: case-folding here could accept a sibling directory on a
  // case-sensitive volume (CodeRabbit on #581). The folded comparison is
  // kept only in assertOutsideRepo, for output paths that may not exist.
  const relToDir = relative(realpathSync.native(dir), eventualRealpath(full));
  if (!isWithin(relToDir)) {
    throw new Error(`${label} (${rel}) points outside the corpus directory.`);
  }
  if (!existsSync(full)) throw new Error(`${label} not found: ${rel}`);
  const text = readFileSync(full, "utf8");
  // A blank file would let a paid run score against nothing, for example an
  // empty reference brief yielding null recall on a "successful" sample
  // (Codex P2, #581).
  if (text.trim() === "") throw new Error(`${label} is empty: ${rel}`);
  return text;
}

/** Load and validate the corpus. Refuses a corpus directory inside the repository. */
export function loadCorpus(dir: string, root: string = repoRoot()): FitBriefCorpus {
  assertOutsideRepo(dir, "MATCHLINE_PRIVATE_CORPUS", root);
  const manifestPath = join(dir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`No ${MANIFEST_FILENAME} in the corpus directory.`);
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid ${MANIFEST_FILENAME}: ${parsed.error.message}`);
  }
  const m = parsed.data;
  return {
    resumeText: readInside(dir, m.resume, "resume"),
    ...(m.inventory !== undefined && { inventoryText: readInside(dir, m.inventory, "inventory") }),
    ...(m.claimRules !== undefined && {
      claimRulesText: readInside(dir, m.claimRules, "claimRules"),
    }),
    pairs: m.pairs.map((p) => ({
      id: p.id,
      split: p.split,
      jdText: readInside(dir, p.jd, `pair ${p.id} jd`),
      referenceText: readInside(dir, p.reference, `pair ${p.id} reference`),
    })),
  };
}
