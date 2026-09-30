/**
 * Write the Firestore owner allowlist, `config/access`, from the same
 * value the callables use (`MATCHLINE_OWNER_UIDS`). Part of the deploy
 * procedure in DEPLOYMENT.md § Owner allowlist; run it BEFORE deploying
 * `firestore.rules`.
 *
 *   npx tsx functions/scripts/set-owner-allowlist.ts --project matchline-dev
 *   npx tsx functions/scripts/set-owner-allowlist.ts --project matchline-dev --dry-run
 *
 * By default the uids come from `functions/.env.<project>` — the file
 * the functions deploy reads — so the two allowlist layers cannot
 * drift. `--uids a,b` overrides that.
 *
 * **Full overwrite, on purpose.** Before these rules are deployed, the
 * previous catch-all rule let any signed-in user create documents in
 * any collection, `config/` included. `set()` without `merge` replaces
 * the whole document, so anything written there beforehand is
 * discarded, and the script reads the document back and fails unless
 * it holds exactly the configured uids.
 *
 * Credentials: Application Default Credentials (e.g.
 * `GOOGLE_APPLICATION_CREDENTIALS`), the same source `op-firebase-deploy`
 * resolves. `FIRESTORE_EMULATOR_HOST` targets the emulator instead.
 *
 * Lives under `functions/` so `firebase-admin` resolves from the
 * functions package, the copy the rest of the server code uses.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const ACCESS_DOC_PATH = "config/access";
export const OWNER_UIDS_ENV = "MATCHLINE_OWNER_UIDS";

/** Parse a comma-separated uid list; trims, drops empties, dedupes. */
export function parseUidList(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}

/**
 * Read `MATCHLINE_OWNER_UIDS` from dotenv-format text. Supports the
 * forms the Firebase CLI writes: `KEY=value`, optionally quoted.
 */
export function uidsFromEnvText(text: string): string[] {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?MATCHLINE_OWNER_UIDS\s*=\s*(.*)$/);
    if (m === null) continue;
    let value = m[1]!.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    return parseUidList(value);
  }
  return [];
}

/**
 * Overwrite `config/access` with exactly `ownerUids`, then read it back
 * and throw unless it holds exactly that list. Refuses an empty list:
 * that would lock the owner out rather than configure anything.
 */
export async function writeOwnerAllowlist(
  db: Firestore,
  ownerUids: readonly string[],
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  if (ownerUids.length === 0) {
    throw new Error(`Refusing to write an empty allowlist to ${ACCESS_DOC_PATH}.`);
  }
  const ref = db.doc(ACCESS_DOC_PATH);
  // No `merge`: replace the whole document, discarding any field a
  // client may have written before the rules closed `config/`.
  await ref.set({ owner_uids: [...ownerUids], updated_at: now() });

  const snap = await ref.get();
  const data = snap.data() ?? {};
  const stored = data.owner_uids;
  const keys = Object.keys(data).sort();
  const exact =
    Array.isArray(stored) &&
    stored.length === ownerUids.length &&
    stored.every((uid, i) => uid === ownerUids[i]) &&
    keys.join(",") === "owner_uids,updated_at";
  if (!exact) {
    throw new Error(
      `${ACCESS_DOC_PATH} read back with unexpected content; do not deploy the rules.`,
    );
  }
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: readonly string[]): Promise<void> {
  const project = argValue(argv, "--project");
  if (project === undefined || project.length === 0) {
    throw new Error("usage: set-owner-allowlist.ts --project <projectId> [--uids a,b] [--dry-run]");
  }
  let uids = parseUidList(argValue(argv, "--uids"));
  if (uids.length === 0) {
    const functionsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const envPath = join(functionsDir, `.env.${project}`);
    uids = uidsFromEnvText(readFileSync(envPath, "utf8"));
    if (uids.length === 0) {
      throw new Error(`${OWNER_UIDS_ENV} is not set in ${envPath}.`);
    }
  }
  // Print counts, not uids: this output lands in terminals and logs.
  console.log(`${ACCESS_DOC_PATH} <- ${uids.length} owner uid(s) (project ${project})`);
  if (argv.includes("--dry-run")) return;

  if (getApps().length === 0) initializeApp({ projectId: project });
  await writeOwnerAllowlist(getFirestore(), uids);
  console.log(`${ACCESS_DOC_PATH} written and verified.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
