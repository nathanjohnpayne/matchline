import { describe, expect, it, vi } from "vitest";

import {
  parseUidList,
  uidsFromEnvText,
  writeOwnerAllowlist,
} from "./set-owner-allowlist.ts";

describe("parseUidList", () => {
  it("splits, trims, drops empties and dedupes", () => {
    expect(parseUidList(" a, b,,a , ")).toEqual(["a", "b"]);
  });
  it("returns [] for unset or blank input", () => {
    expect(parseUidList(undefined)).toEqual([]);
    expect(parseUidList("  ")).toEqual([]);
  });
});

describe("uidsFromEnvText", () => {
  it("reads the key from dotenv text, quoted or not", () => {
    expect(uidsFromEnvText("OTHER=1\nMATCHLINE_OWNER_UIDS=abc\n")).toEqual(["abc"]);
    expect(uidsFromEnvText('MATCHLINE_OWNER_UIDS="abc, def"')).toEqual(["abc", "def"]);
    expect(uidsFromEnvText("export MATCHLINE_OWNER_UIDS='abc'")).toEqual(["abc"]);
  });
  it("returns [] when the key is absent or empty", () => {
    expect(uidsFromEnvText("OTHER=1")).toEqual([]);
    expect(uidsFromEnvText("MATCHLINE_OWNER_UIDS=")).toEqual([]);
  });
  it("does not match a key that merely ends with the name", () => {
    expect(uidsFromEnvText("NOT_MATCHLINE_OWNER_UIDS=abc")).toEqual([]);
  });
});

/** Minimal in-memory stand-in for the one document the script touches. */
function fakeDb(readBack?: Record<string, unknown>) {
  let stored: Record<string, unknown> | undefined;
  const set = vi.fn(async (data: Record<string, unknown>, options?: unknown) => {
    expect(options).toBeUndefined(); // full overwrite, never merge
    stored = { ...data };
  });
  const ref = {
    set,
    get: async () => ({ data: () => readBack ?? stored }),
  };
  return { db: { doc: () => ref } as never, set };
}

describe("writeOwnerAllowlist", () => {
  it("overwrites config/access with exactly the uids and verifies the read-back", async () => {
    const { db, set } = fakeDb();
    await writeOwnerAllowlist(db, ["abc"], () => "2026-09-30T00:00:00.000Z");
    expect(set).toHaveBeenCalledWith({
      owner_uids: ["abc"],
      updated_at: "2026-09-30T00:00:00.000Z",
    });
  });

  it("refuses an empty allowlist", async () => {
    const { db, set } = fakeDb();
    await expect(writeOwnerAllowlist(db, [])).rejects.toThrow(/empty allowlist/);
    expect(set).not.toHaveBeenCalled();
  });

  it("fails when the read-back carries anything else", async () => {
    const { db } = fakeDb({ owner_uids: ["abc"], updated_at: "x", extra: true });
    await expect(writeOwnerAllowlist(db, ["abc"])).rejects.toThrow(/unexpected content/);
    const { db: db2 } = fakeDb({ owner_uids: ["abc", "mallory"], updated_at: "x" });
    await expect(writeOwnerAllowlist(db2, ["abc"])).rejects.toThrow(/unexpected content/);
  });
});
