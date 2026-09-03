import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Build identity for the update-reload prompt (#429).
 *
 * A timestamp rather than a git SHA: the deploy that matters is the one
 * that produced *these bytes*, and a rebuild of an unchanged tree is
 * still a new deploy a stale tab should notice. It also keeps the build
 * working outside a git checkout.
 */
const BUILD_ID = new Date().toISOString();

/**
 * Emit `dist/version.json` so a long-lived tab can poll for a newer
 * deploy. Static files in `dist/` are matched ahead of the
 * `**` → `/index.html` rewrite in `firebase.json`, so this is served as
 * itself — see `parseVersionPayload` in `src/lib/appVersion.ts` for
 * what happens if it ever stops being emitted.
 */
function emitVersionFile(): Plugin {
  // Captured from the resolved config rather than hardcoded: `dist` is
  // only the default, and `vite build --outDir <dir>` (or a config
  // override) moves the bundle without moving this file. Codex verified
  // on PR #434 that the literal path wrote version.json to `dist/` while
  // the bundle went elsewhere — silently where `dist/` happened to
  // exist, and ENOENT on a clean checkout.
  let outDir = "dist";
  let root = process.cwd();

  return {
    name: "matchline-version-file",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },
    // `closeBundle` rather than `generateBundle`: writing through
    // `emitFile` would put version.json under Rollup's asset pipeline
    // and expose it to hashing. This file's URL has to stay literal.
    closeBundle() {
      // `outDir` may be absolute (as `--outDir /tmp/x` gives) or
      // relative to the project root; `resolve` handles both.
      const target = resolve(root, outDir);
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "version.json"),
        `${JSON.stringify({ buildId: BUILD_ID }, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), emitVersionFile()],
  define: {
    // Compiled into the bundle so the running page knows which build it
    // is, and can compare itself against version.json.
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    port: 5173,
  },
});
