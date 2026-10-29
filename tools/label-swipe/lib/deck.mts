/**
 * Turn a parsed review sheet into a swipe deck.
 *
 * One card per owner judgment. The card carries the claim to judge, the
 * evidence excerpt to judge it against, and which source text (résumé, JD or
 * both) the "expand" view shows. Score columns, `≥0.5?` flags and the
 * `endpoints mapped` column are deliberately dropped: the labeler must not
 * see the scorer's view. Extracted-Unit refs (A3, R2, …) stay out of the
 * card text too, so catch cards look like any other card.
 */

import type { Sheet } from "./sheet.mts";

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

/** Card types that accept `mixed` (the sheet's `partial`). */
export const MIXED_TYPES: readonly CardType[] = ["fact-correct", "requirement-equivalent"];

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
  format: "matchline-label-deck/1";
  deck_id: string;
  cell_order: number;
  sources: { resume: { title: string; text: string }; jd: { title: string; text: string } };
  cards: Card[];
}

const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );

/**
 * Indexes of the source lines that best cover `claim` (at most `max`, in
 * source order). Coverage = shared tokens / claim tokens; lines under 0.2 are
 * not shown, so a fabricated claim gets "no close line" rather than noise.
 */
export function closestLines(source: string, claim: string, max = 2): number[] {
  const want = tokens(claim);
  if (want.size === 0) return [];
  const scored = source
    .split("\n")
    .map((line, index) => {
      const have = tokens(line);
      let shared = 0;
      for (const t of want) if (have.has(t)) shared += 1;
      return { index, score: shared / want.size };
    })
    .filter((l) => l.score >= 0.2)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored
    .slice(0, max)
    .map((l) => l.index)
    .sort((a, b) => a - b);
}

/** Nearest heading-like line above `index` (short, no sentence punctuation). */
export function sectionHeading(source: string, index: number): string {
  const lines = source.split("\n");
  for (let i = index - 1; i >= 0; i -= 1) {
    const l = lines[i].trim();
    if (l && l.length <= 60 && !/^[-*•]/.test(l) && !/[.;,]$/.test(l)) return l.replace(/:$/, "");
  }
  return "";
}

function linesOf(source: string, indexes: number[], label: string): Field[] {
  const lines = source.split("\n");
  if (indexes.length === 0) return [{ label, text: "No close line found. Tap to read the full text." }];
  return indexes.map((i) => ({ label, text: lines[i].replace(/^\s*[-*•]\s*/, "").trim() }));
}

function mustHaveText(value: string, line: number): string {
  if (value === "must") return "must-have";
  if (value === "nice") return "nice-to-have";
  throw new Error(`sheet line ${line + 1}: unexpected parsed must-have value "${value}"`);
}

const none = { resume: [] as number[], jd: [] as number[] };

export function buildCards(sheet: Sheet): Card[] {
  const cards: Card[] = [];
  const { resumeText: resume, jdText: jd } = sheet;

  for (const row of sheet.extraction) {
    const lines = closestLines(resume, row.rawText);
    const evidence = linesOf(resume, lines, "Résumé line");
    const highlight = { ...none, resume: lines };
    cards.push({
      item_id: `${row.key}/fact-correct`,
      type: "fact-correct",
      catch: false,
      claim: [
        { label: "Extracted raw_text", text: row.rawText },
        { label: "Extracted normalized_summary", text: row.summary },
      ],
      evidence,
      source: "resume",
      highlight,
    });
    cards.push({
      item_id: `${row.key}/verbatim`,
      type: "verbatim",
      catch: false,
      claim: [{ label: "Extracted raw_text", text: row.rawText }],
      evidence,
      source: "resume",
      highlight,
    });
  }

  for (const row of sheet.unmatchedUnits) {
    const lines = closestLines(resume, row.rawText);
    cards.push({
      item_id: `${row.key}/keep-unmatched-unit`,
      type: "keep-unmatched-unit",
      catch: false,
      claim: [
        { label: "Extracted raw_text", text: row.rawText },
        { label: "Extracted normalized_summary", text: row.summary },
        { label: "skills", text: row.skills },
      ],
      evidence: [...linesOf(resume, lines, "Résumé line"), { label: "Closest expected Unit", text: row.closestLabel }],
      source: "resume",
      highlight: { ...none, resume: lines },
    });
  }

  for (const row of sheet.requirements) {
    const lines = closestLines(jd, row.parsedRaw || row.parsedNormalized, 1);
    cards.push({
      item_id: `${row.key}/requirement-equivalent`,
      type: "requirement-equivalent",
      catch: false,
      claim: [{ label: "Parsed requirement", text: row.parsedNormalized }],
      evidence: [{ label: "Expected requirement", text: row.labelText }],
      source: "jd",
      highlight: { ...none, jd: lines },
    });
    const heading = lines.length ? sectionHeading(jd, lines[0]) : "";
    cards.push({
      item_id: `${row.key}/must-have-right`,
      type: "must-have-right",
      catch: false,
      claim: [
        { label: "Parsed requirement", text: row.parsedNormalized },
        { label: "Parsed as", text: mustHaveText(row.parsedMust, row.line) },
      ],
      evidence: [...(heading ? [{ label: "JD section", text: heading }] : []), ...linesOf(jd, lines, "JD line")],
      source: "jd",
      highlight: { ...none, jd: lines },
    });
  }

  for (const row of sheet.unmatchedRequirements) {
    const lines = closestLines(jd, row.raw || row.normalized, 1);
    cards.push({
      item_id: `${row.key}/keep-unmatched-requirement`,
      type: "keep-unmatched-requirement",
      catch: false,
      claim: [
        { label: "Parsed requirement", text: row.normalized },
        { label: "category · must-have", text: `${row.category} · ${row.must}` },
      ],
      evidence: linesOf(jd, lines, "JD line"),
      source: "jd",
      highlight: { ...none, jd: lines },
    });
  }

  for (const row of sheet.matches) {
    const r = closestLines(resume, row.unitLabel, 1);
    const j = closestLines(jd, row.requirementLabel.replace(/\((must|nice)\)$/, ""), 1);
    cards.push({
      item_id: `${row.key}/match-pair-agree`,
      type: "match-pair-agree",
      catch: false,
      claim: [
        { label: "Résumé fact (label)", text: row.unitLabel },
        { label: "Answers requirement (label)", text: row.requirementLabel },
      ],
      evidence: [...linesOf(resume, r, "Résumé line"), ...linesOf(jd, j, "JD line")],
      source: "both",
      highlight: { resume: r, jd: j },
    });
  }
  return cards;
}

/** Small deterministic PRNG (mulberry32) for catch-card selection. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Change the first number in `line` so the claim becomes false. */
export function falsifyNumber(line: string): string | null {
  const m = /\d[\d,.]*/.exec(line);
  if (!m) return null;
  const digits = m[0].replace(/[,.]+$/, "");
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const changed = n >= 1900 && n <= 2099 ? String(n - 3) : String(n * 2 + 3);
  return line.slice(0, m.index) + changed + line.slice(m.index + digits.length);
}

/**
 * A summary-like rewrite of a catch line, so a catch card's summary is not
 * a copy of its raw_text (real cards never have that). It keeps the facts:
 * the line up to its last clause boundary when that leaves 30+ characters,
 * otherwise the line without articles; never a trailing period.
 */
export function summarize(line: string): string {
  const cut = Math.max(line.lastIndexOf(", "), line.lastIndexOf(" — "), line.lastIndexOf("; "));
  const text = cut >= 30 ? line.slice(0, cut) : line.replace(/\b(the|a|an) /gi, "");
  return text.replace(/[.\s]+$/, "");
}

const contentLines = (text: string) =>
  text
    .split("\n")
    .map((l, index) => ({ index, text: l.replace(/^\s*[-*•]\s*/, "").trim() }))
    .filter((l) => l.text.length >= 60 && l.text.length <= 400);

/**
 * Attention-check cards with known answers, built only from public fixture
 * text (`tests/fixtures/resumes|jds`, which is also what the sheet's source
 * section reproduces). Four per deck when the texts allow: a true fact, a
 * fact with one number changed (false), a verbatim quote (true) and a
 * requirement paired with a different JD line (false).
 */
export function buildCatchCards(deckId: string, resume: string, jd: string): Card[] {
  const rand = prng(hashString(deckId));
  const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rand() * xs.length)];
  const rLines = contentLines(resume);
  const jLines = contentLines(jd);
  const cards: Card[] = [];
  const add = (type: CardType, expected: "true" | "false", claim: Field[], evidence: Field[], source: Card["source"], highlight: Card["highlight"]) =>
    cards.push({ item_id: `catch:${cards.length + 1}/${type}`, type, catch: true, expected, claim, evidence, source, highlight });

  const truth = pick(rLines);
  if (truth) {
    add(
      "fact-correct",
      "true",
      [
        { label: "Extracted raw_text", text: truth.text },
        { label: "Extracted normalized_summary", text: summarize(truth.text) },
      ],
      [{ label: "Résumé line", text: truth.text }],
      "resume",
      { ...none, resume: [truth.index] },
    );
  }
  const numbered = pick(rLines.filter((l) => l !== truth && falsifyNumber(l.text) !== null));
  if (numbered) {
    const wrong = falsifyNumber(numbered.text) as string;
    add(
      "fact-correct",
      "false",
      [
        { label: "Extracted raw_text", text: wrong },
        { label: "Extracted normalized_summary", text: summarize(wrong) },
      ],
      [{ label: "Résumé line", text: numbered.text }],
      "resume",
      { ...none, resume: [numbered.index] },
    );
  }
  const quote = pick(rLines.filter((l) => l !== truth && l !== numbered));
  if (quote) {
    add("verbatim", "true", [{ label: "Extracted raw_text", text: quote.text }], [{ label: "Résumé line", text: quote.text }], "resume", {
      ...none,
      resume: [quote.index],
    });
  }
  const parsed = pick(jLines);
  const other = pick(jLines.filter((l) => l !== parsed && Math.abs(l.index - (parsed?.index ?? 0)) > 2));
  if (parsed && other) {
    add(
      "requirement-equivalent",
      "false",
      [{ label: "Parsed requirement", text: parsed.text }],
      [{ label: "Expected requirement", text: other.text }],
      "jd",
      { ...none, jd: [parsed.index] },
    );
  }
  return cards;
}

/** README order: the nathan cell first, the others alphabetically. */
export function cellOrder(cells: string[]): string[] {
  return [...cells].sort((a, b) => Number(!a.startsWith("nathan")) - Number(!b.startsWith("nathan")) || a.localeCompare(b));
}

export function buildDeck(sheet: Sheet, cellIndex: number, catchSources?: { resume: string; jd: string }): Deck {
  const resume = catchSources?.resume || sheet.resumeText;
  const jd = catchSources?.jd || sheet.jdText;
  return {
    format: "matchline-label-deck/1",
    deck_id: sheet.cell,
    cell_order: cellIndex,
    sources: {
      resume: { title: `Résumé ${sheet.resumeId}`, text: sheet.resumeText },
      jd: { title: `JD ${sheet.jdId}`, text: sheet.jdText },
    },
    // Catch-card highlights point into the fixture text; re-anchor them on
    // the sheet's copy, which is what the expanded view shows.
    cards: assertUniqueIds([
      ...buildCards(sheet),
      ...buildCatchCards(sheet.cell, resume, jd).map((card) => ({
        ...card,
        highlight: {
          resume: card.source === "resume" ? closestLines(sheet.resumeText, card.evidence[0].text, 1) : [],
          jd: card.source === "jd" ? closestLines(sheet.jdText, card.claim[0].text, 1) : [],
        },
      })),
    ]),
  };
}

function assertUniqueIds(cards: Card[]): Card[] {
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.item_id)) throw new Error(`duplicate card id ${card.item_id}`);
    seen.add(card.item_id);
  }
  return cards;
}
