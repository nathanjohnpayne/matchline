/**
 * Label deck format shared by the Calibrate route (`/calibrate`) and the
 * `tools/label-swipe` CLIs that build decks and import labels (#636, #648).
 *
 * A deck is one calibration cell: one card per owner judgment, plus the
 * résumé and JD text its "full source" view shows. Decks hold private text,
 * so they are only ever read from a file the user picks; nothing here
 * fetches, stores or uploads one.
 */

export const DECK_FORMAT = "matchline-label-deck/1";

/** What a deck id may contain; `firestore.rules` checks the same pattern. */
export const DECK_ID = /^[A-Za-z0-9._-]{1,200}$/;

export const CARD_TYPES = [
  "fact-correct",
  "verbatim",
  "keep-unmatched-unit",
  "requirement-equivalent",
  "must-have-right",
  "keep-unmatched-requirement",
  "match-pair-agree",
] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Card types that accept `mixed` (the review sheet's `partial`). */
export const MIXED_TYPES: readonly CardType[] = ["fact-correct", "requirement-equivalent"];

export const allowsMixed = (type: string): boolean => (MIXED_TYPES as readonly string[]).includes(type);

export const LABELS = ["true", "false", "mixed", "unsure"] as const;
export type Label = (typeof LABELS)[number];

export interface Field {
  label: string;
  text: string;
}

export interface Card {
  item_id: string;
  type: CardType;
  catch: boolean;
  /** Known answer of a catch card; never rendered. */
  expected?: "true" | "false";
  claim: Field[];
  evidence: Field[];
  source: "resume" | "jd" | "both";
  /** Source line indexes to highlight in the expanded view. */
  highlight: { resume: number[]; jd: number[] };
}

export interface Deck {
  format: typeof DECK_FORMAT;
  deck_id: string;
  cell_order: number;
  sources: { resume: { title: string; text: string }; jd: { title: string; text: string } };
  cards: Card[];
}

/** One judgment in a downloaded labels file. */
export interface LabelItem {
  item_id: string;
  type: string;
  label: Label;
  note: string;
  ms: number;
  order: number;
  undos: number;
  catch: boolean;
}

/** The downloaded `labels-<deck_id>-<timestamp>.json` that import-labels reads. */
export interface LabelsFile {
  deck_id: string;
  seed: number;
  session_id: string;
  items: LabelItem[];
  attention?: { catch_cards: number; catch_correct: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFieldList = (v: unknown): boolean => Array.isArray(v) && v.every((f) => isRecord(f) && typeof f.label === "string" && typeof f.text === "string");
const isLines = (v: unknown): boolean => Array.isArray(v) && v.every((n) => Number.isInteger(n));

/**
 * Validate parsed JSON as a deck. Throws with the first problem found, so a
 * wrong file (a labels file, a sheet export) is named rather than half-shown.
 */
export function parseDeck(value: unknown): Deck {
  if (!isRecord(value) || value.format !== DECK_FORMAT) throw new Error(`not a label deck (expected format "${DECK_FORMAT}")`);
  // Letters, digits, ".", "_" and "-" only: the id is part of a Firestore document id.
  if (typeof value.deck_id !== "string" || !DECK_ID.test(value.deck_id)) throw new Error("deck has no valid deck_id");
  const sources = value.sources;
  if (!isRecord(sources) || !isRecord(sources.resume) || !isRecord(sources.jd) || typeof sources.resume.text !== "string" || typeof sources.jd.text !== "string") {
    throw new Error("deck has no résumé / JD source text");
  }
  if (!Array.isArray(value.cards) || value.cards.length === 0) throw new Error("deck has no cards");
  const seen = new Set<string>();
  value.cards.forEach((card, i) => {
    const where = `card ${i + 1}`;
    if (!isRecord(card) || typeof card.item_id !== "string") throw new Error(`${where} has no item_id`);
    if (seen.has(card.item_id)) throw new Error(`${where} repeats item_id ${card.item_id}`);
    seen.add(card.item_id);
    if (!(CARD_TYPES as readonly unknown[]).includes(card.type)) throw new Error(`${where} has an unknown type`);
    if (!isFieldList(card.claim) || !isFieldList(card.evidence)) throw new Error(`${where} has malformed claim or evidence`);
    if (card.source !== "resume" && card.source !== "jd" && card.source !== "both") throw new Error(`${where} has an unknown source`);
    if (!isRecord(card.highlight) || !isLines(card.highlight.resume) || !isLines(card.highlight.jd)) throw new Error(`${where} has malformed highlights`);
  });
  return { ...(value as unknown as Deck), cell_order: typeof value.cell_order === "number" ? value.cell_order : 0 };
}
