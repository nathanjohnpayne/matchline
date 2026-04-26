/**
 * Role Detail container. Wires Firestore subscriptions
 * (Role one-shot, Requirements + Matches + Units
 * snapshot-subscribed) into a `RoleDetailView` (#21 /
 * sub-issue #129).
 *
 * Container/view split mirrors UnitReview (#86): the view's
 * rendering shape is exercised in isolation with
 * `renderToStaticMarkup` so we don't have to mock Firebase.
 *
 * Subscription lifecycle:
 *   - On mount with a roleId: status = "loading". Fetch the
 *     Role doc (one-shot), open Requirements + Matches +
 *     Units subscriptions in parallel.
 *   - On Role doc resolved (existence + ownership) AND
 *     Requirements first snapshot: status = "ready".
 *     Subsequent Matches + Units snapshots flow into state
 *     without flipping status (the loading state is gated
 *     on the Role + Requirements pair because those are the
 *     load-bearing axes; Matches arriving slightly later
 *     just renders empty match rows briefly).
 *   - On any error: status = "error", error = err.
 *   - On unmount or roleId change: call all 3 unsubscribe
 *     cleanups + cancel the in-flight Role fetch (handled
 *     via a stale-closure guard on the role_id).
 *
 * Why fetch Role one-shot instead of subscribing: a Role's
 * core fields (title, jd_raw) don't change after creation;
 * Requirements + Matches are the dynamic axes. Saving a
 * subscription's overhead matters more on Roles than Units
 * because the user typically opens many Roles.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useParams } from "react-router-dom";

import { subscribeByOwner as subscribeUnitsByOwner } from "../../services/experienceUnits.ts";
import {
  subscribeRequirementsForRole,
  getRole,
} from "../../services/roles.ts";
import {
  invokeRunMatching,
  setMatchApprovalState,
  subscribeMatchesByRole,
  type MatchApprovalState,
} from "../../services/matches.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";
import type { Role } from "../../types/crm.ts";

import RoleDetailView, { type LoadState, type Tab } from "./RoleDetailView.tsx";

export default function RoleDetail(): ReactElement {
  const { roleId } = useParams<{ roleId: string }>();
  const [status, setStatus] = useState<LoadState>("loading");
  const [role, setRole] = useState<Role | null>(null);
  const [requirements, setRequirements] = useState<readonly JobRequirementUnit[]>([]);
  const [matches, setMatches] = useState<readonly UnitMatch[]>([]);
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("matches");
  // Auto-trigger state (#131). Distinguishes the
  // pre-first-snapshot wait, the in-flight matching call,
  // and the post-completion subscription delivery.
  // Idempotency lives on a ref (not state) so a re-render
  // doesn't re-fire the trigger and so the latest value is
  // always read inside async closures.
  const [computingMatches, setComputingMatches] = useState(false);
  const triggeredRef = useRef(false);

  const onTabChange = useCallback((tab: Tab) => setActiveTab(tab), []);

  // Single-setter approval handler (#130 + cursor #133 r1).
  // Each click produces ONE `setMatchApprovalState` write,
  // not a pair. Per-doc per-client Firestore write ordering
  // guarantees the LAST submitted write wins
  // deterministically — no out-of-order race across
  // offline resync, multi-tab, or rapid double-clicks.
  //
  // Fire-and-forget: the Firestore subscription's next
  // snapshot delivers the resolved state; failed writes
  // (rules deny, transport down) are logged but not
  // surfaced. Phase 2 UX adds toast notifications;
  // deferred per #21 spec.
  const onApprovalStateChange = useCallback(
    (matchId: string, state: MatchApprovalState) => {
      void setMatchApprovalState(matchId, state).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn("setMatchApprovalState failed", err);
      });
    },
    [],
  );

  useEffect(() => {
    if (roleId === undefined || roleId === "") {
      // No id in the URL — treat as not-found rather than
      // silently sticking on "loading."
      setStatus("ready");
      setRole(null);
      return;
    }

    // Reset on every (re-)mount to a new roleId.
    setStatus("loading");
    setRole(null);
    setRequirements([]);
    setMatches([]);
    setError(null);
    // Reset auto-trigger guard so a new Role gets its own
    // first-empty-snapshot trigger evaluation.
    triggeredRef.current = false;
    setComputingMatches(false);

    // Stale-closure guard. If the user navigates to a new
    // roleId before the in-flight Role fetch resolves, we
    // ignore the late response. Same shape as React Query's
    // identity check, but written by hand because we only
    // need it once.
    let active = true;
    let unsubReqs: (() => void) | null = null;
    let unsubMatches: (() => void) | null = null;
    let unsubUnits: (() => void) | null = null;

    void (async () => {
      try {
        const r = await getRole(roleId);
        if (!active) return;
        if (r === undefined) {
          // Anti-enumeration: rules at the data layer
          // already collapse missing-OR-not-yours into a
          // single "no permission" path; this just renders
          // the not-found state when the doc doesn't come
          // back.
          setRole(null);
          setStatus("ready");
          return;
        }
        setRole(r);

        // Open the three subscriptions in parallel. We flip
        // status to "ready" on the FIRST Requirements
        // snapshot — Matches and Units may still be in
        // flight, but the Role + Requirements pair is what
        // determines whether the tab can render meaningfully.
        let firstReqsSnapshot = true;
        unsubReqs = subscribeRequirementsForRole(
          roleId,
          (next) => {
            if (!active) return;
            setRequirements(next);
            if (firstReqsSnapshot) {
              firstReqsSnapshot = false;
              setStatus("ready");
            }
          },
          (err) => {
            if (!active) return;
            setRequirements([]);
            setError(err);
            setStatus("error");
          },
        );
        unsubMatches = subscribeMatchesByRole(
          roleId,
          (next) => {
            if (!active) return;
            setMatches(next);
          },
          (err) => {
            if (!active) return;
            setMatches([]);
            setError(err);
            setStatus("error");
          },
        );
        unsubUnits = subscribeUnitsByOwner(
          (next) => {
            if (!active) return;
            setUnits(next);
          },
          (err) => {
            if (!active) return;
            setUnits([]);
            setError(err);
            setStatus("error");
          },
        );
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    })();

    return () => {
      active = false;
      unsubReqs?.();
      unsubMatches?.();
      unsubUnits?.();
    };
  }, [roleId]);

  // Auto-trigger matching when the user lands on a Role
  // that has Requirements but no matches yet (#131).
  //
  // Gates:
  //   - status must be "ready" (Role + Requirements
  //     resolved; we know the Role exists).
  //   - requirements.length > 0 (no point computing matches
  //     against zero Requirements).
  //   - matches.length === 0 (no existing matches; rerun
  //     would just be a no-op).
  //   - triggeredRef.current === false (idempotency: only
  //     fire ONCE per Role mount; subsequent snapshots that
  //     drop matches to zero — e.g. user rejected
  //     everything — do NOT re-trigger).
  //
  // Per spec: a second mount with already-populated matches
  // does NOT re-trigger. We set `triggeredRef.current =
  // true` after the first non-empty snapshot OR after we
  // fire the trigger ourselves, so either path closes the
  // window.
  useEffect(() => {
    if (status !== "ready" || roleId === undefined || roleId === "") return;
    if (triggeredRef.current) return;
    if (matches.length > 0) {
      // First non-empty snapshot → don't trigger. Mark as
      // handled so a future drop to zero doesn't fire.
      triggeredRef.current = true;
      return;
    }
    if (requirements.length === 0) {
      // No Requirements → matching has nothing to score
      // against. Don't trigger. Don't mark triggered yet —
      // if Requirements arrive later (parsing pipeline runs
      // on the same Role), we want to evaluate again.
      return;
    }
    // First-empty-snapshot with Requirements → trigger.
    triggeredRef.current = true;
    setComputingMatches(true);
    void invokeRunMatching(roleId)
      .catch((err: unknown) => {
        // Subscription delivers the new matches on success;
        // failures log + un-set the loading state. Phase 2
        // surfaces a toast; deferred per #21 spec.
        // eslint-disable-next-line no-console
        console.warn("invokeRunMatching failed", err);
      })
      .finally(() => {
        setComputingMatches(false);
      });
  }, [status, roleId, matches.length, requirements.length]);

  // Build the unit lookup once per units array. The matching
  // pipeline reads units owner-scoped and the Role's matches
  // can only reference the user's own units, so a single
  // user-wide lookup is fine.
  const unitsById = new Map<string, ExperienceUnit>(
    units.map((u) => [u.id, u]),
  );

  return (
    <RoleDetailView
      status={status}
      role={role}
      requirements={requirements}
      matches={matches}
      unitsById={unitsById}
      error={error}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onApprovalStateChange={onApprovalStateChange}
      computingMatches={computingMatches}
    />
  );
}
