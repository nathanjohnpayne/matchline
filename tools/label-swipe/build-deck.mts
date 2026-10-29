/**
 * Build swipe decks from a #636 calibration packet.
 *
 *   npx tsx tools/label-swipe/build-deck.mts [--packet <dir>] [--out <dir>] [--fixtures <dir>]
 *
 * Reads `<packet>/<cell>.md` (never KEY.json) and writes
 * `<out>/<cell>.json` (default `<packet>/decks/`). Refuses to write inside a
 * git work tree: decks carry private text. Catch cards come from the public
 * `tests/fixtures/{resumes,jds}/<id>.txt` when present.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PACKET, NOT_SHEETS, assertOutsideRepo, isMain, parseArgs, writePrivate } from "./lib/cli.mts";
import { buildDeck, cellOrder, type Deck } from "./lib/deck.mts";
import { parseSheet } from "./lib/sheet.mts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_FIXTURES = resolve(HERE, "..", "..", "tests", "fixtures");

export function buildDecks(packet: string, fixtures: string = REPO_FIXTURES): Deck[] {
  const cells = cellOrder(
    readdirSync(packet)
      .filter((f) => f.endsWith(".md") && !NOT_SHEETS.has(f))
      .map((f) => f.slice(0, -3)),
  );
  if (cells.length === 0) throw new Error(`no review sheets (*.md) in ${packet}`);
  return cells.map((cell, index) => {
    const sheet = parseSheet(readFileSync(join(packet, `${cell}.md`), "utf8"), cell);
    const fixture = (dir: string, id: string) => {
      const path = join(fixtures, dir, `${id}.txt`);
      return id && existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    return buildDeck(sheet, index, { resume: fixture("resumes", sheet.resumeId), jd: fixture("jds", sheet.jdId) });
  });
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const packet = resolve(String(flags.get("packet") ?? DEFAULT_PACKET));
  const out = resolve(String(flags.get("out") ?? join(packet, "decks")));
  const fixtures = resolve(String(flags.get("fixtures") ?? REPO_FIXTURES));
  assertOutsideRepo(out);
  const decks = buildDecks(packet, fixtures);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const deck of decks) {
    writePrivate(join(out, `${deck.deck_id}.json`), `${JSON.stringify(deck, null, 2)}\n`);
    const catches = deck.cards.filter((c) => c.catch).length;
    console.log(`${deck.cell_order + 1}. ${deck.deck_id}: ${deck.cards.length - catches} cards + ${catches} catch → ${join(out, `${deck.deck_id}.json`)}`);
  }
}

if (isMain(import.meta.url)) main();
