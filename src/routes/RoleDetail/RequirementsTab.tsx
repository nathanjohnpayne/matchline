/**
 * Requirements tab presentational component (sub-issue #201,
 * front-end for #19). Replaces the placeholder that shipped
 * with #129.
 *
 * Three states the tab can be in:
 *   1. `jd_raw` empty → "Paste JD text first" empty state with
 *      an inline editable textarea bound to `jd_raw`.
 *   2. `jd_raw` non-empty AND requirements empty → JD textarea
 *      + "Parse JD" button. Click → callable → subscription
 *      delivers parsed Requirements.
 *   3. requirements non-empty → parsed Requirements list +
 *      collapsible JD source pane + "Re-parse JD" with a
 *      confirm-replace warning (the parsing pipeline does
 *      atomic clear-and-replace keyed on (ownerUid, roleId),
 *      so re-parse drops the prior set).
 *
 * Status state machine mirrors Onboarding (#199), BulletEditor
 * (#188), and RoleNew (#200): editing / parsing / error.
 *
 * UI guidance baseline:
 *   - Rule 4: inline editing of the JD source.
 *   - Rule 6: thin top progress bar during parse, no spinner
 *     overlay.
 *   - Rule 8: data-dense Requirements list — show all parsed
 *     fields without truncation.
 *
 * Pure presentational; no Firestore. Container (`index.tsx`)
 * holds the in-flight + error state and the upsertRole +
 * invokeParseJobRequirements wiring.
 */

import {
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";

import type { JobRequirementUnit } from "../../types/capability.ts";
import OperationProgress from "../../components/OperationProgress.tsx";
import {
  JD_PARSING_VOCABULARY,
  TYPICAL_DURATION_MS,
  type ProgressEvent,
} from "../../services/progress.ts";

export type RequirementsTabStatus = "editing" | "parsing" | "error";

export interface RequirementsTabProps {
  /** Current persisted Role.jd_raw (may be ""). */
  readonly jdRaw: string;
  /**
   * Current draft contents of the JD textarea. Lifted to the
   * container (nathanpayne-codex Phase 4b P1 on PR #206) so a
   * tab switch (which unmounts RequirementsTab via the
   * activeTab conditional render) doesn't lose the user's
   * unsaved paste / edits.
   */
  readonly draft: string;
  /** Update the draft. Same shape as React's setState setter. */
  readonly onDraftChange: (next: string) => void;
  /** Current persisted Requirements (subscription-delivered). */
  readonly requirements: readonly JobRequirementUnit[];
  /** Parse-call status. */
  readonly status: RequirementsTabStatus;
  /** Latest parse progress event, or null before the first arrives (#428). */
  readonly parseProgress: ProgressEvent | null;
  /**
   * Epoch ms the parse started; drives elapsed time.
   *
   * Required, not optional-with-a-0-default: `0` is a valid-looking
   * number that renders elapsed time from the Unix epoch, so a caller
   * that forgot it produced a plausible component showing a ~56-year
   * duration rather than an obvious failure (CodeRabbit P2, #436).
   */
  readonly parseStartedAt: number;
  /** Last parse error, if any. Surfaced inline. */
  readonly error: Error | null;
  /** True while an upsertRole(jd_raw) save is in flight. */
  readonly savingJd: boolean;
  /**
   * True while the auto-trigger or post-parse `runMatching`
   * callable is in flight. Required to block a second
   * re-parse while matching is still computing — without
   * this, two concurrent matching runs could interleave and
   * the older one's transactional `replaceMatchesForRole`
   * could land last with matches against deleted requirement
   * IDs (nathanpayne-codex Phase 4b P1 on PR #206). The
   * `matches.length > 0` short-circuit in the auto-trigger
   * gate (#131) would then prevent recovery.
   */
  readonly computingMatches: boolean;
  /**
   * Save the current textarea contents to Role.jd_raw via
   * `upsertRole`. Container fires-and-forgets; failures are
   * console-logged. UI surfaces success via the textarea
   * value re-syncing with the persisted prop on next render.
   */
  readonly onSaveJd: (text: string) => void;
  /**
   * Trigger the parse pipeline. Container saves the textarea
   * contents to Role first (if dirty) before calling the
   * callable so the persisted JD matches what was parsed.
   */
  readonly onParseJd: (text: string) => void;
}

/**
 * Sort Requirements for display: must-haves first (the
 * matcher's hard floor — surface them visibly), then by
 * priority (high > medium > low), then by category for
 * stable grouping.
 */
const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function sortRequirements(
  reqs: readonly JobRequirementUnit[],
): readonly JobRequirementUnit[] {
  return [...reqs].sort((a, b) => {
    if (a.must_have !== b.must_have) return a.must_have ? -1 : 1;
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.category.localeCompare(b.category);
  });
}

export default function RequirementsTab({
  jdRaw,
  draft,
  onDraftChange,
  requirements,
  status,
  parseProgress,
  parseStartedAt,
  error,
  savingJd,
  computingMatches,
  onSaveJd,
  onParseJd,
}: RequirementsTabProps): ReactElement {
  // Draft is lifted to the container so tab switches don't
  // unmount the user's unsaved JD edit. The dirty-check + the
  // sync-on-persisted-change behavior also lives upstream;
  // this component is a controlled-input shell.

  // Confirmation gate for the destructive Re-parse path. Two-
  // click consent: first click flips this state, second click
  // (the now-renamed "Confirm: replace …" button) triggers the
  // parse. No window.confirm — the tests would have to stub
  // that, and the inline pattern is more accessible.
  const [confirmingReparse, setConfirmingReparse] = useState(false);

  const dirty = draft !== jdRaw;
  const draftEmpty = draft.trim().length === 0;
  const hasRequirements = requirements.length > 0;
  const parsing = status === "parsing";
  // Disable destructive / mutating affordances while either
  // an upsertRole save, a parse, OR a runMatching is in
  // flight. Blocking on `computingMatches` is load-bearing
  // for a re-parse race (nathanpayne-codex Phase 4b P1 on
  // PR #206): the parse-success path flips parsingStatus
  // back to "editing" while invokeRunMatching is still
  // settling. Without this gate, a second re-parse could
  // launch a fresh requirements set + matching run while
  // the older matching run is still in flight, and an
  // out-of-order commit would leave matches referencing
  // deleted requirement IDs. The `matches.length > 0`
  // short-circuit in the auto-trigger gate (#131) wouldn't
  // recover. Disabling parse until matching settles closes
  // the race at the UI layer; a server-side requirements-
  // version guard is the deeper fix and is out of scope here.
  const busy = parsing || savingJd || computingMatches;

  const onChangeText = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onDraftChange(e.target.value);
    // Clicking back into edit mode after triggering re-parse
    // should silently abort the confirm flow — the user
    // changed their mind.
    if (confirmingReparse) setConfirmingReparse(false);
  };

  const handleSaveJd = (): void => {
    if (busy) return;
    onSaveJd(draft);
  };

  const handleParse = (): void => {
    if (busy) return;
    if (draftEmpty) return;
    if (hasRequirements && !confirmingReparse) {
      setConfirmingReparse(true);
      return;
    }
    setConfirmingReparse(false);
    onParseJd(draft);
  };

  const handleCancelReparse = (): void => {
    setConfirmingReparse(false);
  };

  return (
    <section
      className="space-y-4"
      data-testid="requirements-tab"
      data-requirements-tab-status={status}
    >
      {/* Thin top progress bar per UI guidance rule 6 — only
          visible while a parse is in flight. */}
      {parsing && (
        <OperationProgress
          event={parseProgress}
          startedAt={parseStartedAt}
          vocabulary={JD_PARSING_VOCABULARY}
          typicalMs={TYPICAL_DURATION_MS.jdParsing}
          label="Parsing job requirements"
          testId="requirements-tab-progress"
        />
      )}

      {status === "error" && error !== null && (
        <p
          role="alert"
          data-testid="requirements-tab-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error.message}
        </p>
      )}

      {/* JD source pane. Always present so the user can edit
          jd_raw in place per acceptance criterion #1 (empty)
          and rule 4 (inline editing). When Requirements
          already exist, the pane sits above the list so the
          user sees the source they're editing. */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label
            htmlFor="requirements-tab-jd"
            className="text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            JD source{" "}
            {draftEmpty && (
              <span className="text-zinc-400 dark:text-zinc-600">
                (paste JD text first)
              </span>
            )}
          </label>
          {dirty && (
            <span
              className="text-xs italic text-amber-700 dark:text-amber-400"
              data-testid="requirements-tab-jd-dirty"
            >
              unsaved changes
            </span>
          )}
        </div>
        <textarea
          id="requirements-tab-jd"
          value={draft}
          onChange={onChangeText}
          disabled={busy}
          rows={hasRequirements ? 6 : 12}
          placeholder={
            "Paste the full JD as plain text. Headers and bullet points are fine."
          }
          data-testid="requirements-tab-jd-textarea"
          className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
        />
        <div className="flex items-center justify-end gap-2">
          {savingJd && (
            <span
              className="text-xs italic text-zinc-500"
              data-testid="requirements-tab-jd-saving"
              aria-live="polite"
            >
              Saving&hellip;
            </span>
          )}
          {dirty && !confirmingReparse && (
            <button
              type="button"
              onClick={handleSaveJd}
              // Save JD intentionally allows an empty draft so
              // the user can clear an existing JD from the UI
              // (Codex finding round 4 on PR #206). Only the
              // in-flight gate (`busy`) blocks here. Parse JD
              // still requires non-empty draft — see the gates
              // on the Parse / Confirm buttons below.
              disabled={busy}
              data-action="requirements-save-jd"
              className="rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Save JD
            </button>
          )}

          {/* Parse / Re-parse / Confirm buttons. The "Confirm"
              path only appears once the user clicks Re-parse;
              this is the inline two-click destructive consent
              pattern (no modal). */}
          {confirmingReparse ? (
            <>
              <span
                className="text-xs text-amber-700 dark:text-amber-400"
                data-testid="requirements-tab-reparse-warning"
                role="alert"
              >
                Re-parse will replace your {requirements.length} existing
                requirement{requirements.length === 1 ? "" : "s"}.
              </span>
              <button
                type="button"
                onClick={handleCancelReparse}
                disabled={busy}
                data-action="requirements-cancel-reparse"
                className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleParse}
                disabled={busy || draftEmpty}
                data-action="requirements-confirm-reparse"
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-red-500 dark:hover:bg-red-400"
              >
                Confirm replace
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={handleParse}
              disabled={busy || draftEmpty}
              data-action="requirements-parse-jd"
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {hasRequirements ? "Re-parse JD" : "Parse JD"}
            </button>
          )}
        </div>
      </div>

      {/* Requirements list / empty state below the JD pane. */}
      {hasRequirements ? (
        <ol
          data-testid="requirements-tab-list"
          className="space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
        >
          {sortRequirements(requirements).map((req) => (
            <li
              key={req.id}
              data-testid="requirements-tab-row"
              data-requirement-id={req.id}
              className="rounded border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-zinc-900 dark:text-zinc-100">
                  {req.normalized_requirement}
                </p>
                <div className="flex shrink-0 items-center gap-2 text-xs">
                  {req.must_have && (
                    <span
                      className="rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-700 dark:bg-red-950 dark:text-red-400"
                      data-testid="requirements-tab-must-have"
                    >
                      must-have
                    </span>
                  )}
                  <span
                    className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    data-testid="requirements-tab-priority"
                  >
                    priority: {req.priority}
                  </span>
                  <span
                    className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    data-testid="requirements-tab-category"
                  >
                    {req.category}
                  </span>
                </div>
              </div>
              {(req.keywords.length > 0 ||
                req.tools.length > 0 ||
                req.domains.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {req.keywords.length > 0 && (
                    <span data-testid="requirements-tab-keywords">
                      keywords: {req.keywords.join(", ")}
                    </span>
                  )}
                  {req.tools.length > 0 && (
                    <span data-testid="requirements-tab-tools">
                      tools: {req.tools.join(", ")}
                    </span>
                  )}
                  {req.domains.length > 0 && (
                    <span data-testid="requirements-tab-domains">
                      domains: {req.domains.join(", ")}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p
          className="border-t border-zinc-200 pt-4 text-sm text-zinc-500 dark:border-zinc-800"
          data-testid="requirements-tab-empty"
        >
          {draftEmpty
            ? "Paste JD text above, then click Parse JD."
            : "JD ready. Click Parse JD to extract structured Requirements."}
        </p>
      )}
    </section>
  );
}
