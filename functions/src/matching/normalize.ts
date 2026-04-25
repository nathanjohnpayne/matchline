/**
 * Canonical-vocabulary normalize() for the matching engine
 * (parent #20, sub-issue #96). Maps raw extracted/parsed terms
 * to canonical entries from the seed JSON files. Downstream
 * Jaccard scorers (#97) operate on already-normalized sets, so
 * matching is set-vs-set, not fuzzy string compare.
 *
 * Three concerns intentionally collapsed here:
 *
 *   1. **JSON loading.** Read the seed files once at first call;
 *      cached for the process lifetime. The seed shape is small
 *      (~200 entries across all three files) so the load is
 *      trivial.
 *   2. **Index building.** Convert each `{ canonical, synonyms }`
 *      entry into a single Map<lowercase-trimmed-key, canonical>
 *      that includes both the canonical form AND every synonym.
 *      O(1) lookup at runtime.
 *   3. **Lookup discipline.** Match is case-insensitive,
 *      whitespace-trimmed, and tolerant of common punctuation
 *      variants (curly quotes, en/em dashes). Returns the
 *      canonical form on hit; `null` on miss.
 *
 * The single-source-of-truth invariant is enforced by
 * `scripts/ci/check_no_other_skill_normalization` — no other
 * file may normalize skills/tools/domains via LLM or hand-rolled
 * regex. Risk #8 in the plan's risk register.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OntologyEntry {
  readonly canonical: string;
  readonly synonyms: readonly string[];
}

export interface OntologyData {
  readonly skills: readonly OntologyEntry[];
  readonly tools: readonly OntologyEntry[];
  readonly domains: readonly OntologyEntry[];
}

interface OntologyIndex {
  readonly skills: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, string>;
  readonly domains: ReadonlyMap<string, string>;
}

// Resolved ontology directory. Sibling to this module — both
// emitted into `functions/lib/matching/`. The .seed.json files
// are copied alongside via `functions/scripts/copy-md.mjs` (or
// equivalent) at build time.
function ontologyDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "ontology");
}

/**
 * Normalize a raw input string before matching: lowercase, trim,
 * collapse internal whitespace, and replace common typographic
 * punctuation variants with their ASCII equivalents.
 *
 * Exported so the seed-validation tests in normalize.test.ts
 * use the EXACT same key derivation as the runtime index. The
 * earlier version of those tests inlined a weaker normalizer
 * (no quote/dash folding), which let punctuation-variant
 * collisions slip past while still colliding at runtime —
 * Codex P3 round 2 on #102.
 */
export function normalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    // Curly quotes → straight
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // En-dash, em-dash → hyphen
    .replace(/[–—]/g, "-");
}

let cachedData: OntologyData | undefined;
let cachedIndex: OntologyIndex | undefined;

interface SeedFile {
  readonly entries: readonly OntologyEntry[];
}

function loadSeedFile(filename: string): readonly OntologyEntry[] {
  const path = join(ontologyDir(), filename);
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as SeedFile;
  if (!Array.isArray(parsed.entries)) {
    throw new Error(
      `Ontology seed ${filename}: malformed — missing "entries" array`,
    );
  }
  // Validate shape — every entry must have a non-empty canonical
  // string (after trim — whitespace-only normalizes to an empty
  // lookup key, making the entry silently unmatchable; Codex P2
  // round 4 on #102) and a synonyms array (which may be empty).
  for (const entry of parsed.entries) {
    if (
      typeof entry.canonical !== "string" ||
      normalizeKey(entry.canonical).length === 0
    ) {
      throw new Error(
        `Ontology seed ${filename}: entry has empty or whitespace-only canonical (raw=${JSON.stringify(entry.canonical)})`,
      );
    }
    if (!Array.isArray(entry.synonyms)) {
      throw new Error(
        `Ontology seed ${filename}: entry "${entry.canonical}" has non-array synonyms`,
      );
    }
  }
  return parsed.entries;
}

/**
 * Load all three seed files. Cached for the process lifetime —
 * the seeds are small and deterministic. Tests can call
 * `resetOntologyCache()` between cases if they need a clean
 * slate (e.g. to swap in a fixture).
 */
export function loadOntology(): OntologyData {
  if (cachedData !== undefined) return cachedData;
  cachedData = {
    skills: loadSeedFile("skills.seed.json"),
    tools: loadSeedFile("tools.seed.json"),
    domains: loadSeedFile("domains.seed.json"),
  };
  return cachedData;
}

function buildIndex(entries: readonly OntologyEntry[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    const canonicalKey = normalizeKey(entry.canonical);
    index.set(canonicalKey, entry.canonical);
    for (const syn of entry.synonyms) {
      const synKey = normalizeKey(syn);
      // First-write-wins on synonym collision — if two entries
      // claim the same synonym, only the first wins. This is a
      // data-curation issue worth flagging in tests, but at
      // runtime we just take the first.
      if (!index.has(synKey)) {
        index.set(synKey, entry.canonical);
      }
    }
  }
  return index;
}

function getIndex(): OntologyIndex {
  if (cachedIndex !== undefined) return cachedIndex;
  const data = loadOntology();
  cachedIndex = {
    skills: buildIndex(data.skills),
    tools: buildIndex(data.tools),
    domains: buildIndex(data.domains),
  };
  return cachedIndex;
}

/**
 * Reset the in-memory ontology + index cache. Tests use this to
 * pin behavior with a fresh load or to swap in a fixture seed.
 * Production code should never call this.
 */
export function resetOntologyCache(): void {
  cachedData = undefined;
  cachedIndex = undefined;
}

function lookup(map: ReadonlyMap<string, string>, raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const key = normalizeKey(raw);
  if (key.length === 0) return null;
  return map.get(key) ?? null;
}

/**
 * Map a raw skill string (as extracted by the LLM or typed by
 * the user) to its canonical form. Returns `null` for
 * unrecognized inputs — the caller decides what to do
 * (typically: surface as an "ontology-expansion candidate" for
 * later curation, per the parent ticket).
 */
export function normalizeSkill(raw: string): string | null {
  return lookup(getIndex().skills, raw);
}

export function normalizeTool(raw: string): string | null {
  return lookup(getIndex().tools, raw);
}

export function normalizeDomain(raw: string): string | null {
  return lookup(getIndex().domains, raw);
}
