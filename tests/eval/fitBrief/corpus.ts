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

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** This repository's root, derived from this file's location. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Resolve symlinks for `path`, or for its nearest existing ancestor when
 * it does not exist yet (an output directory about to be created).
 */
function realpathOrAncestor(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

/**
 * Throw when `path` resolves inside the repository. Symlinks are
 * resolved first, so a link from outside into the repo is refused too.
 */
export function assertOutsideRepo(path: string, label: string, root: string = repoRoot()): void {
  const target = realpathOrAncestor(path);
  const rootReal = realpathSync(root);
  const rel = relative(rootReal, target);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
    throw new Error(
      `${label} resolves inside this repository (${target}). This repository is public; ` +
        `the fit-brief corpus and everything generated from it must stay outside it.`,
    );
  }
}

function readInside(dir: string, rel: string, label: string): string {
  const full = resolve(dir, rel);
  const relToDir = relative(realpathSync(dir), realpathOrAncestor(full));
  if (relToDir.startsWith("..") || isAbsolute(relToDir)) {
    throw new Error(`${label} (${rel}) points outside the corpus directory.`);
  }
  if (!existsSync(full)) throw new Error(`${label} not found: ${rel}`);
  return readFileSync(full, "utf8");
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
