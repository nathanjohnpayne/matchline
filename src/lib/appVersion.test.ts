/**
 * Unit tests for the update-detection primitives (#429).
 *
 * `shouldPromptForUpdate`'s three rules each exist because a simpler
 * version has a known failure mode — the cases below name which.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createVersionPoller,
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

describe("createVersionPoller", () => {
  /**
   * Stands in for a real `Response`: `json()` performs an actual parse
   * and therefore REJECTS on a body that is not JSON.
   *
   * The previous helper resolved `json()` with whatever object it was
   * handed, so the index.html case below fed a string straight into
   * `parseVersionPayload` and never exercised what a browser really
   * does — the poller's own `catch` swallowed the SyntaxError and the
   * broken deployment contract looked like an offline client. The
   * fixture hid the bug it was written to catch (Codex P2, #434).
   */
  function rawResponse(body: string, ok = true): Response {
    return {
      ok,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    } as unknown as Response;
  }

  function jsonResponse(body: unknown, ok = true): Response {
    return rawResponse(JSON.stringify(body), ok);
  }

  it("reports the build id from a well-formed response", async () => {
    const onBuildId = vi.fn();
    const poller = createVersionPoller({
      onBuildId,
      fetchImpl: async () => jsonResponse({ buildId: "b1" }),
    });
    await poller.check();
    expect(onBuildId).toHaveBeenCalledWith("b1");
  });

  it("cache-busts the request and asks for no-store", async () => {
    // firebase.json sets no-cache, but an intermediary that ignores the
    // header would otherwise pin the first response forever.
    const seen: Array<[string, RequestInit | undefined]> = [];
    const poller = createVersionPoller({
      onBuildId: vi.fn(),
      fetchImpl: async (url, init) => {
        seen.push([String(url), init]);
        return jsonResponse({ buildId: "b1" });
      },
    });
    await poller.check();
    expect(seen[0]![0]).toMatch(/\/version\.json\?t=\d+/);
    expect(seen[0]![1]?.cache).toBe("no-store");
  });

  it("ignores a non-ok response", async () => {
    const onBuildId = vi.fn();
    const poller = createVersionPoller({
      onBuildId,
      fetchImpl: async () => jsonResponse({ buildId: "b1" }, false),
    });
    await poller.check();
    expect(onBuildId).not.toHaveBeenCalled();
  });

  it("ignores the SPA index.html arriving via the catch-all rewrite", async () => {
    const html = "<!doctype html><html><body><div id=\"root\"></div></body></html>";
    // Guard the fixture itself: a faithful Response rejects here, which
    // is precisely why the poller must not rely on `json()`.
    await expect(rawResponse(html).json()).rejects.toThrow();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const onBuildId = vi.fn();
      const poller = createVersionPoller({
        onBuildId,
        fetchImpl: async () => rawResponse(html),
      });
      await poller.check();
      expect(onBuildId).not.toHaveBeenCalled();
      // Silence is the #429 failure mode: the check would be dead and
      // indistinguishable from "no update". Say it once.
      expect(warn).toHaveBeenCalledTimes(1);
      await poller.check();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a JSON body that is not a version document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const onBuildId = vi.fn();
      const poller = createVersionPoller({
        onBuildId,
        fetchImpl: async () => jsonResponse({ notABuildId: "b1" }),
      });
      await poller.check();
      expect(onBuildId).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("swallows a network error and stays usable", async () => {
    const onBuildId = vi.fn();
    let fail = true;
    const poller = createVersionPoller({
      onBuildId,
      fetchImpl: async () => {
        if (fail) throw new Error("offline");
        return jsonResponse({ buildId: "b2" });
      },
    });
    await expect(poller.check()).resolves.toBeUndefined();
    fail = false;
    await poller.check();
    expect(onBuildId).toHaveBeenCalledWith("b2");
  });

  it("discards an out-of-order response that would drag the build backwards", async () => {
    // The interval starts a new check without awaiting the previous
    // one, so a slow response carrying build A can land after a later
    // poll already observed B — hiding the prompt, possibly for good.
    const onBuildId = vi.fn();
    const gates: Array<() => void> = [];
    let call = 0;
    const poller = createVersionPoller({
      onBuildId,
      fetchImpl: async () => {
        const n = ++call;
        await new Promise<void>((r) => gates.push(r));
        return jsonResponse({ buildId: n === 1 ? "A" : "B" });
      },
    });
    const first = poller.check();
    const second = poller.check();
    // Let the SECOND resolve first, then the stale first.
    gates[1]!();
    await second;
    gates[0]!();
    await first;
    expect(onBuildId).toHaveBeenCalledTimes(1);
    expect(onBuildId).toHaveBeenCalledWith("B");
  });

  it("drops a response that lands after stop()", async () => {
    // Cleanup must prevent a late response updating an unmounted
    // component.
    const onBuildId = vi.fn();
    let release!: () => void;
    const poller = createVersionPoller({
      onBuildId,
      fetchImpl: async () => {
        await new Promise<void>((r) => (release = r));
        return jsonResponse({ buildId: "late" });
      },
    });
    const p = poller.check();
    poller.stop();
    release();
    await p;
    expect(onBuildId).not.toHaveBeenCalled();
  });
});
