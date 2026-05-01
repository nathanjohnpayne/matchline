/**
 * Applications tab presentational component (sub-issue #202,
 * front-end for #22). Replaces the placeholder that shipped
 * with #129.
 *
 * Three states the tab can be in:
 *   1. No approved matches → "Generate resume" CTA disabled
 *      with the "Approve at least one match first" copy.
 *      Existing Applications (if any) still listed below so
 *      the user can re-enter the editor on prior generations.
 *   2. Approved matches present, no existing Applications →
 *      enabled "Generate resume" CTA + empty-list copy.
 *   3. Existing Applications → list with stage badges + an
 *      "Open" link to `/applications/:id`. CTA still
 *      generates a new Application (the spec calls for one
 *      Application per generation; regeneration replaces the
 *      asset under an existing Application via the
 *      ApplicationEditor's own UI).
 *
 * Status state machine mirrors the rest of the V1 surfaces
 * (Onboarding #199, BulletEditor #188, RoleNew #200,
 * RequirementsTab #201): editing / generating / error.
 *
 * UI guidance baseline:
 *   - Rule 4: inline; the button + redirect, no modal.
 *   - Rule 6: thin top progress bar during generation
 *     (PRD p95 = 20s; up to 90s with full retry budget),
 *     no spinner overlay.
 *   - Rule 8: data-dense list — show stage + last_activity_at +
 *     asset count for every existing Application.
 *
 * Pure presentational; no Firestore. Container (`index.tsx`)
 * holds the in-flight + error state, the
 * `subscribeApplicationsForRole` subscription, and the
 * `upsertApplication` + `invokeGenerateResume` wiring.
 */

import type { ReactElement } from "react";

import type { Application, ApplicationStage } from "../../types/crm.ts";

export type ApplicationsTabStatus = "editing" | "generating" | "error";

export interface ApplicationsTabProps {
  /** Current persisted Applications under this Role (subscription-delivered). */
  readonly applications: readonly Application[];
  /**
   * True when the user has at least one approved UnitMatch
   * under this Role. Disables the Generate CTA when false —
   * the server-side `generateResume` callable would reject
   * with `failed-precondition` ("no approved UnitMatches"),
   * but we surface the gate up front so the user knows what
   * to do.
   */
  readonly hasApprovedMatches: boolean;
  /** Generate-call status. */
  readonly status: ApplicationsTabStatus;
  /** Last generation error, if any. Surfaced inline. */
  readonly error: Error | null;
  /**
   * Trigger Generate. Container creates a fresh Application
   * row (linked to the Role) THEN calls the orchestrator,
   * THEN navigates to `/applications/:newAppId` on success.
   */
  readonly onGenerate: () => void;
}

/**
 * Stage badge color: visually distinguishes drafting (the
 * default for newly-generated apps) from advanced stages.
 * Not load-bearing — copy alone is enough to read the status,
 * but the color cue helps scan the list at a glance.
 */
const STAGE_BADGE_CLASS: Record<ApplicationStage, string> = {
  saved:
    "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  drafting:
    "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  applied:
    "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  interviewing:
    "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  offer:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rejected:
    "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
  withdrawn:
    "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
};

/**
 * Sort Applications for display: most recent activity first.
 * Stable on equal timestamps via id. The user's own actions
 * are typically the latest — generation flips
 * last_activity_at, so a freshly-generated Application sorts
 * to the top and the redirect lands on a row already at the
 * top of the list when the user routes back.
 */
function sortApplications(
  apps: readonly Application[],
): readonly Application[] {
  return [...apps].sort((a, b) => {
    if (a.last_activity_at !== b.last_activity_at) {
      return a.last_activity_at < b.last_activity_at ? 1 : -1;
    }
    return a.id.localeCompare(b.id);
  });
}

export default function ApplicationsTab({
  applications,
  hasApprovedMatches,
  status,
  error,
  onGenerate,
}: ApplicationsTabProps): ReactElement {
  const generating = status === "generating";
  const hasApplications = applications.length > 0;
  // Disable when in flight OR no approved matches. Both
  // gates need to be visible because the user might land on
  // an empty Role and need direction ("Approve at least one
  // match first") OR be staring at a generation in flight
  // and need to know they can't double-submit.
  const cantGenerate = !hasApprovedMatches;
  const disabled = generating || cantGenerate;

  return (
    <section
      className="space-y-4"
      data-testid="applications-tab"
      data-applications-tab-status={status}
    >
      {/* Thin top progress bar per UI guidance rule 6 — only
          visible while generation is in flight. */}
      {generating && (
        <div
          role="progressbar"
          aria-label="Generating resume"
          aria-busy="true"
          aria-valuetext="Generating in progress"
          data-testid="applications-tab-progress"
          className="h-0.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        >
          <div className="h-full w-1/3 animate-pulse bg-zinc-900 dark:bg-zinc-100" />
        </div>
      )}

      {status === "error" && error !== null && (
        <p
          role="alert"
          data-testid="applications-tab-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error.message}
        </p>
      )}

      {/* Generate CTA. Sits above the list so it's the
          first thing the user sees on a fresh Role; once
          Applications exist it's still visible so the user
          can spawn another generation. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {hasApprovedMatches
            ? "Generate a resume from your approved matches under this Role."
            : "Approve at least one match first."}
        </p>
        <button
          type="button"
          onClick={onGenerate}
          disabled={disabled}
          aria-disabled={disabled}
          // Native title= for the disabled-state tooltip.
          // Acceptance criterion calls for "Approve at least
          // one match first"; we mirror that copy here so
          // hovering the disabled button explains why.
          title={
            cantGenerate
              ? "Approve at least one match first."
              : generating
              ? "Generating…"
              : undefined
          }
          data-action="applications-generate"
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {generating ? "Generating…" : "Generate resume"}
        </button>
      </div>

      {/* Existing Applications list / empty state. */}
      {hasApplications ? (
        <ol
          data-testid="applications-tab-list"
          className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        >
          {sortApplications(applications).map((app) => {
            // Normalize generated_assets — the type marks it
            // required, but the runtime helpers (e.g.,
            // `removeBulletFromAsset` in services/applications.ts:143)
            // treat it as optional for legacy / pre-pipeline docs.
            // A pre-pipeline Application missing the field would
            // otherwise crash the Role Detail render. Codex Phase
            // 4b finding on PR #207.
            const assets = app.generated_assets ?? [];
            return (
              <li
                key={app.id}
                data-testid="applications-tab-row"
                data-application-id={app.id}
                className="flex items-center justify-between rounded border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="applications-tab-stage"
                      className={
                        "rounded px-1.5 py-0.5 text-xs font-medium " +
                        STAGE_BADGE_CLASS[app.stage]
                      }
                    >
                      {app.stage}
                    </span>
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                      {app.id}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {assets.length === 0
                      ? "No assets yet"
                      : `${assets.length} asset${
                          assets.length === 1 ? "" : "s"
                        }`}
                    {" · last activity "}
                    <time dateTime={app.last_activity_at}>
                      {app.last_activity_at}
                    </time>
                  </p>
                </div>
                {/* Plain anchor + href so the link is keyboard-
                    reachable and shows the URL in the status
                    bar. SPA hydration takes over via React
                    Router's NavLink/Link further up the tree;
                    here we just need the destination. */}
                <a
                  href={`/applications/${app.id}`}
                  data-action="applications-open"
                  data-application-id={app.id}
                  className="ml-3 shrink-0 rounded px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Open
                </a>
              </li>
            );
          })}
        </ol>
      ) : (
        <p
          className="border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800"
          data-testid="applications-tab-empty"
        >
          {hasApprovedMatches
            ? "No Applications yet. Click Generate resume to create the first."
            : "Approve at least one match in the Matches tab to enable generation."}
        </p>
      )}
    </section>
  );
}
