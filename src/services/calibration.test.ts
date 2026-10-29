import { describe, expect, it } from "vitest";

import type { Deck } from "../lib/labelDeck/deck.ts";
import { decide, deckFingerprint, initSession } from "../lib/labelDeck/session.ts";

import { MAX_DECK_JSON, buildDeckDoc, buildSessionDoc, docIdFor, parseSessionDoc, withTimeout } from "./calibration.ts";

const deck: Deck = {
  format: "matchline-label-deck/1",
  deck_id: "demo-cell",
  cell_order: 2,
  sources: { resume: { title: "R", text: "Riley Demo" }, jd: { title: "J", text: "PM" } },
  cards: [{ item_id: "x/verbatim", type: "verbatim", catch: false, claim: [{ label: "c", text: "Riley Demo" }], evidence: [], source: "resume", highlight: { resume: [0], jd: [] } }],
};
const NOW = new Date("2026-10-29T12:00:00Z");

describe("calibration storage shapes", () => {
  it("stores a deck as one JSON string with the fields the rules allow", () => {
    const d = buildDeckDoc(deck, "uid-1", NOW);
    expect(Object.keys(d).sort()).toEqual(["card_count", "cell_order", "deck_id", "deck_json", "fingerprint", "id", "owner_uid", "uploaded_at"]);
    expect(d).toMatchObject({ id: docIdFor("uid-1", "demo-cell"), owner_uid: "uid-1", cell_order: 2, card_count: 1, fingerprint: deckFingerprint(deck) });
    expect(JSON.parse(d.deck_json)).toEqual(deck);
    expect(d.fingerprint.length).toBeLessThanOrEqual(64);
  });

  it("refuses a deck over the stored size limit with its name, counting UTF-8 bytes", () => {
    const huge = { ...deck, sources: { ...deck.sources, resume: { title: "R", text: "x".repeat(MAX_DECK_JSON) } } };
    expect(() => buildDeckDoc(huge, "uid-1", NOW)).toThrow(/demo-cell is too large/);
    // Under the character cap, over the byte cap: three bytes per "—".
    const wide = { ...deck, sources: { ...deck.sources, resume: { title: "R", text: "—".repeat(400_000) } } };
    expect(() => buildDeckDoc(wide, "uid-1", NOW)).toThrow(/bytes/);
  });

  it("times out a write that never settles", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "Saving your labels")).rejects.toThrow(/Saving your labels did not finish/);
    await expect(withTimeout(Promise.resolve(3), 10, "x")).resolves.toBe(3);
  });

  it("round-trips a session, and drops one saved for different deck content", () => {
    const stored = { session_id: "s-1", state: decide(initSession(deck, 7), "true", 900) };
    const doc = buildSessionDoc(deck, stored, "uid-1", NOW, 4);
    expect(Object.keys(doc).sort()).toEqual(["base_rev", "deck_id", "fingerprint", "id", "owner_uid", "rev", "session_id", "state_json", "updated_at"]);
    expect(doc).toMatchObject({ base_rev: 4, rev: 5 });
    expect(buildSessionDoc(deck, stored, "uid-1", NOW, -1)).toMatchObject({ base_rev: -1, rev: 0 });
    expect(parseSessionDoc(doc, deck)).toEqual(stored);
    const changed = { ...deck, sources: { ...deck.sources, jd: { title: "J", text: "edited" } } };
    expect(parseSessionDoc(doc, changed)).toBeNull();
    expect(parseSessionDoc({ ...doc, state_json: "{broken" }, deck)).toBeNull();
    expect(parseSessionDoc(undefined, deck)).toBeNull();
  });
});
