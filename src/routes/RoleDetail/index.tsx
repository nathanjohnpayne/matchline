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
import { useNavigate, useParams } from "react-router-dom";

import {
  subscribeApplicationsForRole,
  upsertApplication,
} from "../../services/applications.ts";
import { subscribeByOwner as subscribeUnitsByOwner } from "../../services/experienceUnits.ts";
import {
  subscribeRequirementsForRole,
  getRole,
  upsertRole,
} from "../../services/roles.ts";
import {
  invokeRunMatching,
  setMatchApprovalState,
  subscribeMatchesByRole,
  type MatchApprovalState,
} from "../../services/matches.ts";
import { invokeGenerateResume } from "../../services/generation.ts";
import { invokeParseJobRequirements } from "../../services/requirements.ts";
import type {
  ExperienceUnit,
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";
import type { Application, Role } from "../../types/crm.ts";

import RoleDetailView, { type LoadState, type Tab } from "./RoleDetailView.tsx";
import type { ApplicationsTabStatus } from "./ApplicationsTab.tsx";
import type { RequirementsTabStatus } from "./RequirementsTab.tsx";
import { shouldAutoTriggerMatching } from "./autoTriggerGate.ts";

export default function RoleDetail(): ReactElement {
  const { roleId } = useParams<{ roleId: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<LoadState>("loading");
  const [role, setRole] = useState<Role | null>(null);
  const [requirements, setRequirements] = useState<readonly JobRequirementUnit[]>([]);
  const [matches, setMatches] = useState<readonly UnitMatch[]>([]);
  const [units, setUnits] = useState<readonly ExperienceUnit[]>([]);
  const [applications, setApplications] = useState<readonly Application[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("matches");

  // Applications tab state (#202). Held at the container so a
  // tab switch + return doesn't drop the in-flight or error
  // state. Same shape as the auto-trigger UX state — a state
  // machine + an optional Error.
  const [generationStatus, setGenerationStatus] =
    useState<ApplicationsTabStatus>("editing");
  const [generationError, setGenerationError] = useState<Error | null>(null);
  // Stale-closure guard for the async generate path. Mirrors
  // the `active` flag pattern used in the main subscription
  // effect — but ref-based so the resolved promise reads the
  // LATEST roleId across renders, not the closure's captured
  // value. Without this, the in-flight call for Role A would
  // navigate to /applications/:newAppId on completion even
  // after the user navigated to Role B.
  const currentRoleIdRef = useRef<string | undefined>(roleId);
  useEffect(() => {
    currentRoleIdRef.current = roleId;
  }, [roleId]);
  // Auto-trigger state (#131). Distinguishes the
  // pre-first-snapshot wait, the in-flight matching call,
  // and the post-completion subscription delivery.
  // Idempotency lives on a ref (not state) so a re-render
  // doesn't re-fire the trigger and so the latest value is
  // always read inside async closures.
  const [computingMatches, setComputingMatches] = useState(false);
  // Two-state gate (cursor #134 r1):
  //   - `matchesFirstSnapshotReceived` flips on the first
  //     real Matches snapshot delivery for the current Role.
  //     Without this, the auto-trigger evaluates against
  //     `matches.length === 0` while the subscription is
  //     still in flight and would fire against a Role with
  //     persisted matches that just haven't arrived yet.
  //   - `triggeredRef` is the idempotency guard — flips on
  //     either firing the trigger OR observing a non-empty
  //     first matches snapshot. Both close the "fires once
  //     per mount" window.
  const [matchesFirstSnapshotReceived, setMatchesFirstSnapshotReceived] =
    useState(false);
  const triggeredRef = useRef(false);

  // Requirements tab parse state (#201). Held at the
  // container so a tab switch + return doesn't drop the
  // in-flight or error state. The `currentRoleIdRef` above
  // serves both #201 (parse + save stale-closure guard) and
  // #202 (generate stale-closure guard) — same shape, one
  // ref tracks the CURRENT roleId across renders so any
  // resolved callback can compare against the latest target
  // rather than the captured-stale closure value.
  const [parsingStatus, setParsingStatus] =
    useState<RequirementsTabStatus>("editing");
  const [parseError, setParseError] = useState<Error | null>(null);
  const [savingJd, setSavingJd] = useState(false);

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

  // Save the textarea contents to Role.jd_raw via upsertRole.
  // Optimistically update local Role state so the textarea
  // dirty-check (draft === jd_raw) clears immediately; the
  // Role doc is one-shot fetched (not subscribed) so we need
  // to keep our local copy in sync after a save. Same shape
  // as inline-edit elsewhere in the app.
  const onSaveJd = useCallback(
    (text: string): void => {
      if (role === null) return;
      const next: Role = { ...role, jd_raw: text };
      // Capture the role id this save was issued against.
      // If the user navigates away before upsertRole resolves,
      // the stale-closure check below skips the state writes
      // so Role B doesn't inherit Role A's save error.
      const issuedAgainst = role.id;
      setSavingJd(true);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { owner_uid: _ownerUid, ...rest } = next;
      void upsertRole(rest)
        .then(() => {
          if (currentRoleIdRef.current !== issuedAgainst) return;
          setRole(next);
          // Clear any prior parse/save error so a successful
          // retry doesn't leave the inline banner visible
          // forever (Codex P2 round 2 on PR #206). The same
          // pattern applies inside onParseJd's success path.
          setParseError(null);
          setParsingStatus("editing");
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn("upsertRole failed", err);
          if (currentRoleIdRef.current !== issuedAgainst) return;
          // Prefix the message so the inline error banner makes
          // it clear the save failed, not a parse — same banner
          // surface, but the user knows which action errored
          // (CodeRabbit nit on PR #206). A separate `saveError`
          // state is cleaner but the unified banner keeps the
          // tab's footer simple at V1; revisit if save failures
          // become common enough to warrant their own surface.
          const message = err instanceof Error ? err.message : String(err);
          setParseError(new Error(`Save failed: ${message}`));
          setParsingStatus("error");
        })
        .finally(() => {
          if (currentRoleIdRef.current !== issuedAgainst) return;
          setSavingJd(false);
        });
    },
    [role],
  );

  // Persist the textarea contents (so the user's edits are
  // durable) THEN call the parse callable. The callable
  // reads owned-Role + applies its own retry budget, so on
  // success the subscription delivers the new Requirements;
  // failures surface inline + leave the user free to retry.
  const onParseJd = useCallback(
    (text: string): void => {
      if (roleId === undefined || roleId === "" || role === null) return;
      // Capture the role this parse was issued against. If
      // the user navigates to a different Role before the
      // callable resolves, the comparisons below skip the
      // state writes so the new Role's view doesn't show
      // the old Role's parse outcome (Codex P2 on PR #206).
      const issuedAgainst = roleId;
      setParsingStatus("parsing");
      setParseError(null);
      const trimmed = text.trim();
      const next: Role = { ...role, jd_raw: text };
      void (async () => {
        try {
          // Persist the JD first so a parse failure doesn't
          // strand the user's edits. upsertRole is a merge
          // setDoc, so the rest of the Role doc is unchanged.
          if (text !== role.jd_raw) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { owner_uid: _o, ...rest } = next;
            await upsertRole(rest);
            if (currentRoleIdRef.current === issuedAgainst) {
              setRole(next);
            }
          }
          await invokeParseJobRequirements(roleId, trimmed);
          // Subscription delivers the parsed Requirements;
          // flip back to editing on success and clear any
          // prior error so a successful retry hides the
          // inline banner.
          if (currentRoleIdRef.current !== issuedAgainst) return;
          setParseError(null);
          setParsingStatus("editing");

          // Re-parse replaces Requirements atomically (the
          // pipeline's clear-and-replace at
          // `functions/src/parsing/pipeline.ts:83` drops the
          // prior set) — but existing UnitMatches still
          // reference the OLD requirement IDs and remain in
          // Firestore. The auto-trigger gate (#131) is closed
          // because matches.length > 0 (stale rows), so
          // matching wouldn't recompute on its own. Fire a
          // fresh `runMatching` here so the matcher's
          // replace-by-(role,owner) (#99) drops the orphans
          // and lands matches against the new requirement
          // IDs. Codex Phase 4b finding on PR #206.
          //
          // Set `triggeredRef.current = true` BEFORE invoking
          // so the auto-trigger effect (#131) doesn't also
          // fire when the new Requirements snapshot lands
          // with `matches.length === 0` (first-parse case:
          // no prior matches existed, so the gate would
          // otherwise see an empty match set + non-empty
          // requirements and launch a duplicate call). Codex
          // round 2 Phase 4b on PR #206.
          //
          // Fire-and-forget — the matches subscription
          // delivers the result; failures log + the user can
          // re-trigger from the Matches tab affordances. The
          // computingMatches UX hint stays on for the
          // duration so the user knows new matches are
          // computing.
          if (currentRoleIdRef.current !== issuedAgainst) return;
          triggeredRef.current = true;
          setComputingMatches(true);
          void invokeRunMatching(roleId)
            .catch((err: unknown) => {
              // eslint-disable-next-line no-console
              console.warn("invokeRunMatching after re-parse failed", err);
            })
            .finally(() => {
              if (currentRoleIdRef.current !== issuedAgainst) return;
              setComputingMatches(false);
            });
        } catch (err) {
          if (currentRoleIdRef.current !== issuedAgainst) return;
          setParseError(err instanceof Error ? err : new Error(String(err)));
          setParsingStatus("error");
        }
      })();
    },
    [role, roleId],
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
    setApplications([]);
    setError(null);
    // Reset Requirements-tab parse state too so Role B
    // doesn't briefly show Role A's parsing/error UX
    // before the user interacts. The stale-closure guards
    // in onSaveJd / onParseJd already prevent A's in-flight
    // promises from writing into B; this reset is the
    // mirror for any state that's already committed.
    setParsingStatus("editing");
    setParseError(null);
    setSavingJd(false);
    // Reset Applications-tab UX state too so Role B doesn't
    // briefly show Role A's terminal generation outcome.
    setGenerationStatus("editing");
    setGenerationError(null);
    // Reset auto-trigger guards so a new Role gets its own
    // first-empty-snapshot trigger evaluation. Both the
    // idempotency ref and the matches-first-snapshot gate
    // reset (the latter so we re-await the new Role's
    // first snapshot before evaluating).
    triggeredRef.current = false;
    setComputingMatches(false);
    setMatchesFirstSnapshotReceived(false);

    // Stale-closure guard. If the user navigates to a new
    // roleId before the in-flight Role fetch resolves, we
    // ignore the late response. Same shape as React Query's
    // identity check, but written by hand because we only
    // need it once.
    let active = true;
    let unsubReqs: (() => void) | null = null;
    let unsubMatches: (() => void) | null = null;
    let unsubUnits: (() => void) | null = null;
    let unsubApplications: (() => void) | null = null;

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
            // Mark the matches subscription as "delivered
            // at least once" so the auto-trigger gate
            // (cursor #134 r1) treats matches.length=0 as
            // a known-empty signal, not the initial-state
            // default. Idempotent — calling setState with
            // the same value is a React no-op.
            setMatchesFirstSnapshotReceived(true);
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
        unsubApplications = subscribeApplicationsForRole(
          roleId,
          (next) => {
            if (!active) return;
            setApplications(next);
          },
          (err) => {
            if (!active) return;
            setApplications([]);
            // Surfacing the error through the top-level
            // status would block the whole page — but the
            // Applications tab subscription is non-load-
            // bearing for Requirements / Matches. Log + keep
            // the rest of the page rendering. The tab will
            // show no Applications; user can click Generate
            // to retry the path.
            // eslint-disable-next-line no-console
            console.warn("subscribeApplicationsForRole failed", err);
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
      unsubApplications?.();
    };
  }, [roleId]);

  // Auto-trigger matching when the user lands on a Role
  // that has Requirements but no matches yet (#131).
  //
  // Gate logic lives in `shouldAutoTriggerMatching` (a pure
  // helper, unit-tested) so the effect stays small and the
  // decision is verifiable in isolation. cursor #134 r1's
  // catch — that the prior effect could fire before the
  // matches subscription delivered its first snapshot — is
  // closed by the new `matchesFirstSnapshotReceived` gate.
  //
  // Effect deps: every input the gate reads. The matches /
  // requirements length deps re-evaluate the gate when
  // either snapshot arrives.
  useEffect(() => {
    if (roleId === undefined || roleId === "") return;
    // Special-case: first non-empty matches snapshot needs
    // to mark `triggeredRef = true` so a later drop to zero
    // (e.g. user rejected everything and the pipeline rerun
    // produced empty) doesn't re-fire. The pure gate's
    // `matchCount > 0` short-circuit returns false for
    // "don't fire," but it doesn't update the ref — that's
    // the container's job.
    if (
      status === "ready" &&
      matchesFirstSnapshotReceived &&
      matches.length > 0 &&
      !triggeredRef.current
    ) {
      triggeredRef.current = true;
    }

    if (
      !shouldAutoTriggerMatching({
        status,
        matchesFirstSnapshotReceived,
        matchCount: matches.length,
        requirementCount: requirements.length,
        alreadyTriggered: triggeredRef.current,
      })
    ) {
      return;
    }

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
  }, [
    status,
    roleId,
    matchesFirstSnapshotReceived,
    matches.length,
    requirements.length,
  ]);

  // Build the unit lookup once per units array. The matching
  // pipeline reads units owner-scoped and the Role's matches
  // can only reference the user's own units, so a single
  // user-wide lookup is fine.
  const unitsById = new Map<string, ExperienceUnit>(
    units.map((u) => [u.id, u]),
  );

  // Approved-match gate for the Generate CTA. The server-side
  // `generateResume` callable would reject with
  // `failed-precondition` if the Application's Role has no
  // approved UnitMatches; surfacing the gate at the CTA means
  // the user understands the prerequisite up front rather
  // than clicking and seeing an error.
  //
  // `approved_for_use` is the canonical approval flag (set by
  // the Matches tab's Approve button); `user_rejected` is the
  // separate reject flag and doesn't preclude approval — but
  // we only count rows with approved=true && rejected=false
  // so a rejected-then-re-approved row is counted (the click
  // sequence sets approved=true and clears user_rejected per
  // the single-setter approval handler).
  const hasApprovedMatches = matches.some(
    (m) => m.approved_for_use && !m.user_rejected,
  );

  /**
   * Generate a new resume for this Role. Steps:
   *   1. Create a fresh Application doc linked to the Role.
   *   2. Invoke the `generateResume` callable; orchestrator
   *      writes the asset under the Application.
   *   3. Navigate to `/applications/:newAppId` so the
   *      ApplicationEditor (#24) takes over.
   *
   * Stale-closure-guarded against role navigation. If the
   * user moves to Role B between step 1 and the navigate,
   * we abort the navigate (Role B's Applications tab is
   * unrelated; the Application created for Role A still
   * persists on the server but the user won't be redirected
   * away from B).
   */
  const onGenerate = useCallback((): void => {
    if (roleId === undefined || roleId === "") return;
    if (generationStatus === "generating") return;
    if (!hasApprovedMatches) return;

    const issuedAgainst = roleId;
    const newAppId = globalThis.crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Seed approved_unit_ids from the currently-approved
    // matches before creating the Application (Codex P1 on
    // PR #207). The orchestrator's `defaultLoadInputs`
    // filters Units via `application.approved_unit_ids`
    // (`functions/src/generation/pipeline.ts:497`); if we
    // leave it empty, the generation pipeline's eligible-
    // Units filter collapses to zero and throws
    // GenerationNoApprovedUnitsError. Dedupe via Set in
    // case multiple approved matches reference the same
    // Unit (the matcher's top-K can produce that — distinct
    // Requirements scoring against the same Unit).
    const approvedUnitIds = Array.from(
      new Set(
        matches
          .filter((m) => m.approved_for_use && !m.user_rejected)
          .map((m) => m.experience_unit_id),
      ),
    );

    setGenerationStatus("generating");
    setGenerationError(null);

    void (async () => {
      try {
        // Build the Application payload with the conditional-
        // spread pattern from #200 — Firestore rejects
        // `undefined` so optional fields (applied_at) are
        // omitted entirely rather than written as undefined.
        await upsertApplication({
          id: newAppId,
          role_id: roleId,
          stage: "drafting",
          last_activity_at: nowIso,
          generated_assets: [],
          approved_unit_ids: approvedUnitIds,
        });
        if (currentRoleIdRef.current !== issuedAgainst) return;

        await invokeGenerateResume(newAppId);
        if (currentRoleIdRef.current !== issuedAgainst) return;

        // Success: clear status + navigate. The
        // ApplicationEditor's container subscribes to its
        // own Application + asset state.
        setGenerationStatus("editing");
        setGenerationError(null);
        navigate(`/applications/${newAppId}`);
      } catch (err) {
        if (currentRoleIdRef.current !== issuedAgainst) return;
        setGenerationError(
          err instanceof Error ? err : new Error(String(err)),
        );
        setGenerationStatus("error");
      }
    })();
  }, [generationStatus, hasApprovedMatches, matches, navigate, roleId]);

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
      parsingStatus={parsingStatus}
      parseError={parseError}
      savingJd={savingJd}
      onSaveJd={onSaveJd}
      onParseJd={onParseJd}
      applications={applications}
      hasApprovedMatches={hasApprovedMatches}
      generationStatus={generationStatus}
      generationError={generationError}
      onGenerate={onGenerate}
    />
  );
}
