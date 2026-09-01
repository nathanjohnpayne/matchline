/**
 * Unit tests for the update-detection primitives (#429).
 *
 * `shouldPromptForUpdate`'s three rules each exist because a simpler
 * version has a known failure mode — the cases below name which.
 */

import { describe, expect, it } from "vitest";

import {
  parseVersionPayload,
  readDismissedBuild,
  rememberDismissedBuild,
  shouldPromptForUpdate,
} from "./appVersion.ts";

const BASE = {
  currentBuildId: "build-a",
  latestBuildId: "build-b",
  dismissedBuildId: null,
  busy: false,
};

describe("parseVersionPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(parseVersionPayload({ buildId: "2026-09-01T02:11:30.712Z" })).toEqual({
      buildId: "2026-09-01T02:11:30.712Z",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseVersionPayload({ buildId: "  b1  " })).toEqual({ buildId: "b1" });
  });

  it("rejects the SPA index.html arriving via the catch-all rewrite", () => {
    // firebase.json rewrites ** -> /index.html. If the build ever stops
    // emitting version.json the fetch returns HTML with a 200; parsing
    // must report "not a version document", not "no update".
    expect(parseVersionPayload("<!doctype html><html></html>")).toBeNull();
  });

  it("rejects a missing, empty, blank, or non-string buildId", () => {
    expect(parseVersionPayload({})).toBeNull();
    expect(parseVersionPayload({ buildId: "" })).toBeNull();
    expect(parseVersionPayload({ buildId: "   " })).toBeNull();
    expect(parseVersionPayload({ buildId: 42 })).toBeNull();
  });

  it("rejects null and arrays", () => {
    expect(parseVersionPayload(null)).toBeNull();
    expect(parseVersionPayload(undefined)).toBeNull();
    expect(parseVersionPayload([])).toBeNull();
  });
});

describe("shouldPromptForUpdate", () => {
  it("prompts when a different build is deployed", () => {
    expect(shouldPromptForUpdate(BASE)).toBe(true);
  });

  it("does not prompt when the deployed build matches", () => {
    expect(shouldPromptForUpdate({ ...BASE, latestBuildId: "build-a" })).toBe(false);
  });

  it("does not prompt when either side is unknown", () => {
    // Rule 1. Guessing here yields a banner the user cannot dismiss.
    expect(shouldPromptForUpdate({ ...BASE, currentBuildId: "" })).toBe(false);
    expect(shouldPromptForUpdate({ ...BASE, latestBuildId: null })).toBe(false);
    expect(shouldPromptForUpdate({ ...BASE, latestBuildId: "" })).toBe(false);
  });

  it("does not prompt while a long operation is in flight", () => {
    // Rule 2. Extraction runs ~108s (#428); a reload offer mid-call
    // invites destroying work that is about to succeed.
    expect(shouldPromptForUpdate({ ...BASE, busy: true })).toBe(false);
  });

  it("prompts once the operation settles, without a fresh poll", () => {
    // Suppression is display-only — the observed build is retained.
    const observed = { ...BASE, busy: true };
    expect(shouldPromptForUpdate(observed)).toBe(false);
    expect(shouldPromptForUpdate({ ...observed, busy: false })).toBe(true);
  });

  it("stays quiet for the build the user declined", () => {
    expect(
      shouldPromptForUpdate({ ...BASE, dismissedBuildId: "build-b" }),
    ).toBe(false);
  });

  it("prompts again for a build NEWER than the declined one", () => {
    // Rule 3, and the half a session-scoped dismissal gets wrong:
    // fiveacross #605 hid genuinely newer builds forever.
    expect(
      shouldPromptForUpdate({
        ...BASE,
        latestBuildId: "build-c",
        dismissedBuildId: "build-b",
      }),
    ).toBe(true);
  });

  it("ignores a dismissal of a build that is no longer the latest", () => {
    expect(
      shouldPromptForUpdate({ ...BASE, dismissedBuildId: "build-ancient" }),
    ).toBe(true);
  });
});

describe("dismissal persistence", () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    } as unknown as Storage;
  }

  it("round-trips a declined build", () => {
    const s = fakeStorage();
    expect(readDismissedBuild(s)).toBeNull();
    rememberDismissedBuild("build-b", s);
    expect(readDismissedBuild(s)).toBe("build-b");
  });

  it("survives storage that throws on read or write", () => {
    // Private mode, disabled site data, quota. Losing a dismissal is
    // an annoyance; throwing would break the app shell.
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(readDismissedBuild(hostile)).toBeNull();
    expect(() => rememberDismissedBuild("b", hostile)).not.toThrow();
  });

  it("treats absent storage as no dismissal", () => {
    expect(readDismissedBuild(undefined)).toBeNull();
    expect(() => rememberDismissedBuild("b", undefined)).not.toThrow();
  });
});
