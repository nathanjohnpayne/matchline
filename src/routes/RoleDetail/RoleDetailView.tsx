/**
 * Presentational component for the Role Detail surface.
 * Receives pre-fetched Role + Requirements + Matches +
 * unit lookup from the container; manages the active-tab
 * state that the container holds. Does not subscribe or
 * talk to Firestore.
 *
 * Same container/view split as UnitReview (#86) — the
 * view's rendering shape is exercised in isolation with
 * `renderToStaticMarkup` so we don't have to mock
 * Firebase.
 *
 * Three tabs: Requirements, Matches, Applications. Sub-
 * issue #129 ships the Matches tab in full; the other two
 * render placeholders so the UI shape is complete and the
 * user can see what's coming.
 */

import type { ReactElement } from "react";

import type { ExperienceUnit, UnitMatch } from "../../types/capability.ts";
import type { Role } from "../../types/crm.ts";

import MatchesTab from "./MatchesTab.tsx";
import { computeGaps } from "./computeGaps.ts";
import { groupMatchesByRequirement } from "./groupMatchesByRequirement.ts";
import type { JobRequirementUnit } from "../../types/capability.ts";
import type { MatchApprovalState } from "../../services/matches.ts";

/**
 * Subscription load state for the Role doc + per-tab data.
 * Same three-way discrimination as UnitReview (#86's codex
 * round 1 caught the loading/empty conflation): "loading"
 * is pre-first-snapshot, "error" is terminal, "ready" is
 * post-first-snapshot regardless of payload size.
 */
export type LoadState = "loading" | "ready" | "error";

export type Tab = "requirements" | "matches" | "applications";

export interface RoleDetailViewProps {
  readonly status: LoadState;
  readonly role: Role | null;
  readonly requirements: readonly JobRequirementUnit[];
  readonly matches: readonly UnitMatch[];
  readonly unitsById: ReadonlyMap<string, ExperienceUnit>;
  readonly error: Error | null;
  readonly activeTab: Tab;
  readonly onTabChange: (tab: Tab) => void;
  /**
   * Single-setter approval handler (#130 + cursor #133 r1).
   * MatchCard computes the next `MatchApprovalState` from
   * the click + the match's current state, then passes it
   * up. Container issues ONE atomic write per call — no
   * dual-write race.
   */
  readonly onApprovalStateChange: (
    matchId: string,
    state: MatchApprovalState,
  ) => void;
  /**
   * True while the auto-trigger's `runMatching` callable is
   * in flight (#131). The Matches tab renders a "Computing
   * matches…" hint above the requirements grid; the
   * subscription's next snapshot delivers the new matches
   * regardless, so this is purely a UX signal.
   */
  readonly computingMatches: boolean;
}

const TAB_DEFS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "requirements", label: "Requirements" },
  { id: "matches", label: "Matches" },
  { id: "applications", label: "Applications" },
];

export default function RoleDetailView({
  status,
  role,
  requirements,
  matches,
  unitsById,
  error,
  activeTab,
  onTabChange,
  onApprovalStateChange,
  computingMatches,
}: RoleDetailViewProps): ReactElement {
  if (status === "loading") {
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        data-testid="role-detail-loading"
      >
        <p className="text-sm text-zinc-500">Loading Role…</p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        data-testid="role-detail-error"
      >
        <p className="text-sm text-red-700 dark:text-red-400">
          Failed to load Role
          {error !== null ? `: ${error.message}` : "."}
        </p>
      </section>
    );
  }
  if (role === null) {
    // Anti-enumeration mirror of the server-side messaging:
    // "not found OR not yours" collapses to a single
    // user-facing message. The route's redirect handling
    // upstream may navigate away; this is the fall-through
    // render.
    return (
      <section
        className="mx-auto max-w-6xl space-y-4"
        data-testid="role-detail-not-found"
      >
        <p className="text-sm text-zinc-500">
          Role not found, or not owned by you.
        </p>
      </section>
    );
  }

  const groups = groupMatchesByRequirement(requirements, matches);
  const gaps = computeGaps(requirements, matches);

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {role.title}
        </h1>
        <p className="text-sm text-zinc-500">Role: {role.id}</p>
      </header>

      <nav
        role="tablist"
        aria-label="Role detail sections"
        className="border-b border-zinc-200 dark:border-zinc-800 flex gap-1"
      >
        {TAB_DEFS.map(({ id, label }) => {
          const selected = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`role-detail-panel-${id}`}
              id={`role-detail-tab-${id}`}
              onClick={() => onTabChange(id)}
              className={
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
                (selected
                  ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
              }
            >
              {label}
            </button>
          );
        })}
      </nav>

      <div
        role="tabpanel"
        id={`role-detail-panel-${activeTab}`}
        aria-labelledby={`role-detail-tab-${activeTab}`}
      >
        {activeTab === "requirements" && (
          <p
            className="text-sm text-zinc-500"
            data-testid="requirements-tab-placeholder"
          >
            Requirements editing ships under #15. This tab currently
            shows a read-only summary count: {requirements.length}{" "}
            requirement{requirements.length === 1 ? "" : "s"} parsed.
          </p>
        )}
        {activeTab === "matches" && (
          <MatchesTab
            groups={groups}
            gaps={gaps}
            unitsById={unitsById}
            onApprovalStateChange={onApprovalStateChange}
            computingMatches={computingMatches}
          />
        )}
        {activeTab === "applications" && (
          <p
            className="text-sm text-zinc-500"
            data-testid="applications-tab-placeholder"
          >
            Applications listing ships in a later phase. Generation
            shells through `generateResume` (#121) once the editor
            surface (#24) lands.
          </p>
        )}
      </div>
    </section>
  );
}
