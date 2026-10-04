/**
 * The (owner, Role) matching run marker in `matchingRuns`, and the one
 * question the editor asks of it: may this Role's persisted matches
 * mix two scoring runs? (#504)
 *
 * A replacement that fits one commit is atomic, so a failed run there
 * leaves the previous set intact. Above `MATCH_WRITES_PER_COMMIT` the
 * replacement is chunked, and a run that dies between chunks leaves
 * some pairs rescored and the rest from the previous run. The marker
 * records that as `partial`: set by the first chunked commit, carried
 * into every later claim until a run completes, and cleared only by a
 * completed run. A Role is therefore "incomplete" while `partial` is
 * set and no run is plausibly still finishing.
 *
 * Written only by the matching pipeline (admin SDK); the owner may
 * read it (`firestore.rules`). Dependency-free so the app imports it
 * across the package boundary, as it does `../types/capability.ts`.
 */

export type MatchingRunState = "running" | "complete" | "failed";

export interface MatchingRunMarker {
  readonly owner_uid: string;
  readonly role_id: string;
  readonly run_id: string;
  readonly started_at: string;
  /** Absent on markers written before #504; read as complete. */
  readonly state?: MatchingRunState;
  /**
   * The persisted match set may mix runs: a chunked replacement
   * committed part of its writes and no run has completed since.
   */
  readonly partial?: boolean;
  readonly completed_at?: string;
  readonly failed_at?: string;
}

/**
 * True when the Role's matches may be a mix of two runs and nothing
 * is still converging them, so the user should re-run matching.
 *
 * A `running` marker is trusted only within `runTimeoutMs` of its
 * start: past the callable's timeout the run is dead (a crash or a
 * timeout never reaches the code that would mark it failed), and its
 * partial writes are what the user is looking at.
 */
export function isMatchingRunIncomplete(
  marker: MatchingRunMarker | null | undefined,
  nowMs: number,
  runTimeoutMs: number,
): boolean {
  if (marker === null || marker === undefined) return false;
  if (marker.partial !== true) return false;
  const state = marker.state ?? "complete";
  if (state === "complete") return false;
  if (state === "failed") return true;
  const started = Date.parse(marker.started_at);
  // An unparseable start cannot prove the run is alive.
  if (Number.isNaN(started)) return true;
  return nowMs - started > runTimeoutMs;
}
