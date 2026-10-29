/**
 * Arguments for `npm run eval:fixed-inputs` (#648). A closed flag set,
 * like `eval:analyze`: anything unknown is refused.
 *
 *   --records <dir...>                      records directories (or flows.jsonl paths); required
 *   --units record|gold|<corrections.json>  the alternative Units side (default record); a
 *                                           corrections path may repeat, one file per cell
 *   --requirements record|gold|<file.json>  the alternative Requirements side (default record)
 *   --scorer current,renormalized,cosine    comma list (default current)
 *   --k N                                   recall@N instead of the label's k
 *   --embeddings-cache <file>               outside the repository
 *   --out <dir>                             outside the repository
 *   --max-usd N                             embedding spend bound (default 0.10)
 *   --dry-run                               plan and estimate only; no client, no request
 */

import { isScorerName, SCORER_NAMES, type ScorerName } from "./scorers.ts";

export type SideArg =
  | { readonly kind: "record" }
  | { readonly kind: "gold" }
  | { readonly kind: "corrections"; readonly paths: readonly string[] };

export interface FixedInputArgs {
  readonly records: readonly string[];
  readonly units: SideArg;
  readonly requirements: SideArg;
  readonly scorers: readonly ScorerName[];
  readonly k?: number;
  readonly embeddingsCache?: string;
  readonly out?: string;
  readonly maxUsd: number;
  readonly dryRun: boolean;
}

export const DEFAULT_MAX_USD = 0.1;

const VALUE_FLAGS = new Set([
  "--records",
  "--units",
  "--requirements",
  "--scorer",
  "--k",
  "--embeddings-cache",
  "--out",
  "--max-usd",
]);
const BOOLEAN_FLAGS = new Set(["--dry-run"]);
const REPEATABLE = new Set(["--records", "--units", "--requirements"]);

function side(name: string, values: readonly string[]): SideArg {
  if (values.length === 0) return { kind: "record" };
  const keywords = values.filter((v) => v === "record" || v === "gold");
  if (keywords.length > 0) {
    if (values.length > 1) {
      throw new Error(`${name} takes record, gold, or one or more corrections files, not a mix (got ${values.join(", ")})`);
    }
    return { kind: keywords[0] as "record" | "gold" };
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} names the same corrections file twice`);
  return { kind: "corrections", paths: [...values] };
}

export function parseFixedInputArgs(argv: readonly string[]): FixedInputArgs {
  const multi = new Map<string, string[]>();
  const single = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new Error(`${name} takes no value`);
      dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown flag ${JSON.stringify(arg)}`);
    const values: string[] = [];
    if (eq !== -1) {
      values.push(arg.slice(eq + 1));
    } else if (name === "--records") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) values.push(argv[++i]!);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      values.push(argv[++i]!);
    }
    if (values.length === 0 || values.some((v) => v === "")) throw new Error(`${name} requires a value`);
    if (REPEATABLE.has(name)) {
      multi.set(name, [...(multi.get(name) ?? []), ...values]);
    } else {
      if (single.has(name)) throw new Error(`${name} given more than once`);
      single.set(name, values[0]!);
    }
  }
  const records = multi.get("--records") ?? [];
  if (records.length === 0) throw new Error("--records requires at least one directory");

  const scorerRaw = single.get("--scorer");
  const scorers = scorerRaw === undefined ? ["current"] : scorerRaw.split(",").map((s) => s.trim());
  for (const s of scorers) {
    if (!isScorerName(s)) throw new Error(`--scorer must be a comma list of ${SCORER_NAMES.join("|")} (got ${JSON.stringify(s)})`);
  }
  if (new Set(scorers).size !== scorers.length) throw new Error("--scorer names a scorer twice");

  const kRaw = single.get("--k");
  let k: number | undefined;
  if (kRaw !== undefined) {
    if (!/^\d+$/u.test(kRaw) || Number(kRaw) < 1) throw new Error(`--k must be a positive integer (got ${JSON.stringify(kRaw)})`);
    k = Number(kRaw);
  }
  const maxRaw = single.get("--max-usd");
  const maxUsd = maxRaw === undefined ? DEFAULT_MAX_USD : Number(maxRaw);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`--max-usd must be a positive number (got ${JSON.stringify(maxRaw)})`);

  return {
    records,
    units: side("--units", multi.get("--units") ?? []),
    requirements: side("--requirements", multi.get("--requirements") ?? []),
    scorers: scorers as ScorerName[],
    ...(k !== undefined && { k }),
    ...(single.has("--embeddings-cache") && { embeddingsCache: single.get("--embeddings-cache")! }),
    ...(single.has("--out") && { out: single.get("--out")! }),
    maxUsd,
    dryRun,
  };
}
