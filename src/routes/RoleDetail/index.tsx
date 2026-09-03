/**
 * Role Detail container. Wires Firestore subscriptions
 * (Role one-shot, Requirements + Matches + Units + Applications
 * snapshot-subscribed) into a `RoleDetailView` (#21 /
 * sub-issue #129).
 *
 * Container/view split mirrors UnitReview (#86): the view's
 * rendering shape is exercised in isolation with
 * `renderToStaticMarkup` so we don't have to mock Firebase.
 *
 * Subscription lifecycle:
 *   - On mount with a roleId: status = "loading". Open the
 *     Requirements + Matches + Units + Applications
 *     subscriptions immediately AND fetch the Role doc
 *     (one-shot) — both in parallel. The subscriptions only
 *     need `roleId` (already in hand), so they are NOT gated
 *     behind the Role fetch; this keeps time-to-ready from
 *     serializing against `getRole`.
 *   - On Role doc resolved (existence + ownership) AND
 *     Requirements first snapshot: status = "ready". Because
 *     those two signals now race, the flip happens when the
 *     second of the pair lands (a `maybeReady()` gate inside
 *     the effect), preserving the rule that an existing Role
 *     never momentarily renders the not-found branch.
 *     Subsequent Matches + Units snapshots flow into state
 *     without flipping status (the loading state is gated
 *     on the Role + Requirements pair because those are the
 *     load-bearing axes; Matches arriving slightly later
 *     just renders empty match rows briefly). Applications is
 *     non-load-bearing for readiness — its errors are logged,
 *     not surfaced through `status` (see the subscription
 *     below) — so it never affects the ready gate.
 *   - On any load-bearing (Requirements/Matches/Units) error:
 *     status = "error", error = err, latched via `hasErrored`
 *     so a later `maybeReady()` or not-found resolution can't
 *     overwrite it.
 *   - On unmount or roleId change: call all 4 unsubscribe
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
  useMemo,
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
  invokeDeriveMatchEvidence,
  invokeRunMatching,
  setMatchApprovalState,
  subscribeMatchesByRole,
  type MatchApprovalState,
} from "../../services/matches.ts";
import { invokeGenerateResume } from "../../services/generation.ts";
import { invokeParseJobRequirements } from "../../services/requirements.ts";
import { beginAppBusy } from "../../lib/appBusy.ts";
import { friendlyCallableError } from "../../lib/callable-errors.ts";
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
import { legacyEvidenceKey } from "./evidenceKey.ts";
import type { EvidenceStatus } from "./GapsView.tsx";
import type { MatchEvidence } from "../../../functions/src/types/evidence.ts";

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
  // Stale-closure guard for the async parse / save / generate
  // paths. Mirrors the `active` flag pattern used in the main
  // subscription effect, but ref-based so the resolved promise
  // reads the LATEST visit token across renders rather than the
  // captured-stale closure value.
  //
  // Two pieces:
  //   - `currentRoleIdRef` — the roleId of the active visit.
  //     Useful for fast-path comparisons in the simple A → B
  //     case.
  //   - `visitTokenRef` — a monotonic counter bumped on every
  //     roleId change. Closes the A → B → A race that a plain
  //     roleId comparison can't see: in that sequence the
  //     in-flight callback for the FIRST A would otherwise
  //     resolve and pass the `currentRoleIdRef.current === A`
  //     check even though the user is now on a fresh A visit.
  //     The token comparison fails because each visit gets its
  //     own integer (CodeRabbit P1 on PR #206).
  //
  // The pattern: capture both `issuedAgainst = roleId` and
  // `issuedToken = visitTokenRef.current` at call time, then
  // every async continuation checks the token; mismatch =>
  // bail out before any state writes.
  const currentRoleIdRef = useRef<string | undefined>(roleId);
  const visitTokenRef = useRef(0);
  useEffect(() => {
    currentRoleIdRef.current = roleId;
    visitTokenRef.current += 1;
  }, [roleId]);
  // Auto-trigger state (#131). Distinguishes the
  // pre-first-snapshot wait, the in-flight matching call,
  // and the post-completion subscription delivery.
  // Idempotency lives on a ref (not state) so a re-render
  // doesn't re-fire the trigger and so the latest value is
  // always read inside async closures.
  const [computingMatches, setComputingMatches] = useState(false);
  const [matchingError, setMatchingError] = useState<Error | null>(null);
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

  // Derived structural-evidence verdicts for this Role's matches
  // (#441), keyed by match id. `undefined` means "no verdicts to
  // apply" — either every match already carries a persisted
  // `structural_evidence` (the common case, and no round-trip is
  // made), or the derivation is in flight, or it failed.
  // `computeGaps` reads the absence as the permissive pre-#441
  // rule, so all three degrade identically and none can invent a
  // gap. `evidenceStatus` is what tells them apart for the user.
  const [matchEvidence, setMatchEvidence] = useState<
    ReadonlyMap<string, MatchEvidence> | undefined
  >(undefined);
  const [evidenceStatus, setEvidenceStatus] =
    useState<EvidenceStatus>("current");
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
  // JD textarea draft, lifted from RequirementsTab so a tab
  // switch (which unmounts RequirementsTab via the activeTab
  // conditional render) doesn't lose unsaved paste / edits
  // (nathanpayne-codex Phase 4b P1 on PR #206). Sync rule:
  // adopt the persisted `role.jd_raw` whenever it changes
  // AND the user hasn't started editing (draft equals the
  // last value we synced down). The roleId reset effect
  // below also resets the draft so a different Role doesn't
  // inherit the previous Role's draft.
  const [jdDraft, setJdDraft] = useState("");
  const lastSyncedJdRawRef = useRef<string>("");
  // Sync persisted → draft when persisted changes and the
  // user's draft hasn't diverged from the last value we
  // pushed in. Same `lastSyncedPersisted` pattern that lived
  // inside RequirementsTab pre-lift; same comment about
  // intentional dep omission to avoid a feedback loop.
  useEffect(() => {
    const persisted = role?.jd_raw ?? "";
    if (jdDraft === lastSyncedJdRawRef.current) {
      setJdDraft(persisted);
    }
    lastSyncedJdRawRef.current = persisted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role?.jd_raw]);

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
      // Capture both the role id AND the visit token this save
      // was issued against. The token closes the A → B → A race
      // (CodeRabbit P1 on PR #206): plain roleId comparison
      // would let the FIRST A's continuation pass through after
      // the user came back to A, because roleId === A both times.
      const issuedAgainst = role.id;
      const issuedToken = visitTokenRef.current;
      const isStale = (): boolean =>
        currentRoleIdRef.current !== issuedAgainst ||
        visitTokenRef.current !== issuedToken;
      setSavingJd(true);

      const { owner_uid: _ownerUid, ...rest } = next;
      void upsertRole(rest)
        .then(() => {
          if (isStale()) return;
          setRole(next);
          // Clear any prior parse/save error so a successful
          // retry doesn't leave the inline banner visible
          // forever (Codex P2 round 2 on PR #206). The same
          // pattern applies inside onParseJd's success path.
          setParseError(null);
          setParsingStatus("editing");
        })
        .catch((err: unknown) => {

          console.warn("upsertRole failed", err);
          if (isStale()) return;
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
          if (isStale()) return;
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
      // Capture both the role this parse was issued against AND
      // the visit token. Token check closes the A → B → A race
      // (CodeRabbit P1 on PR #206) — see the visitTokenRef
      // declaration above for the full pattern.
      const issuedAgainst = roleId;
      const issuedToken = visitTokenRef.current;
      const isStale = (): boolean =>
        currentRoleIdRef.current !== issuedAgainst ||
        visitTokenRef.current !== issuedToken;
      setParsingStatus("parsing");
      setParseError(null);
      const trimmed = text.trim();
      const next: Role = { ...role, jd_raw: text };
      // Suppress the update-reload banner while the parse runs (#429).
      // Per-invocation lease: parses of different Roles can overlap, and
      // one settling must not un-suppress another (Codex P2 on #434).
      const releaseParseBusy = beginAppBusy("roleDetail.parseJd");
      void (async () => {
        try {
          // Persist the JD first so a parse failure doesn't
          // strand the user's edits. upsertRole is a merge
          // setDoc, so the rest of the Role doc is unchanged.
          if (text !== role.jd_raw) {

            const { owner_uid: _o, ...rest } = next;
            await upsertRole(rest);
            if (!isStale()) {
              setRole(next);
            }
          }
          // Bail out before the parse callable if the user
          // has navigated away mid-await (CodeRabbit P1
          // round 3 on PR #206). Otherwise a stale visit
          // would still hit the LLM pipeline + write
          // Requirements that the user no longer cares about.
          if (isStale()) return;
          const parseResult = await invokeParseJobRequirements(
            roleId,
            trimmed,
          );
          // Subscription delivers the parsed Requirements;
          // flip back to editing on success and clear any
          // prior error so a successful retry hides the
          // inline banner.
          if (isStale()) return;
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
          // delivers the result; on failure the user re-triggers
          // with the Matches tab's "Re-run matching" control,
          // which did not exist when this comment first claimed
          // it did (added for #442 after Codex P2 on PR #449). The
          // computingMatches UX hint stays on for the
          // duration so the user knows new matches are
          // computing.
          if (isStale()) return;
          // A parse that produced NO Requirements must not trigger
          // matching. `replaceMatchesForRole` clears the Role's
          // matches and writes whatever the run produced — which
          // against an empty Requirement set is nothing — so the
          // rematch would silently delete every surviving match,
          // including the user's approvals. Those rows are what
          // #442 preserves and classifies as stranded so the user
          // can see what happened and re-parse. Deleting them
          // destroys the evidence the recovery path depends on.
          // CodeRabbit on PR #449.
          if (parseResult.requirements.length === 0) return;
          triggeredRef.current = true;
          // Clear any earlier manual-retry failure: this run
          // supersedes it, and leaving the message up would show
          // a stale error underneath a completed result. Codex P2
          // on PR #449.
          setMatchingError(null);
          setComputingMatches(true);
          void invokeRunMatching(roleId)
            .catch((err: unknown) => {

              console.warn("invokeRunMatching after re-parse failed", err);
            })
            .finally(() => {
              if (isStale()) return;
              setComputingMatches(false);
            });
        } catch (err) {
          if (isStale()) return;
          // Map before display: a callable that dies structurally
          // (Cloud Run timeout kill, uncaught server error) arrives
          // with `message` set to the bare status code, and this
          // banner rendered it verbatim — #422 showed "internal"
          // here. `friendlyCallableError` passes through any real
          // server message untouched.
          setParseError(
            new Error(
              friendlyCallableError(err, {
                operation: "parsing the job description",
                timeoutHint:
                  "Trimming the posting down to the actual requirements usually helps.",
              }),
            ),
          );
          setParsingStatus("error");
        } finally {
          // Released in finally, not per-branch: several paths above
          // return early on a stale visit, and an unreleased lease
          // would suppress the update banner for the rest of the
          // session (#429).
          releaseParseBusy();
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
      setRequirements([]);
      setMatches([]);
      setUnits([]);
      setApplications([]);
      setError(null);
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
    // Reset the JD draft + the persisted-sync ref so Role B
    // doesn't inherit Role A's unsaved draft. The Role-fetch
    // resolution below will re-sync via the persisted-jd_raw
    // effect once the new role lands.
    setJdDraft("");
    lastSyncedJdRawRef.current = "";
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
    // Role B must never render Role A's verdicts. A cross-Role
    // state leak of exactly this shape was one of the eleven
    // findings against #438.
    setMatchEvidence(undefined);
    setEvidenceStatus("current");
    setMatchingError(null);

    // Stale-closure guard. If the user navigates to a new
    // roleId before the in-flight Role fetch resolves, we
    // ignore the late response. Same shape as React Query's
    // identity check, but written by hand because we only
    // need it once.
    let active = true;

    // "ready" is gated on the Role + Requirements PAIR (see
    // the subscription-lifecycle docblock at the top of this
    // file): the Role doc must resolve to an owned role AND
    // the first Requirements snapshot must arrive. Those two
    // signals now race — the subscriptions start immediately
    // below, in parallel with `getRole`, rather than waiting
    // on it — so whichever lands second is the one that flips
    // status. Tracking both as closure booleans + a single
    // `maybeReady()` gate preserves the exact pre-parallel
    // semantics: the view never renders the not-found branch
    // (status "ready" + role null) for an existing role just
    // because Requirements happened to arrive before the Role
    // fetch resolved.
    let roleResolved = false;
    let firstReqsSnapshot = true;
    // Latches once any load-bearing subscription (Requirements /
    // Matches / Units) or the Role fetch reports an error. Without
    // this, an error that lands while the OTHER signal in the
    // Role+Requirements pair is still in flight gets silently
    // overwritten: maybeReady() only checks roleResolved/
    // firstReqsSnapshot, so it would flip status back to "ready"
    // with stale/empty data once both arrive, hiding the failure
    // (Codex P2, PR #292).
    let hasErrored = false;
    const maybeReady = (): void => {
      if (roleResolved && !firstReqsSnapshot && !hasErrored) {
        setStatus("ready");
      }
    };

    // Open the three subscriptions immediately. They only need
    // `roleId` (already in hand) — none depend on the Role doc
    // existing — so gating them behind `getRole` needlessly
    // serialized time-to-ready against the role fetch. Matches
    // and Units may still be in flight when Requirements first
    // lands; the Role + Requirements pair is what determines
    // whether the tab can render meaningfully.
    const unsubReqs = subscribeRequirementsForRole(
      roleId,
      (next) => {
        if (!active) return;
        setRequirements(next);
        if (firstReqsSnapshot) {
          firstReqsSnapshot = false;
          maybeReady();
        }
      },
      (err) => {
        if (!active) return;
        hasErrored = true;
        setRequirements([]);
        setError(err);
        setStatus("error");
      },
    );
    const unsubMatches = subscribeMatchesByRole(
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
        hasErrored = true;
        setMatches([]);
        setError(err);
        setStatus("error");
      },
    );
    const unsubUnits = subscribeUnitsByOwner(
      (next) => {
        if (!active) return;
        setUnits(next);
      },
      (err) => {
        if (!active) return;
        hasErrored = true;
        setUnits([]);
        setError(err);
        setStatus("error");
      },
    );
    const unsubApplications = subscribeApplicationsForRole(
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

        console.warn("subscribeApplicationsForRole failed", err);
      },
    );

    // Fetch the Role doc in parallel with the subscriptions
    // above. This populates the Role state (title, jd_raw) and
    // the existence/ownership half of the "ready" gate.
    void (async () => {
      try {
        const r = await getRole(roleId);
        if (!active) return;
        if (r === undefined) {
          // Anti-enumeration: rules at the data layer
          // already collapse missing-OR-not-yours into a
          // single "no permission" path; this just renders
          // the not-found state when the doc doesn't come
          // back. Terminal — flip straight to "ready" with a
          // null role (the not-found render) without waiting
          // on the Requirements snapshot.
          //
          // The four subscriptions above were started
          // speculatively (in parallel with this fetch, before
          // we knew the role existed/was owned) and are still
          // live at this point. Tear them down now rather than
          // waiting for unmount: left running, they keep
          // consuming reads for a role the user can't access,
          // and a later listener error would flip status to
          // "error", replacing the intended not-found surface
          // (Codex P2, PR #292).
          unsubReqs();
          unsubMatches();
          unsubUnits();
          unsubApplications();
          setRole(null);
          // Don't clobber an already-latched subscription error:
          // if Requirements/Matches/Units errored before this
          // resolved, `hasErrored` is already true and status is
          // already "error" — the not-found render must not
          // overwrite that (CodeRabbit Major, PR #292).
          if (!hasErrored) {
            setStatus("ready");
          }
          return;
        }
        setRole(r);
        roleResolved = true;
        maybeReady();
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      }
    })();

    return () => {
      active = false;
      unsubReqs();
      unsubMatches();
      unsubUnits();
      unsubApplications();
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

    // Capture visit token so a slow runMatching from Role A
    // doesn't clear `computingMatches` after the user has
    // navigated to Role B (CodeRabbit P1 round 4 on PR #206).
    // Without this, B's own auto-trigger hint could be
    // wiped by A's stale finally callback.
    const issuedAgainstAuto = roleId;
    const issuedTokenAuto = visitTokenRef.current;
    triggeredRef.current = true;
    setMatchingError(null);
    setComputingMatches(true);
    void invokeRunMatching(roleId)
      .catch((err: unknown) => {
        // Subscription delivers the new matches on success;
        // failures log + un-set the loading state. Phase 2
        // surfaces a toast; deferred per #21 spec.

        console.warn("invokeRunMatching failed", err);
      })
      .finally(() => {
        if (
          currentRoleIdRef.current !== issuedAgainstAuto ||
          visitTokenRef.current !== issuedTokenAuto
        ) {
          return;
        }
        setComputingMatches(false);
      });
  }, [
    status,
    roleId,
    matchesFirstSnapshotReceived,
    matches.length,
    requirements.length,
  ]);

  // Re-derivation trigger. See `evidenceKey.ts` for why it is a
  // signature over the derivation's actual inputs rather than
  // over `matches` (fires per approval click) or over the legacy
  // id set alone (misses Unit and Requirement edits — Codex P2 on
  // PR #446).
  const evidenceKey = useMemo(
    () => legacyEvidenceKey(matches, units, requirements),
    [matches, units, requirements],
  );

  // Monotonic request counter for the derivation.
  //
  // The visit token guards navigation between Roles. This guards
  // the other direction: two derivations for the SAME Role, fired
  // as the inputs changed, can resolve out of order and let the
  // older answer overwrite the newer one. Codex P2 on PR #446
  // asked for both.
  const evidenceSeqRef = useRef(0);

  // Read-only evidence derivation for legacy matches (#441).
  //
  // Matches written before #435 carry no `structural_evidence`,
  // and `computeGaps` lets them satisfy a must-have on the
  // strength of neutral scores alone. This resolves them from
  // their ID-linked Unit/Requirement pair, server-side because
  // only `functions/src/matching/normalize.ts` may canonicalize
  // vocabulary (#96), and **writes nothing** — the whole reason
  // this replaced #438's re-run-the-matcher-on-open approach.
  //
  // No legacy rows means no call at all: a Role matched under
  // #435 or later pays nothing for this.
  //
  // Failure is deliberately benign. Verdicts stay `undefined`,
  // `computeGaps` keeps the permissive reading, and the Gaps
  // panel discloses that the check did not run. Degrading to a
  // stricter reading would make a failed network call sprout
  // gaps the user cannot act on.
  useEffect(() => {
    if (roleId === undefined || roleId === "") return;
    if (status !== "ready" || !matchesFirstSnapshotReceived) return;
    if (evidenceKey === "") {
      // Advancing the counter is what makes this branch safe. An
      // explicit rematch replaces every legacy row with a current
      // one WHILE a derivation is in flight; without the bump the
      // obsolete request still passes `superseded()`, and on
      // failure it would overwrite this clean state with
      // `unavailable` — warning about older matches that no
      // longer exist. Codex P2 on PR #446, found after the
      // sequence guard itself landed.
      evidenceSeqRef.current += 1;
      setMatchEvidence(undefined);
      setEvidenceStatus("current");
      return;
    }

    // Two guards, for two different races. The visit token is the
    // same one the auto-trigger uses: a slow derivation for Role A
    // must not land in Role B's state. The sequence number covers
    // same-Role reordering, which the visit token cannot see
    // because it only moves on navigation.
    const issuedAgainst = roleId;
    const issuedToken = visitTokenRef.current;
    const issuedSeq = ++evidenceSeqRef.current;
    const superseded = (): boolean =>
      currentRoleIdRef.current !== issuedAgainst ||
      visitTokenRef.current !== issuedToken ||
      evidenceSeqRef.current !== issuedSeq;

    // Drop the previous verdicts before asking for new ones.
    //
    // They describe inputs that have since changed — that is why
    // this effect re-fired — so keeping them enforces an obsolete
    // answer for the whole round trip. An edited Requirement that
    // turns a pair from `unevidenced` to `evidenced` would go on
    // rendering an unmet gap until the call returned. The
    // documented in-flight behaviour is the permissive
    // pre-derivation reading, and this is what actually makes it
    // so. Codex P2 on PR #446.
    setMatchEvidence(undefined);
    setEvidenceStatus("pending");
    void invokeDeriveMatchEvidence(roleId)
      .then((evidence) => {
        if (superseded()) return;
        setMatchEvidence(evidence);
        setEvidenceStatus("current");
      })
      .catch((err: unknown) => {
        if (superseded()) return;
        console.warn("invokeDeriveMatchEvidence failed", err);
        setMatchEvidence(undefined);
        setEvidenceStatus("unavailable");
      });
  }, [status, roleId, matchesFirstSnapshotReceived, evidenceKey]);

  /**
   * Manual "re-run matching" from the Matches tab.
   *
   * The post-parse `runMatching` is fire-and-forget, and the
   * auto-trigger deliberately will not fire while
   * `matches.length > 0` — so when that call fails the Role is
   * left holding matches against Requirement ids the re-parse
   * deleted, with no way back. The comment on that call already
   * claimed "the user can re-trigger from the Matches tab
   * affordances"; there were none. #442's generation gate then
   * started refusing to generate and naming exactly this action,
   * which turned a silent inconsistency into a dead end. Codex P2
   * on PR #449.
   *
   * Sets `triggeredRef` for the same reason the post-parse call
   * does: the auto-trigger must not also fire if this run clears
   * the match set.
   */
  const onRerunMatching = useCallback((): void => {
    if (roleId === undefined || roleId === "" || computingMatches) return;
    const issuedAgainst = roleId;
    const issuedToken = visitTokenRef.current;
    const stale = (): boolean =>
      currentRoleIdRef.current !== issuedAgainst ||
      visitTokenRef.current !== issuedToken;

    triggeredRef.current = true;
    setMatchingError(null);
    setComputingMatches(true);
    void invokeRunMatching(roleId)
      .catch((err: unknown) => {
        if (stale()) return;
        setMatchingError(
          new Error(
            friendlyCallableError(err, { operation: "re-running matching" }),
          ),
        );
      })
      .finally(() => {
        if (stale()) return;
        setComputingMatches(false);
      });
  }, [roleId, computingMatches]);

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
  /**
   * Approved, non-rejected matches whose Requirement still
   * exists — the same set the server's generation gate uses
   * (#442).
   *
   * The client has to mirror the rule rather than count raw
   * approvals. Building `approved_unit_ids` from every approved
   * match snapshots Units generation will not use, so the
   * Application Editor's right pane shows grounding that never
   * reached the prompt; and when every approved match is
   * orphaned, the Generate CTA stayed enabled and created a
   * draft the server was guaranteed to reject. Codex P2 on PR
   * #449.
   *
   * The server remains the authority — this is the UI declining
   * to offer an action it knows will fail, not a second gate.
   */
  const liveApprovedMatches = useMemo(() => {
    const currentRequirementIds = new Set(requirements.map((r) => r.id));
    // The Unit side matters too. `defaultLoadInputs` loads only
    // Units that still exist AND are `user_approved`, so a match
    // pointing at a deleted or unapproved Unit enabled Generate
    // and snapshotted a dangling id — producing an Application
    // the server then refused. The Role already subscribes to the
    // owner's Units, so checking it costs nothing. Codex P2 on
    // PR #449.
    const approvedUnitIdSet = new Set(
      units.filter((u) => u.user_approved).map((u) => u.id),
    );
    return matches.filter(
      (m) =>
        m.approved_for_use &&
        !m.user_rejected &&
        currentRequirementIds.has(m.job_requirement_unit_id) &&
        approvedUnitIdSet.has(m.experience_unit_id),
    );
  }, [matches, requirements, units]);

  const hasApprovedMatches = liveApprovedMatches.length > 0;

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
    // Same A → B → A race protection as parse/save (CodeRabbit
    // P1 on PR #206) — capture the visit token at issue time
    // and check both pieces in every continuation.
    const issuedToken = visitTokenRef.current;
    const isStale = (): boolean =>
      currentRoleIdRef.current !== issuedAgainst ||
      visitTokenRef.current !== issuedToken;
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
        // Live matches only — see `liveApprovedMatches`. A Unit
        // whose only approval is against a deleted Requirement
        // must not enter the snapshot, or the Editor claims
        // grounding the generator refused to use.
        liveApprovedMatches.map((m) => m.experience_unit_id),
      ),
    );

    setGenerationStatus("generating");
    setGenerationError(null);

    void (async () => {
      // Resume generation is another long, paid call — a 330s
      // budget in callable-timeouts.ts. Offering a reload here
      // would strand the just-created Application in `drafting`
      // and invite duplicate work (Codex P2 on PR #434).
      const releaseGenBusy = beginAppBusy("roleDetail.generate");
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
        if (isStale()) return;

        await invokeGenerateResume(newAppId);
        if (isStale()) return;

        // Success: clear status + navigate. The
        // ApplicationEditor's container subscribes to its
        // own Application + asset state.
        setGenerationStatus("editing");
        setGenerationError(null);
        navigate(`/applications/${newAppId}`);
      } catch (err) {
        if (isStale()) return;
        // Same bare-status-code mapping as the parse path above.
        // No timeoutHint: generation reads from already-stored Units
        // and matches, so there is no input for the user to trim.
        setGenerationError(
          new Error(
            friendlyCallableError(err, { operation: "generating your resume" }),
          ),
        );
        setGenerationStatus("error");
      } finally {
        releaseGenBusy();
      }
    })();
  }, [generationStatus, hasApprovedMatches, liveApprovedMatches, navigate, roleId]);

  return (
    <RoleDetailView
      status={status}
      role={role}
      requirements={requirements}
      matches={matches}
      matchEvidence={matchEvidence}
      onRerunMatching={onRerunMatching}
      matchingError={matchingError}
      evidenceStatus={evidenceStatus}
      unitsById={unitsById}
      error={error}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onApprovalStateChange={onApprovalStateChange}
      computingMatches={computingMatches}
      parsingStatus={parsingStatus}
      parseError={parseError}
      savingJd={savingJd}
      jdDraft={jdDraft}
      onJdDraftChange={setJdDraft}
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
