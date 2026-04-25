#!/usr/bin/env node
/**
 * Postbuild for functions: copy every non-TS asset from
 * `src/**` to the matching location under `lib/`. tsc doesn't
 * copy non-TS files, so this script bridges that gap.
 *
 * Two file types today:
 *   - **`.md`** prompt files. The prompt loader reads them via
 *     `import.meta.url`-relative paths; in production the loader
 *     lives in lib/prompts/loader.js and expects the .md next to
 *     it.
 *   - **`.seed.json`** ontology files (#96). The matching engine's
 *     `normalize()` reads them via the same `import.meta.url`
 *     pattern; same deployable-bundle requirement.
 *
 * Both file types are pre-cleaned from lib/ before the copy so a
 * deleted-in-src asset doesn't linger as a stale deployable
 * (Codex P2 on #49 motivated the pre-clean for .md; same logic
 * applies to .seed.json).
 */

const ASSET_SUFFIXES = [".md", ".seed.json"];

function isAsset(name) {
  for (const suffix of ASSET_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

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

// Pre-clean: remove every recognized asset from lib/ so a
// deleted-in-src file does NOT linger as a stale deployable
// (Codex P2 on #49). Copy step below re-mirrors src/'s current
// asset set authoritatively.
forEachFile(libDir, (fullPath, name) => {
  if (isAsset(name)) {
    unlinkSync(fullPath);
    deleted += 1;
  }
});

// Copy current src/** assets into matching lib/ paths.
forEachFile(srcDir, (fullPath, name) => {
  if (isAsset(name)) {
    const rel = fullPath.slice(srcDir.length);
    const dest = join(libDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(fullPath, dest);
    copied += 1;
  }
});

console.log(
  `copy-md: removed ${deleted} stale asset(s) from lib/, copied ${copied} current asset(s) from src/ → lib/`,
);
