#!/usr/bin/env node
/**
 * Postbuild for functions: copy every `src/**\/*.md` to the matching
 * location under `lib/`. The prompt loader reads .md files via
 * `import.meta.url`-relative paths; in production the loader lives
 * in lib/prompts/loader.js and expects the .md next to it. tsc
 * doesn't copy non-TS files, so this script bridges that gap.
 */

import { readdirSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const functionsRoot = join(here, "..");
const srcDir = join(functionsRoot, "src");
const libDir = join(functionsRoot, "lib");

let deleted = 0;
let copied = 0;

/**
 * Walk `dir` and run `onFile` for every file. Swallows ENOENT on
 * the top call so a missing `dir` is a no-op (incremental first
 * builds don't have lib/ yet).
 */
function forEachFile(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) forEachFile(fullPath, onFile);
    else onFile(fullPath, entry.name);
  }
}

// Pre-clean: remove every *.md from lib/ so a deleted-in-src prompt
// does NOT linger as a stale deployable (Codex P2 on #49). copy
// step below then re-mirrors src/'s current .md set authoritatively.
forEachFile(libDir, (fullPath, name) => {
  if (name.endsWith(".md")) {
    unlinkSync(fullPath);
    deleted += 1;
  }
});

// Copy current src/**/*.md into matching lib/ paths.
forEachFile(srcDir, (fullPath, name) => {
  if (name.endsWith(".md")) {
    const rel = fullPath.slice(srcDir.length);
    const dest = join(libDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(fullPath, dest);
    copied += 1;
  }
});

console.log(
  `copy-md: removed ${deleted} stale .md from lib/, copied ${copied} current .md from src/ → lib/`,
);
