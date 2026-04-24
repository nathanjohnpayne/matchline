#!/usr/bin/env node
/**
 * Postbuild for functions: copy every `src/**\/*.md` to the matching
 * location under `lib/`. The prompt loader reads .md files via
 * `import.meta.url`-relative paths; in production the loader lives
 * in lib/prompts/loader.js and expects the .md next to it. tsc
 * doesn't copy non-TS files, so this script bridges that gap.
 */

import { readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const functionsRoot = join(here, "..");
const srcDir = join(functionsRoot, "src");
const libDir = join(functionsRoot, "lib");

let copied = 0;

function walk(src, dest) {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      walk(srcPath, destPath);
    } else if (entry.name.endsWith(".md")) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      copied += 1;
    }
  }
}

try {
  walk(srcDir, libDir);
  console.log(`copy-md: copied ${copied} markdown file(s) from src/ to lib/`);
} catch (err) {
  if (err && err.code === "ENOENT") {
    // No src/ yet, or lib/ doesn't exist — nothing to do. tsc will
    // fail earlier if src/ is truly missing.
    console.log("copy-md: nothing to copy (src or lib not present yet)");
    process.exit(0);
  }
  throw err;
}
