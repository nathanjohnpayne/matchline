/**
 * Owner-corrected inputs for `eval:fixed-inputs` (#648).
 *
 * A corrections file is the calibration packet's scaffold
 * (`corrections/<cell>.json`) after the owner filled it: one flow's saved
 * Units and Requirements, each with `owner_verdict` and the owner's
 * corrected fields.
 *
 * ## Naming by hash
 *
 * A file is accepted only when the sha256 of its bytes is listed in the
 * frozen in-repo manifest `corrections-manifest.json`, with a name and
 * the cell it belongs to. The run prints the name and the hash, so a
 * corrected set is always named by its exact contents. Editing a listed
 * file changes its hash and the run refuses it until the new hash is
 * committed. The manifest ships empty: each corrected set is added in a
 * reviewed commit.
 *
 * ## Verdicts
 *
 * Units: `keep`, `fix`, `drop`, `add`. Requirements: `keep`, `fix`,
 * `drop`. Every item on the side being used needs a non-null verdict,
 * and every saved item of the source flow must be listed.
 *
 * - `keep`: the item must equal the source flow's item; it is used as is.
 * - `fix` (Unit): `owner_corrected_raw_text`, when set, replaces
 *   `raw_text`, and in-place edits (for example `normalized_summary`,
 *   which the matcher embeds, and `skills`) are taken as written. A fix
 *   that changes only `normalized_summary` or `skills` may leave
 *   `owner_corrected_raw_text` null.
 * - `fix` (Requirement): `owner_corrected_text` replaces
 *   `normalized_requirement` and `owner_must_have` overrides `must_have`;
 *   other in-place edits are taken as written. A `fix` must change
 *   something.
 * - `drop`: left out.
 *
 * On a `keep` or `drop` item, an `owner_corrected_raw_text`,
 * `owner_corrected_text` or `owner_must_have` equal to the saved
 * `raw_text`, `normalized_requirement` or `must_have` is a confirmation
 * (the calibration packet asks the owner to set `owner_must_have` on
 * every Requirement) and is accepted; a value that differs is refused,
 * since only `fix` changes an item.
 * - `add` (Units only): a Unit the extractor missed, with at least
 *   `raw_text`, `normalized_summary` and `skills`. It gets the id
 *   `added_<n>` and, for every field it does not set, the gold-Unit
 *   constants (confidence 1, no signals, no outcomes or metrics, no date
 *   range).
 *
 * Every owner-review field (`owner_*` other than the item's own
 * `owner_uid`) is stripped. The result is a plain Units or
 * Requirements set in the record's shape, mapped to label ids with
 * `mapUnitIds` / `mapRequirementIds` like any record side.
 *
 * ## Source flow
 *
 * The scaffold names no invocation or arm (the arm is sealed in the
 * packet's KEY.json, which this code never reads). The source flow is the
 * one record flow of the file's cell whose saved ids include every
 * non-added id in the file; zero or several matches are refused.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { ExperienceUnit, JobRequirementUnit } from "../../../functions/src/types/capability.ts";

import type { FlowRecord } from "../flowRecord.ts";

import { GOLD_OWNER_UID } from "./inputs.ts";

export const CORRECTIONS_MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "corrections-manifest.json");

const ManifestSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(
      z
        .object({
          sha256: z.string().regex(/^[0-9a-f]{64}$/u),
          name: z.string().min(1),
          cell: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type CorrectionsManifest = z.infer<typeof ManifestSchema>;
export type ManifestEntry = CorrectionsManifest["entries"][number];

export function loadManifest(path: string = CORRECTIONS_MANIFEST_PATH): CorrectionsManifest {
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: not a corrections manifest (${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"})`);
  }
  const seen = new Set<string>();
  for (const e of parsed.data.entries) {
    if (seen.has(e.sha256)) throw new Error(`${path}: sha256 ${e.sha256} is listed twice`);
    seen.add(e.sha256);
  }
  return parsed.data;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ItemSchema = z.record(z.string(), z.unknown());
const CorrectionsFileSchema = z
  .object({
    resumeId: z.string().min(1),
    jdId: z.string().min(1),
    units: z.array(ItemSchema).optional(),
    requirements: z.array(ItemSchema).optional(),
    notes: z.unknown().optional(),
  })
  .passthrough();

export type CorrectionsFile = z.infer<typeof CorrectionsFileSchema>;

export interface LoadedCorrections {
  readonly path: string;
  readonly sha256: string;
  readonly name: string;
  readonly cell: string;
  readonly file: CorrectionsFile;
}

/** Hash, check against the manifest, and parse. Refuses an unlisted hash, printing it. */
export function loadCorrections(path: string, manifest: CorrectionsManifest): LoadedCorrections {
  const sha256 = sha256File(path);
  const entry = manifest.entries.find((e) => e.sha256 === sha256);
  if (entry === undefined) {
    throw new Error(
      `${path}: sha256 ${sha256} is not listed in tests/eval/fixedInputs/corrections-manifest.json. ` +
        "A corrected input set is named by its hash: add {sha256, name, cell} for this file in a reviewed commit, " +
        "and never edit a listed file (an edit is a new set with a new hash).",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = CorrectionsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path}: not a corrections file (${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"})`);
  }
  const cell = `${parsed.data.resumeId}__${parsed.data.jdId}`;
  if (entry.cell !== cell) {
    throw new Error(`${path}: the manifest lists ${sha256} for cell ${entry.cell}, but the file is for ${cell}`);
  }
  return { path, sha256, name: entry.name, cell, file: parsed.data };
}

export type Side = "units" | "requirements";

export interface SideProvenance {
  readonly kept: readonly string[];
  readonly fixed: readonly { readonly id: string; readonly fields: readonly string[] }[];
  readonly dropped: readonly string[];
  readonly added: readonly { readonly id: string; readonly normalized_summary: string }[];
}

const UNIT_VERDICTS = ["keep", "fix", "drop", "add"] as const;
const REQUIREMENT_VERDICTS = ["keep", "fix", "drop"] as const;

/** JSON with object keys sorted, for content comparison. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An owner-review field (`owner_verdict`, `owner_corrected_*`, ...). `owner_uid` is the item's own field. */
export function isReviewField(key: string): boolean {
  return key.startsWith("owner_") && key !== "owner_uid";
}

function stripOwner(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) if (!isReviewField(k)) out[k] = v;
  return out;
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => stable(before[k]) !== stable(after[k])).sort();
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

interface Applied<T> {
  readonly items: T[];
  readonly provenance: SideProvenance;
}

function sourceIds(source: readonly { readonly id: string }[], where: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const s of source) {
    if (out.has(s.id)) throw new Error(`${where}: the source flow repeats id ${s.id}`);
    out.set(s.id, s as unknown as Record<string, unknown>);
  }
  return out;
}

function checkCoverage(
  where: string,
  side: Side,
  listed: ReadonlySet<string>,
  source: ReadonlyMap<string, unknown>,
): void {
  const missing = [...source.keys()].filter((id) => !listed.has(id));
  if (missing.length > 0) {
    throw new Error(`${where}: ${side} omits saved item(s) of the source flow: ${missing.join(", ")}. List each with a verdict.`);
  }
}

/** Apply Unit corrections to the source flow's saved Units. */
export function applyUnitCorrections(
  items: readonly Record<string, unknown>[],
  source: readonly ExperienceUnit[],
  where: string,
): Applied<ExperienceUnit> {
  const bySource = sourceIds(source, where);
  const listed = new Set<string>();
  const out: ExperienceUnit[] = [];
  const kept: string[] = [];
  const fixed: { id: string; fields: string[] }[] = [];
  const dropped: string[] = [];
  const added: { id: string; normalized_summary: string }[] = [];
  items.forEach((item, i) => {
    const at = `${where}: units[${i}]`;
    const verdict = item.owner_verdict;
    if (verdict === null || verdict === undefined) throw new Error(`${at}: owner_verdict is null; every item needs a verdict`);
    if (!(UNIT_VERDICTS as readonly unknown[]).includes(verdict)) {
      throw new Error(`${at}: owner_verdict must be one of ${UNIT_VERDICTS.join("|")} (got ${JSON.stringify(verdict)})`);
    }
    if (verdict === "add") {
      if (!nonEmpty(item.raw_text) || !nonEmpty(item.normalized_summary) || !isStringArray(item.skills)) {
        throw new Error(`${at}: an added Unit needs raw_text, normalized_summary and skills`);
      }
      const id = `added_${added.length + 1}`;
      const unit = {
        owner_uid: GOLD_OWNER_UID,
        source_type: "resume",
        source_ref: "owner-added",
        unit_type: "achievement",
        tools: [],
        domains: [],
        seniority_signals: [],
        scope_signals: [],
        business_outcomes: [],
        metrics: [],
        evidence_type: "verified",
        confidence_score: 1,
        user_approved: true,
        created_at: "",
        updated_at: "",
        ...stripOwner(item),
        id,
      } as unknown as ExperienceUnit;
      out.push(unit);
      added.push({ id, normalized_summary: unit.normalized_summary });
      return;
    }
    const id = item.id;
    if (typeof id !== "string" || !bySource.has(id)) {
      throw new Error(`${at}: id ${JSON.stringify(id)} is not a saved Unit of the source flow`);
    }
    if (listed.has(id)) throw new Error(`${at}: Unit ${id} is listed twice`);
    listed.add(id);
    const before = bySource.get(id)!;
    const content = stripOwner(item);
    const correctedRaw = item.owner_corrected_raw_text;
    const hasRaw = correctedRaw !== null && correctedRaw !== undefined;
    if (hasRaw && !nonEmpty(correctedRaw)) throw new Error(`${at}: owner_corrected_raw_text must be a non-empty string`);
    if (verdict !== "fix" && hasRaw && correctedRaw !== before.raw_text) {
      throw new Error(`${at}: owner_corrected_raw_text differs from the saved raw_text on a "${verdict}" Unit; use "fix"`);
    }
    if (verdict === "drop") {
      dropped.push(id);
      return;
    }
    if (verdict === "keep") {
      const diff = changedFields(before, content);
      if (diff.length > 0) {
        throw new Error(`${at}: Unit ${id} is marked keep but differs from the source flow in ${diff.join(", ")}; mark it fix`);
      }
      out.push(content as unknown as ExperienceUnit);
      kept.push(id);
      return;
    }
    const after: Record<string, unknown> = { ...content, ...(hasRaw && { raw_text: correctedRaw }) };
    if (!nonEmpty(after.normalized_summary) || !isStringArray(after.skills)) {
      throw new Error(`${at}: a fixed Unit needs a normalized_summary and a skills list`);
    }
    const fields = changedFields(before, after);
    if (fields.length === 0) throw new Error(`${at}: Unit ${id} is marked fix but changes nothing`);
    out.push(after as unknown as ExperienceUnit);
    fixed.push({ id, fields });
  });
  checkCoverage(where, "units", listed, bySource);
  return { items: out, provenance: { kept, fixed, dropped, added } };
}

/** Apply Requirement corrections to the source flow's saved Requirements. */
export function applyRequirementCorrections(
  items: readonly Record<string, unknown>[],
  source: readonly JobRequirementUnit[],
  where: string,
): Applied<JobRequirementUnit> {
  const bySource = sourceIds(source, where);
  const listed = new Set<string>();
  const out: JobRequirementUnit[] = [];
  const kept: string[] = [];
  const fixed: { id: string; fields: string[] }[] = [];
  const dropped: string[] = [];
  items.forEach((item, i) => {
    const at = `${where}: requirements[${i}]`;
    const verdict = item.owner_verdict;
    if (verdict === null || verdict === undefined) throw new Error(`${at}: owner_verdict is null; every item needs a verdict`);
    if (verdict === "add") throw new Error(`${at}: "add" is supported for Units only`);
    if (!(REQUIREMENT_VERDICTS as readonly unknown[]).includes(verdict)) {
      throw new Error(`${at}: owner_verdict must be one of ${REQUIREMENT_VERDICTS.join("|")} (got ${JSON.stringify(verdict)})`);
    }
    const id = item.id;
    if (typeof id !== "string" || !bySource.has(id)) {
      throw new Error(`${at}: id ${JSON.stringify(id)} is not a saved Requirement of the source flow`);
    }
    if (listed.has(id)) throw new Error(`${at}: Requirement ${id} is listed twice`);
    listed.add(id);
    const text = item.owner_corrected_text;
    const mustHave = item.owner_must_have;
    const hasText = text !== null && text !== undefined;
    const hasMustHave = mustHave !== null && mustHave !== undefined;
    if (hasText && !nonEmpty(text)) throw new Error(`${at}: owner_corrected_text must be a non-empty string`);
    if (hasMustHave && typeof mustHave !== "boolean") throw new Error(`${at}: owner_must_have must be true or false`);
    const before = bySource.get(id)!;
    if (verdict !== "fix") {
      // A value equal to the saved one confirms it; only `fix` changes an item.
      const differs = [
        ...(hasText && text !== before.normalized_requirement ? ["owner_corrected_text"] : []),
        ...(hasMustHave && mustHave !== before.must_have ? ["owner_must_have"] : []),
      ];
      if (differs.length > 0) {
        throw new Error(`${at}: ${differs.join("/")} differs from the saved value on a "${verdict}" Requirement; use "fix"`);
      }
    }
    const content = stripOwner(item);
    if (verdict === "drop") {
      dropped.push(id);
      return;
    }
    if (verdict === "keep") {
      const diff = changedFields(before, content);
      if (diff.length > 0) {
        throw new Error(
          `${at}: Requirement ${id} is marked keep but differs from the source flow in ${diff.join(", ")}; mark it fix`,
        );
      }
      out.push(content as unknown as JobRequirementUnit);
      kept.push(id);
      return;
    }
    const after = {
      ...content,
      ...(hasText && { normalized_requirement: text }),
      ...(hasMustHave && { must_have: mustHave }),
    };
    if (!nonEmpty(after.normalized_requirement)) throw new Error(`${at}: a fixed Requirement needs a normalized_requirement`);
    const fields = changedFields(before, after);
    if (fields.length === 0) throw new Error(`${at}: Requirement ${id} is marked fix but changes nothing`);
    out.push(after as unknown as JobRequirementUnit);
    fixed.push({ id, fields });
  });
  checkCoverage(where, "requirements", listed, bySource);
  return { items: out, provenance: { kept, fixed, dropped, added: [] } };
}

/**
 * The one record flow a corrections file was built from: same cell, and
 * its saved `side` ids include every non-added id in the file.
 */
export function resolveSourceFlow(flows: readonly FlowRecord[], corrections: LoadedCorrections, side: Side): FlowRecord {
  const items = corrections.file[side];
  if (items === undefined || items.length === 0) {
    throw new Error(`${corrections.path}: holds no ${side} to correct`);
  }
  const ids = items
    .filter((it) => it.owner_verdict !== "add")
    .map((it) => it.id)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) throw new Error(`${corrections.path}: no ${side} item names a saved id`);
  const matches = flows.filter((f) => {
    if (f.cell !== corrections.cell) return false;
    const saved = f[side];
    if (saved === null) return false;
    const savedIds = new Set(saved.map((x) => x.id));
    return ids.every((id) => savedIds.has(id));
  });
  if (matches.length === 0) {
    throw new Error(
      `${corrections.path}: no flow in --records for cell ${corrections.cell} saved ${side} with these ids. ` +
        "Pass the records directory the scaffold was built from.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${corrections.path}: ${matches.length} flows of cell ${corrections.cell} hold these ${side} ids ` +
        `(${matches.map((f) => `${f.variant}#${f.sampleIndex}`).join(", ")}); the source flow is ambiguous.`,
    );
  }
  return matches[0]!;
}
