/** Shared CLI plumbing for build-deck and import-labels. */

import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PACKET = join(homedir(), ".matchline", "eval-analysis", "calibration-2a");

/** Sheets in the packet are every `*.md` except these. KEY.json is never read. */
export const NOT_SHEETS = new Set(["README.md", "SUMMARY.md"]);

/** The nearest enclosing git work tree of `path`, or null. */
export function gitRoot(path: string): string | null {
  // Follow symlinks: resolve the deepest existing ancestor to its real path,
  // so a link that points into a repository is caught.
  let dir = resolve(path);
  let rest = "";
  while (!existsSync(dir) && dirname(dir) !== dir) {
    rest = join(basename(dir), rest);
    dir = dirname(dir);
  }
  dir = resolve(realpathSync(dir), rest);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Private output must never land in a repository (the matchline repo is public). */
export function assertOutsideRepo(path: string): void {
  const root = gitRoot(path);
  if (root) throw new Error(`refusing to write private output inside the git work tree ${root}: ${path}`);
}

/** Write via a temp file and rename, owner-only permissions. */
export function writePrivate(path: string, content: string): void {
  assertOutsideRepo(path);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function parseArgs(argv: string[], booleans: string[] = []): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (booleans.includes(name)) flags.set(name, true);
    else if (inline !== undefined) {
      if (inline === "") throw new Error(`--${name} needs a value`);
      flags.set(name, inline);
    }
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags.set(name, argv[++i]);
    else throw new Error(`--${name} needs a value`);
  }
  return { flags, positional };
}

export const isMain = (metaUrl: string) => process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(metaUrl);
