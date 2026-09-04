/**
 * Build fixture for the version-file contract (#429).
 *
 * `vite.config.ts`'s `emitVersionFile` plugin performs filesystem I/O
 * that nothing else exercises: every other test in this area asserts on
 * the *parser*, not on whether a build actually produces the file. A
 * `vite build` exits 0 whether or not the hook runs, so if the plugin is
 * removed or stops writing, update detection silently stops working and
 * no test notices — the symptom (`version.json` 404s, the poll never
 * fires) is indistinguishable from "no deploy has happened". Codex P1 on
 * PR #434; `docs/agents/testing-requirements.md` requires a happy-path
 * fixture for I/O-bound production code.
 *
 * Runs a real build into a temp directory rather than mocking, because
 * the two things worth pinning are exactly the ones a mock would assume:
 * that the plugin honours the resolved `outDir`, and that the stamp on
 * disk is byte-identical to the one compiled into the bundle. A drift
 * between those two makes every client compare against a build id it can
 * never match, so the prompt would fire forever.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "matchline-version-"));
  // A custom --outDir is deliberate: it covers the emission contract
  // and the resolved-output-directory fix in one build.
  execFileSync(
    "npx",
    ["vite", "build", "--outDir", outDir, "--emptyOutDir"],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}, 180_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("version file emission", () => {
  it("writes version.json into the resolved output directory", () => {
    const raw = readFileSync(join(outDir, "version.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("emits a non-empty string buildId", () => {
    const parsed = JSON.parse(
      readFileSync(join(outDir, "version.json"), "utf8"),
    ) as { buildId?: unknown };
    expect(typeof parsed.buildId).toBe("string");
    expect((parsed.buildId as string).trim()).not.toBe("");
  });

  it("matches the build id compiled into the bundle", () => {
    // The contract that actually matters: the running page compares
    // __BUILD_ID__ against this file. If they ever diverge, every client
    // sees a permanent mismatch and the banner never goes away.
    const { buildId } = JSON.parse(
      readFileSync(join(outDir, "version.json"), "utf8"),
    ) as { buildId: string };
    const assetsDir = join(outDir, "assets");
    const bundles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    expect(bundles.length).toBeGreaterThan(0);
    const found = bundles.some((f) =>
      readFileSync(join(assetsDir, f), "utf8").includes(buildId),
    );
    expect(found).toBe(true);
  });

  it("is served as a literal path, not an asset-hashed one", () => {
    // The poll fetches /version.json. Emitting through Rollup's asset
    // pipeline would hash the name and break that URL.
    expect(readdirSync(outDir)).toContain("version.json");
  });
});
