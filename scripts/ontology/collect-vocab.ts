/**
 * Ontology vocabulary-collection tool (#159).
 *
 * Budget-free coverage diagnostic. Harvests the skills / tools /
 * domains vocabulary the *labeled* corpus uses
 * (`tests/fixtures/expected-units/*.json`), runs every term through
 * the canonical normalize() layer, and reports which terms the seed
 * ontology does NOT recognize (normalize → `null`). Those null terms
 * are the expansion candidates for the `*.seed.json` files.
 *
 * Why the labeled fixtures, not a live extraction run:
 *   - The `expected_units` labels are the curated ground-truth
 *     vocabulary the eval scores against. Harvesting them is
 *     deterministic and costs nothing (no LLM calls, no API budget).
 *   - The live extraction pipeline emits near-identical unit vocab
 *     (see the #159 diagnostic: "platform launch", "Fire TV", "NCP",
 *     "Linux" all appear verbatim on both the labeled and live sides),
 *     so closing the labeled-side gap closes most of the live-side gap
 *     too. Paraphrases the live model invents land as synonyms during
 *     curation.
 *
 * Scope note: this covers the *unit* side (skills/tools/domains). The
 * *requirement* side keywords come from live JD parsing
 * (`requirement.keywords`), which the labeled `expected_requirements`
 * do not carry — that harvest needs a paid parser run and is tracked
 * as a follow-up slice of #159.
 *
 * Usage:
 *   npm run ontology:collect              # all 10 labeled resumes
 *   npm run ontology:collect -- nathan-2026 dimitri-wireless-ran-engineer-2026
 *
 * The single-source-of-truth invariant
 * (`scripts/ci/check_no_other_skill_normalization`) is respected:
 * this tool only *imports* the normalizers — it neither defines them
 * nor reads the seed JSON directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeDomain,
  normalizeSkill,
  normalizeTool,
} from "../../functions/src/matching/normalize.js";

type Category = "skills" | "tools" | "domains";

const CATEGORIES: readonly Category[] = ["skills", "tools", "domains"];

const NORMALIZERS: Record<Category, (raw: string) => string | null> = {
  skills: normalizeSkill,
  tools: normalizeTool,
  domains: normalizeDomain,
};

const EXPECTED_UNITS_DIR = join(
  process.cwd(),
  "tests",
  "fixtures",
  "expected-units",
);

/** term → set of fixture IDs the term appears in, per category. */
type VocabIndex = Record<Category, Map<string, Set<string>>>;

interface ExpectedUnitFile {
  readonly expected_units?: ReadonlyArray<{
    readonly skills?: readonly string[];
    readonly tools?: readonly string[];
    readonly domains?: readonly string[];
  }>;
}

/**
 * Walk the labeled `expected-units` fixtures and bucket every unique
 * skill / tool / domain term, tracking which fixtures it came from.
 * Pass `fixtureIds` to scope to a subset (e.g. the four labeled-match
 * cells) — an empty/undefined list means all fixtures.
 */
function collectVocab(fixtureIds?: readonly string[]): VocabIndex {
  const files = readdirSync(EXPECTED_UNITS_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter(
      (f) =>
        !fixtureIds ||
        fixtureIds.length === 0 ||
        fixtureIds.includes(f.replace(/\.json$/, "")),
    );

  if (files.length === 0) {
    throw new Error(
      `collect-vocab: no matching fixtures in ${EXPECTED_UNITS_DIR}` +
        (fixtureIds && fixtureIds.length > 0
          ? ` for ids [${fixtureIds.join(", ")}]`
          : ""),
    );
  }

  const index: VocabIndex = {
    skills: new Map(),
    tools: new Map(),
    domains: new Map(),
  };

  for (const file of files) {
    const fixtureId = file.replace(/\.json$/, "");
    const data = JSON.parse(
      readFileSync(join(EXPECTED_UNITS_DIR, file), "utf8"),
    ) as ExpectedUnitFile;
    for (const unit of data.expected_units ?? []) {
      for (const cat of CATEGORIES) {
        for (const term of unit[cat] ?? []) {
          const bucket = index[cat];
          const sources = bucket.get(term) ?? new Set<string>();
          sources.add(fixtureId);
          bucket.set(term, sources);
        }
      }
    }
  }

  return index;
}

interface CategoryReport {
  readonly category: Category;
  readonly total: number;
  readonly recognized: number;
  readonly nullTerms: ReadonlyArray<{ term: string; sources: number }>;
}

function analyze(index: VocabIndex): CategoryReport[] {
  return CATEGORIES.map((category) => {
    const normalize = NORMALIZERS[category];
    const entries = [...index[category].entries()];
    const nullTerms = entries
      .filter(([term]) => normalize(term) === null)
      .map(([term, sources]) => ({ term, sources: sources.size }))
      .sort((a, b) => b.sources - a.sources || a.term.localeCompare(b.term));
    return {
      category,
      total: entries.length,
      recognized: entries.length - nullTerms.length,
      nullTerms,
    };
  });
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;
}

function main(): void {
  const fixtureIds = process.argv.slice(2);
  const index = collectVocab(fixtureIds);
  const reports = analyze(index);

  const scope =
    fixtureIds.length > 0 ? fixtureIds.join(", ") : "all labeled resumes";
  console.log(`Ontology coverage diagnostic (#159) — scope: ${scope}\n`);

  let totalTerms = 0;
  let totalNull = 0;
  for (const r of reports) {
    totalTerms += r.total;
    totalNull += r.nullTerms.length;
    console.log(
      `${r.category.toUpperCase().padEnd(8)} ` +
        `coverage ${pct(r.recognized, r.total).padStart(6)} ` +
        `(${r.recognized}/${r.total} recognized, ${r.nullTerms.length} null)`,
    );
    for (const { term, sources } of r.nullTerms) {
      console.log(`    null  ${term}  ×${sources}`);
    }
    console.log("");
  }

  console.log(
    `AGGREGATE null-rate ${pct(totalNull, totalTerms)} ` +
      `(${totalNull}/${totalTerms} terms unrecognized)`,
  );
}

main();
