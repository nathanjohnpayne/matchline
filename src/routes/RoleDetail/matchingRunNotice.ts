/**
 * When the Matches tab should tell the user the last matching run
 * left this Role's matches mixed (#504). The decision itself is
 * `isMatchingRunIncomplete` in the functions package, shared so the
 * server's marker semantics live in one place; this module adds the
 * client's clock: how long to trust a `running` marker, and when to
 * look again.
 */

import { CALLABLE_TIMEOUT_SECONDS } from "../../../functions/src/callables/timeouts.ts";
import type { MatchingRunMarker } from "../../../functions/src/matching/runMarker.ts";

/**
 * How long after `started_at` a `running` marker can still belong to a
 * live run: the callable's timeout (Cloud Run stops the instance
 * there) plus a margin for skew between the server clock that stamped
 * `started_at` and this browser's clock.
 */
export const MATCHING_RUN_LIVE_MS =
  CALLABLE_TIMEOUT_SECONDS.runMatching * 1000 + 30_000;

/**
 * Milliseconds until a `running`, `partial` marker passes
 * `MATCHING_RUN_LIVE_MS` and starts to read as incomplete, or `null`
 * when no future moment changes the answer (so no timer is needed).
 * Snapshots re-render on their own; this covers the one transition a
 * dead run never writes.
 */
export function msUntilMatchingRunPresumedDead(
  marker: MatchingRunMarker | null | undefined,
  nowMs: number,
  liveMs: number = MATCHING_RUN_LIVE_MS,
): number | null {
  if (marker === null || marker === undefined) return null;
  if (marker.partial !== true || marker.state !== "running") return null;
  const started = Date.parse(marker.started_at);
  if (Number.isNaN(started)) return null;
  const remaining = started + liveMs - nowMs;
  return remaining > 0 ? remaining : null;
}
