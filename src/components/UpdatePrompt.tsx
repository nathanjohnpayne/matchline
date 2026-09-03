/**
 * Update-reload prompt (#429).
 *
 * Polls `/version.json` and offers a reload once a newer build is
 * deployed, so a long-lived tab stops silently running superseded code.
 * All of the decision logic lives in `src/lib/appVersion.ts`; this file
 * owns the loop and the markup.
 *
 * Follows the poll pattern from `friends-and-family-billing` and
 * `overridebroadway` rather than `fiveacross`'s service worker —
 * matchline has no PWA surface to hang one on. See `appVersion.ts` for
 * the full rationale and for the two fiveacross behaviours borrowed
 * here (per-build dismissal, never interrupt work in progress).
 *
 * Rendered as a bottom banner rather than a modal, deliberately: this
 * is not urgent, and `docs/design/ui-guidance.md` rule 6 rejects
 * blocking overlays. The user should be able to ignore it indefinitely
 * and keep working.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";

import {
  hasUnsavedWork,
  isAppBusy,
  subscribeAppBusy,
  subscribeUnsavedWork,
} from "../lib/appBusy.ts";
import {
  CURRENT_BUILD_ID,
  VERSION_URL,
  parseVersionPayload,
  readDismissedBuild,
  rememberDismissedBuild,
  shouldPromptForUpdate,
} from "../lib/appVersion.ts";

/**
 * Poll cadence. 60s matches every other app in this portfolio; the
 * cost is one small conditional GET per minute per open tab.
 */
const POLL_INTERVAL_MS = 60_000;

export default function UpdatePrompt(): ReactElement | null {
  const [latestBuildId, setLatestBuildId] = useState<string | null>(null);
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(() =>
    readDismissedBuild(),
  );
  const [busy, setBusy] = useState<boolean>(() => isAppBusy());
  const [dirty, setDirty] = useState<boolean>(() => hasUnsavedWork());
  const [confirming, setConfirming] = useState(false);

  // Track in-flight long operations so the banner can hold off. The
  // poll keeps running underneath — only display is suppressed, so the
  // prompt appears the instant the operation settles.
  useEffect(() => subscribeAppBusy(setBusy), []);
  // Unsaved editor content does NOT suppress the banner — see
  // appBusy.ts — but it does gate the reload behind a confirmation,
  // because that content lives only in React state (Codex P2, #434).
  useEffect(() => subscribeUnsavedWork(setDirty), []);

  useEffect(() => {
    // No stamp means the define did not run (dev server, test). There
    // is nothing to compare against, so don't poll at all.
    if (CURRENT_BUILD_ID === "") return;

    let cancelled = false;

    const check = async (): Promise<void> => {
      try {
        // Cache-busting query AND no-store: `firebase.json` now sets
        // `no-cache` on this path, but an intermediary that ignores the
        // header would otherwise pin the first response forever and the
        // check would never observe a deploy.
        const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const payload = parseVersionPayload(await res.json());
        // `null` means the response was not a version document — most
        // likely the SPA's index.html arriving via the catch-all
        // rewrite. Treat it as "no reading", never as "no update".
        if (payload === null || cancelled) return;
        setLatestBuildId(payload.buildId);
      } catch {
        // Offline, DNS, or a non-JSON body. Transient by assumption;
        // the next tick tries again.
      }
    };

    void check();
    const id = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onDismiss = useCallback(() => {
    if (latestBuildId === null) return;
    rememberDismissedBuild(latestBuildId);
    setDismissedBuildId(latestBuildId);
  }, [latestBuildId]);

  const visible = shouldPromptForUpdate({
    currentBuildId: CURRENT_BUILD_ID,
    latestBuildId,
    dismissedBuildId,
    busy,
  });

  if (!visible) return null;

  const FOCUS_RING =
    // ui-guidance.md line 120: every interactive element has a visible
    // focus ring. Ring + offset so it reads against the banner's own
    // background in both themes (Codex P1, #434).
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-zinc-100 dark:focus-visible:ring-offset-zinc-900";

  const onReloadClick = (): void => {
    // One extra click when there is unsaved content, rather than a
    // blocking confirm() dialog: it keeps the choice in the banner and
    // states exactly what is at risk.
    if (dirty && !confirming) {
      setConfirming(true);
      return;
    }
    window.location.reload();
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-prompt"
      data-confirming={confirming ? "true" : "false"}
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
    >
      <span>
        {confirming
          ? "Reloading will discard your unsaved changes on this page."
          : "A new version of match\u007Cline is available."}
      </span>
      <button
        type="button"
        data-action="update-reload"
        onClick={onReloadClick}
        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-150 ${FOCUS_RING} ${
          confirming
            ? "bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-zinc-900 dark:hover:bg-amber-400"
            : "bg-zinc-900 text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        }`}
      >
        {confirming ? "Reload anyway" : "Reload"}
      </button>
      <button
        type="button"
        data-action="update-dismiss"
        onClick={confirming ? () => setConfirming(false) : onDismiss}
        className={`rounded-md px-2 py-1.5 text-xs font-medium text-zinc-500 transition-colors duration-150 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS_RING}`}
      >
        {confirming ? "Keep editing" : "Not now"}
      </button>
    </div>
  );
}
