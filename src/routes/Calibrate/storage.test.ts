import { describe, expect, it, vi } from "vitest";

import type { Deck } from "../../lib/labelDeck/deck.ts";
import { decide, initSession } from "../../lib/labelDeck/session.ts";

import { clearSession, loadSession, saveSession } from "./storage.ts";

const deck: Deck = {
  format: "matchline-label-deck/1",
  deck_id: "cell-a",
  cell_order: 0,
  sources: { resume: { title: "R", text: "a private line" }, jd: { title: "J", text: "b" } },
  cards: [{ item_id: "x/verbatim", type: "verbatim", catch: false, claim: [{ label: "c", text: "a private line" }], evidence: [], source: "resume", highlight: { resume: [0], jd: [] } }],
};

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("Calibrate session storage", () => {
  it("round-trips a session and never stores card text", () => {
    const storage = memoryStorage();
    const stored = { session_id: "s1", state: decide(initSession(deck, 5), "true", 10) };
    saveSession(stored, storage);
    expect(loadSession(deck, storage)).toEqual(stored);
    expect(storage.getItem("matchline:calibrate:v1:cell-a")).not.toContain("a private line");
    clearSession("cell-a", storage);
    expect(loadSession(deck, storage)).toBeNull();
  });

  it("ignores a session for a changed deck, corrupt JSON, or a throwing store", () => {
    const storage = memoryStorage();
    saveSession({ session_id: "s1", state: initSession(deck, 5) }, storage);
    const changed = { ...deck, sources: { ...deck.sources, jd: { title: "J", text: "edited" } } };
    expect(loadSession(changed, storage)).toBeNull();
    storage.setItem("matchline:calibrate:v1:cell-a", "{not json");
    expect(loadSession(deck, storage)).toBeNull();
    const throwing = { ...memoryStorage(), getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } } as Storage;
    expect(loadSession(deck, throwing)).toBeNull();
    expect(() => saveSession({ session_id: "s", state: initSession(deck, 1) }, throwing)).not.toThrow();
  });

  it("works without storage when merely reading localStorage throws (site data blocked)", () => {
    const spy = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      expect(loadSession(deck)).toBeNull();
      expect(() => saveSession({ session_id: "s", state: initSession(deck, 1) })).not.toThrow();
      expect(() => clearSession("cell-a")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
