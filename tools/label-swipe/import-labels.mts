/**
 * Write swipe labels back into a #636 calibration packet.
 *
 *   npx tsx tools/label-swipe/import-labels.mts <labels-*.json> [--packet <dir>] [--force] [--allow-unknown] [--dry-run]
 *
 * Fills the owner columns of `<packet>/<deck_id>.md` (Y / N / partial and
 * notes) and appends a `[label-swipe …]` block to the `notes` of
 * `<packet>/corrections/<deck_id>.json`. Re-running with the same labels is a
 * no-op; a cell already holding a different value stops the import unless
 * `--force`. Labels that match no sheet row (a regenerated sheet, the wrong
 * packet) stop the import unless `--allow-unknown`. Never reads KEY.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DEFAULT_PACKET, isMain, parseArgs, writePrivate } from "./lib/cli.mts";
import { ImportConflictError, importLabels, type ImportResult, type LabelsFile, type Scaffold } from "./lib/importer.mts";

export class UnknownItemsError extends Error {
  constructor(public readonly items: string[]) {
    super(`${items.length} labelled item(s) match no row in the sheet (regenerated sheet or wrong packet?); nothing written. Re-run with --allow-unknown to import the rest: ${items.join(", ")}`);
  }
}

export function importIntoPacket(labelsPath: string, packet: string, options: { force?: boolean; dryRun?: boolean; allowUnknown?: boolean } = {}): ImportResult {
  const labels = JSON.parse(readFileSync(labelsPath, "utf8")) as LabelsFile;
  if (!labels.deck_id || !/^[\w.-]+$/.test(labels.deck_id) || !Array.isArray(labels.items)) {
    throw new Error(`${labelsPath} is not a label-swipe labels file`);
  }
  const sheetPath = join(packet, `${labels.deck_id}.md`);
  const scaffoldPath = join(packet, "corrections", `${labels.deck_id}.json`);
  const scaffoldRaw = existsSync(scaffoldPath) ? readFileSync(scaffoldPath, "utf8") : null;
  const result = importLabels(readFileSync(sheetPath, "utf8"), scaffoldRaw ? (JSON.parse(scaffoldRaw) as Scaffold) : null, labels, options);
  if (result.unknown.length && !options.allowUnknown) {
    throw new UnknownItemsError(result.unknown);
  }
  if (!options.dryRun) {
    writePrivate(sheetPath, result.sheet);
    if (result.scaffold && scaffoldRaw !== null) {
      // Keep the scaffold's own layout: 2-space indent, trailing newline only if it had one.
      writePrivate(scaffoldPath, JSON.stringify(result.scaffold, null, 2) + (scaffoldRaw.endsWith("\n") ? "\n" : ""));
    }
  }
  return result;
}

function main(): void {
  const { flags, positional } = parseArgs(process.argv.slice(2), ["force", "dry-run", "allow-unknown"]);
  if (positional.length !== 1) {
    console.error("usage: npx tsx tools/label-swipe/import-labels.mts <labels-*.json> [--packet <dir>] [--force] [--allow-unknown] [--dry-run]");
    process.exit(2);
  }
  const packet = resolve(String(flags.get("packet") ?? DEFAULT_PACKET));
  try {
    const r = importIntoPacket(resolve(positional[0]), packet, { force: flags.has("force"), dryRun: flags.has("dry-run"), allowUnknown: flags.has("allow-unknown") });
    console.log(`${flags.has("dry-run") ? "[dry run] " : ""}${r.written} cell(s) written, ${r.unchanged} already up to date${r.scaffoldChanged ? "; corrections notes updated" : ""}.`);
    if (r.unknown.length) console.warn(`${r.unknown.length} item(s) did not match a sheet row: ${r.unknown.join(", ")}`);
  } catch (error) {
    if (error instanceof ImportConflictError || error instanceof UnknownItemsError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) main();
