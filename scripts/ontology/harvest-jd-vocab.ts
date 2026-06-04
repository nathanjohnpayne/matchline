/**
 * JD-side vocabulary harvest (#258). **PAID — makes live LLM calls.**
 *
 * The budget-free `collect-vocab.ts` can only see the *unit* side
 * (skills/tools/domains from the labeled `expected-units` fixtures).
 * The matching engine scores `jaccard(unit.skills, requirement.keywords)`
 * etc. (see `functions/src/matching/score.ts`), and the requirement side
 * (`requirement.keywords` / `.tools` / `.domains`) is produced by the
 * live JD parser — it is NOT present in the labeled `expected-matches`
 * fixtures, which carry only requirement `text`/`category`. So the only
 * way to learn what JD-side vocabulary the engine actually compares
 * against is to run the parser.
 *
 * This script runs `parseJobRequirements` on labeled JD fixtures, then
 * reports which emitted keywords/tools/domains the canonical
 * `normalize()` layer does NOT recognize — the JD-side expansion
 * candidates. Those become synonym bridges in the seed ontology so the
 * unit canonicals and live JD keywords share a canonical form and the
 * structural-overlap axes actually fire.
 *
 * Mapping note: `requirement.keywords` is normalized with
 * `normalizeSkill` (score.ts `skillOverlap`), `.tools` with
 * `normalizeTool`, `.domains` with `normalizeDomain`.
 *
 * Requires `ANTHROPIC_API_KEY` in the environment. Each JD ≈ one paid
 * parse (~$0.03–0.10).
 *
 * Usage:
 *   npm run ontology:harvest-jd -- google-compute-spm-2026
 *   npm run ontology:harvest-jd -- google-compute-spm-2026 dolby-pm-xr-devices-2026
 */

import { normalizeDomain, normalizeSkill, normalizeTool } from "../../functions/src/matching/normalize.js";
import { parseJobRequirements } from "../../functions/src/parsing/jd.js";
import { anthropicForCli } from "../../functions/src/llm/anthropic.js";
import { loadJdText } from "../../tests/eval/loadFixtures.js";

// Requirement field → the normalizer the matching engine uses for it.
const FIELD_NORMALIZER = {
  keywords: normalizeSkill,
  tools: normalizeTool,
  domains: normalizeDomain,
} as const;

type Field = keyof typeof FIELD_NORMALIZER;
const FIELDS: readonly Field[] = ["keywords", "tools", "domains"];

// Fixture ids are flat slugs (e.g. "google-compute-spm-2026"). Validate
// before passing CLI input to loadJdText, which builds a path with
// `join(.., `${id}.txt`)` — an id like "../../.env" would escape the
// fixtures dir and (worse) get uploaded to the LLM. Reject anything
// outside the known slug charset. (CodeRabbit on #261.)
const FIXTURE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// In-memory no-op usage recorder — same shape the eval harness uses to
// avoid a Firestore dependency on the CLI path.
const noopRecord = async (): Promise<number> => 0;

async function main(): Promise<void> {
  const jdIds = process.argv.slice(2);
  if (jdIds.length === 0) {
    console.error(
      "usage: npm run ontology:harvest-jd -- <jd-fixture-id> [<jd-fixture-id>...]",
    );
    process.exit(1);
  }

  const client = anthropicForCli(); // throws clearly if ANTHROPIC_API_KEY is unset

  // field -> term -> occurrence count across all parsed JDs
  const agg: Record<Field, Map<string, number>> = {
    keywords: new Map(),
    tools: new Map(),
    domains: new Map(),
  };

  for (const jdId of jdIds) {
    if (!FIXTURE_ID_RE.test(jdId)) {
      throw new Error(
        `Invalid JD fixture id ${JSON.stringify(jdId)}. Expected a lowercase slug like "google-compute-spm-2026".`,
      );
    }
    const text = loadJdText(jdId);
    const reqs = await parseJobRequirements(
      text,
      { ownerUid: "harvest", roleId: jdId },
      { client, record: noopRecord },
    );
    console.log(`${jdId}: ${reqs.length} requirements parsed`);
    for (const r of reqs) {
      for (const field of FIELDS) {
        for (const term of r[field] ?? []) {
          agg[field].set(term, (agg[field].get(term) ?? 0) + 1);
        }
      }
    }
  }

  let totalAll = 0;
  let totalNull = 0;
  for (const field of FIELDS) {
    const normalize = FIELD_NORMALIZER[field];
    const all = [...agg[field].keys()];
    const nulls = all
      .filter((t) => normalize(t) === null)
      .sort((a, b) => (agg[field].get(b)! - agg[field].get(a)!) || a.localeCompare(b));
    totalAll += all.length;
    totalNull += nulls.length;
    const cov = all.length === 0 ? "n/a" : `${(((all.length - nulls.length) / all.length) * 100).toFixed(0)}%`;
    console.log(
      `\n=== ${field.toUpperCase()} (via ${normalize.name}) === unique=${all.length} null=${nulls.length} coverage=${cov}`,
    );
    for (const t of nulls) console.log(`    null  ${t}  ×${agg[field].get(t)}`);
  }
  const rate = totalAll === 0 ? "n/a" : `${((totalNull / totalAll) * 100).toFixed(1)}%`;
  console.log(`\n=== AGGREGATE JD-side null-rate ${rate} (${totalNull}/${totalAll} unrecognized) ===`);
}

main().catch((err) => {
  console.error("harvest-jd-vocab failed:", err);
  process.exit(2);
});
