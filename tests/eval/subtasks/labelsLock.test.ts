import { describe, expect, it } from "vitest";

import { checkLabelLock, loadLabelLock, lockedFiles, RELABEL_PROCEDURE, type LabelLock } from "./fixtures.ts";

/**
 * Labels are immutable for a comparison (#488): every labeled file under
 * validation-cases/, generation-snapshots/ and expected-asset-traces/
 * must match the latest entry of its lock history. A relabel bumps
 * label_version, appends to the history and lands as its own reviewed PR.
 */
describe("eval label lock", () => {
  const lock = loadLabelLock();
  const files = lockedFiles();

  it("covers exactly the files on disk", () => {
    expect(Object.keys(lock.files).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("matches every file's content, label_version and review_status", () => {
    const problems = checkLabelLock(lock, files);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("has strictly increasing, unique histories", () => {
    for (const [path, entry] of Object.entries(lock.files)) {
      const versions = entry.history.map((h) => h.label_version);
      expect(versions, path).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size, path).toBe(versions.length);
      expect(new Set(entry.history.map((h) => h.sha256)).size, path).toBe(entry.history.length);
    }
  });

  it("explains the relabel procedure and prints the new sha when content changes", () => {
    const f = files[0]!;
    const changed = [{ ...f, sha256: "0".repeat(64) }];
    const problems = checkLabelLock(lock, [...files.slice(1), ...changed]);
    expect(problems.join("\n")).toContain(`now sha256 ${"0".repeat(64)}`);
    expect(problems.join("\n")).toContain(RELABEL_PROCEDURE);
  });

  it("flags a label_version bump without a lock entry, an unlocked file and a non-increasing history", () => {
    const f = files[0]!;
    expect(checkLabelLock(lock, [{ ...f, label_version: 2 }, ...files.slice(1)]).join("\n")).toMatch(/label_version 2/);
    expect(checkLabelLock(lock, [...files, { ...f, path: "validation-cases/vc-99-new.json" }]).join("\n")).toMatch(/not in the lock/);
    const bad: LabelLock = {
      ...lock,
      files: {
        ...lock.files,
        [f.path]: {
          review_status: lock.files[f.path]!.review_status,
          history: [{ label_version: 2, sha256: "1".repeat(64) }, { label_version: 1, sha256: f.sha256 }],
        },
      },
    };
    expect(checkLabelLock(bad, files).join("\n")).toMatch(/strictly increase/);
  });
});
