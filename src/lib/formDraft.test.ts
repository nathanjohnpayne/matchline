import { describe, expect, it } from "vitest";

import {
  claimFormDrafts,
  clearAllFormDrafts,
  clearFormDraft,
  loadFormDraft,
  saveFormDraft,
} from "./formDraft.ts";

/** Minimal in-memory `Storage` (node has no `localStorage`). */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

/** A `Storage` whose every method throws, as in some privacy modes. */
function throwingStorage(): Storage {
  const boom = (): never => {
    throw new Error("SecurityError");
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

describe("formDraft", () => {
  it("round-trips a saved draft under its key", () => {
    const storage = memoryStorage();
    saveFormDraft("/roles/new", { title: "PM" }, storage);
    expect(loadFormDraft("/roles/new", storage)).toEqual({ title: "PM" });
  });

  it("namespaces keys so unrelated storage entries are untouched", () => {
    const storage = memoryStorage({ "/roles/new": "not a draft" });
    saveFormDraft("/roles/new", { title: "PM" }, storage);
    expect(storage.getItem("/roles/new")).toBe("not a draft");
    expect(storage.getItem("matchline:draft:/roles/new")).toBe(
      '{"title":"PM"}',
    );
  });

  it("returns undefined when nothing is stored", () => {
    expect(loadFormDraft("/roles/new", memoryStorage())).toBeUndefined();
  });

  it("returns undefined for a value that is not JSON", () => {
    const storage = memoryStorage({ "matchline:draft:/roles/new": "{oops" });
    expect(loadFormDraft("/roles/new", storage)).toBeUndefined();
  });

  it("clears one draft without touching others", () => {
    const storage = memoryStorage();
    saveFormDraft("a", 1, storage);
    saveFormDraft("b", 2, storage);
    clearFormDraft("a", storage);
    expect(loadFormDraft("a", storage)).toBeUndefined();
    expect(loadFormDraft("b", storage)).toBe(2);
  });

  it("clearAllFormDrafts removes every draft and nothing else", () => {
    const storage = memoryStorage({ "matchline.updateDismissed": "build-1" });
    saveFormDraft("a", 1, storage);
    saveFormDraft("b", 2, storage);
    saveFormDraft("c", 3, storage);
    clearAllFormDrafts(storage);
    expect(storage.length).toBe(1);
    expect(storage.getItem("matchline.updateDismissed")).toBe("build-1");
  });

  it("degrades to no persistence when storage is unavailable", () => {
    expect(() => saveFormDraft("a", 1, undefined)).not.toThrow();
    expect(loadFormDraft("a", undefined)).toBeUndefined();
    expect(() => clearFormDraft("a", undefined)).not.toThrow();
    expect(() => clearAllFormDrafts(undefined)).not.toThrow();
  });

  it("never throws when storage access itself throws", () => {
    const storage = throwingStorage();
    expect(() => saveFormDraft("a", 1, storage)).not.toThrow();
    expect(loadFormDraft("a", storage)).toBeUndefined();
    expect(() => clearFormDraft("a", storage)).not.toThrow();
    expect(() => clearAllFormDrafts(storage)).not.toThrow();
  });

  it("claimFormDrafts keeps drafts for the same account", () => {
    const storage = memoryStorage();
    claimFormDrafts("uid-a", storage);
    saveFormDraft("a", 1, storage);
    claimFormDrafts("uid-a", storage);
    expect(loadFormDraft("a", storage)).toBe(1);
  });

  it("claimFormDrafts clears drafts left by a different account", () => {
    const storage = memoryStorage();
    claimFormDrafts("uid-a", storage);
    saveFormDraft("a", 1, storage);
    claimFormDrafts("uid-b", storage);
    expect(loadFormDraft("a", storage)).toBeUndefined();
    // uid-b now owns the (empty) draft set.
    saveFormDraft("b", 2, storage);
    claimFormDrafts("uid-b", storage);
    expect(loadFormDraft("b", storage)).toBe(2);
  });

  it("claimFormDrafts clears drafts with no recorded owner", () => {
    const storage = memoryStorage();
    saveFormDraft("a", 1, storage);
    claimFormDrafts("uid-a", storage);
    expect(loadFormDraft("a", storage)).toBeUndefined();
  });

  it("claimFormDrafts never throws when storage is unavailable or throws", () => {
    expect(() => claimFormDrafts("uid-a", undefined)).not.toThrow();
    expect(() => claimFormDrafts("uid-a", throwingStorage())).not.toThrow();
  });
});
