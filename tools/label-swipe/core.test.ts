import { beforeAll, describe, expect, it } from "vitest";

import "./core.js";
import type { DeckLike, LabelCoreApi } from "./core.js";

let Core: LabelCoreApi;
beforeAll(() => {
  Core = globalThis.LabelCore;
});

const deck: DeckLike = {
  deck_id: "demo-cell",
  cards: [
    { item_id: "ext:u_a:A/fact-correct", type: "fact-correct", catch: false },
    { item_id: "ext:u_a:A/verbatim", type: "verbatim", catch: false },
    { item_id: "req:r_x/requirement-equivalent", type: "requirement-equivalent", catch: false },
    { item_id: "pair:u_a:r_x/match-pair-agree", type: "match-pair-agree", catch: false },
    { item_id: "catch:1/fact-correct", type: "fact-correct", catch: true, expected: "false" },
  ],
};

describe("shuffle", () => {
  it("is deterministic for a seed and a permutation of the input", () => {
    const ids = deck.cards.map((c) => c.item_id);
    const a = Core.shuffle(ids, 42);
    expect(Core.shuffle(ids, 42)).toEqual(a);
    expect([...a].sort()).toEqual([...ids].sort());
    expect(ids[0]).toBe("ext:u_a:A/fact-correct"); // input untouched
  });

  it("gives different orders for different seeds", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `id${i}`);
    expect(Core.shuffle(ids, 1)).not.toEqual(Core.shuffle(ids, 2));
  });

  it("initState queues the deck in the seeded order and records the seed", () => {
    const state = Core.initState(deck, 7);
    expect(state.seed).toBe(7);
    expect(state.queue).toEqual(Core.shuffle(deck.cards.map((c) => c.item_id), 7));
    expect(Core.progress(state)).toEqual({ done: 0, total: 5 });
  });
});

/** A state whose queue is in deck order, for readable reducer tests. */
function ordered() {
  return { ...Core.initState(deck, 1), queue: deck.cards.map((c) => c.item_id) };
}

describe("decision reducer", () => {
  it("labels the current card and advances", () => {
    const s = Core.decide(ordered(), "true", 1200);
    expect(s.decisions["ext:u_a:A/fact-correct"]).toEqual({ label: "true", note: "", ms: 1200, order: 1 });
    expect(Core.current(s)).toBe("ext:u_a:A/verbatim");
  });

  it("ignores mixed on a true/false-only card", () => {
    const s = Core.decide(ordered(), "true", 1);
    expect(Core.decide(s, "mixed", 5)).toBe(s);
    expect(Core.decide(Core.decide(s, "false", 5), "mixed", 5).decisions["req:r_x/requirement-equivalent"].label).toBe("mixed");
  });

  it("re-queues on the first unsure and keeps the time, records a second unsure", () => {
    let s = Core.decide(ordered(), "unsure", 500);
    expect(s.queue[s.queue.length - 1]).toBe("ext:u_a:A/fact-correct");
    expect(s.requeued["ext:u_a:A/fact-correct"]).toBe(true);
    expect(s.decisions["ext:u_a:A/fact-correct"]).toBeUndefined();
    for (let i = 0; i < 4; i += 1) s = Core.decide(s, "true", 10);
    expect(Core.current(s)).toBe("ext:u_a:A/fact-correct");
    s = Core.decide(s, "unsure", 300);
    expect(s.decisions["ext:u_a:A/fact-correct"]).toMatchObject({ label: "unsure", ms: 800, order: 5 });
    expect(Core.current(s)).toBeNull();
  });

  it("undo restores the card, counts the undo and keeps elapsed time", () => {
    let s = Core.decide(ordered(), "false", 900);
    s = Core.undo(s);
    expect(Core.current(s)).toBe("ext:u_a:A/fact-correct");
    expect(s.decisions).toEqual({});
    expect(s.undos["ext:u_a:A/fact-correct"]).toBe(1);
    s = Core.decide(s, "true", 100);
    expect(s.decisions["ext:u_a:A/fact-correct"]).toEqual({ label: "true", note: "", ms: 1000, order: 1 });
  });

  it("undo reverses a re-queue", () => {
    let s = Core.decide(ordered(), "unsure", 400);
    s = Core.undo(s);
    expect(s.queue).toEqual(deck.cards.map((c) => c.item_id));
    expect(s.requeued).toEqual({});
    // The time spent before the undone Can't tell still counts.
    expect(Core.decide(s, "true", 100).decisions["ext:u_a:A/fact-correct"].ms).toBe(500);
  });

  it("undo is unlimited and a no-op on an empty history", () => {
    let s = ordered();
    for (const label of ["true", "false", "true"] as const) s = Core.decide(s, label, 1);
    s = Core.undo(Core.undo(Core.undo(s)));
    expect(s.counter).toBe(0);
    expect(Core.current(s)).toBe("ext:u_a:A/fact-correct");
    expect(Core.undo(s)).toBe(s);
  });

  it("attaches a one-line note only to false or mixed decisions", () => {
    let s = Core.decide(ordered(), "false", 1);
    s = Core.setNote(s, "ext:u_a:A/fact-correct", "  wrong\n year ");
    expect(s.decisions["ext:u_a:A/fact-correct"].note).toBe("wrong year");
    s = Core.decide(s, "true", 1);
    expect(Core.setNote(s, "ext:u_a:A/verbatim", "x")).toBe(s);
    expect(Core.setNote(s, "nope", "x")).toBe(s);
  });

  it("undo drops the note with the decision", () => {
    let s = Core.setNote(Core.decide(ordered(), "false", 1), "ext:u_a:A/fact-correct", "n");
    s = Core.decide(Core.undo(s), "false", 1);
    expect(s.decisions["ext:u_a:A/fact-correct"].note).toBe("");
  });
});

describe("export", () => {
  it("has the documented shape, ordered by decision order, catch items marked", () => {
    let s = Core.initState(deck, 99);
    const labels = ["true", "false", "true", "true", "false"] as const;
    for (const label of labels) {
      const id = Core.current(s) as string;
      const type = s.types[id];
      s = Core.decide(s, type === "fact-correct" && label === "false" ? "mixed" : label, 10);
    }
    const out = Core.buildExport(deck, s, "session-1");
    expect(Object.keys(out).sort()).toEqual(["attention", "deck_id", "items", "seed", "session_id"]);
    expect(out).toMatchObject({ deck_id: "demo-cell", seed: 99, session_id: "session-1" });
    expect(out.items).toHaveLength(5);
    expect(out.items.map((i) => i.order)).toEqual([1, 2, 3, 4, 5]);
    for (const item of out.items) {
      expect(Object.keys(item).sort()).toEqual(["catch", "item_id", "label", "ms", "note", "order", "type", "undos"]);
    }
    expect(out.items.filter((i) => i.catch).map((i) => i.item_id)).toEqual(["catch:1/fact-correct"]);
    expect(out.attention.catch_cards).toBe(1);
  });

  it("scores catch cards against their expected answer", () => {
    const catchOnly: DeckLike = { deck_id: "d", cards: [deck.cards[4]] };
    const s = Core.decide(Core.initState(catchOnly, 1), "false", 1);
    expect(Core.buildExport(catchOnly, s, "x").attention).toEqual({ catch_cards: 1, catch_correct: 1 });
  });

  it("names the file labels-<deck_id>-<timestamp>.json", () => {
    expect(Core.exportFilename("demo-cell", new Date("2026-10-29T08:09:10.123Z"))).toBe("labels-demo-cell-20261029T080910Z.json");
  });

  it("accepts a persisted state only for the same deck", () => {
    const s = Core.initState(deck, 3);
    expect(Core.stateMatchesDeck(s, deck)).toBe(true);
    expect(Core.stateMatchesDeck(s, { ...deck, cards: deck.cards.slice(1) })).toBe(false);
    expect(Core.stateMatchesDeck(null, deck)).toBe(false);
  });
});
