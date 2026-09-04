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

import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";

import { isAppBusy, subscribeAppBusy } from "../lib/appBusy.ts";
import {
  CURRENT_BUILD_ID,
  createVersionPoller,
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
  // useSyncExternalStore, not useState + useEffect: the latter reads the
  // store at mount and subscribes in a later passive effect, so a lease
  // transition in that window is missed and the value stays stale. For
  // `dirty` that is a data-loss path — the first Reload click would skip
  // confirmation and discard the editor's content (CodeRabbit P1, #434).
  const busy = useSyncExternalStore(subscribeAppBusy, isAppBusy);


  useEffect(() => {
    // No stamp means the define did not run (dev server, test). There
    // is nothing to compare against, so don't poll at all.
    if (CURRENT_BUILD_ID === "") return;

    const poller = createVersionPoller({ onBuildId: setLatestBuildId });
    void poller.check();
    const id = setInterval(() => void poller.check(), POLL_INTERVAL_MS);
    return () => {
      // stop() before clearInterval: an in-flight response must not
      // reach setState after unmount.
      poller.stop();
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

  // ui-guidance.md § Motion: "Respect prefers-reduced-motion: every
  // transition class wrapped or gated accordingly." `motion-safe:`
  // gates rather than merely overriding, so nothing animates for a
  // user who asked for stillness (Codex P1, #434).
  const TRANSITION = "motion-safe:transition-colors motion-safe:duration-150";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-prompt"
      // In the shell's flex column rather than `fixed`: a fixed
      // banner sat over the bottom of the scroll container, and on
      // pages whose content reaches the bottom (Onboarding, New Role)
      // the final form actions ended up underneath it. Occupying real
      // layout space costs a row and cannot obscure anything
      // (Codex P2, #434).
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
    >
      <span>A new version of match&#124;line is available.</span>
      <button
        type="button"
        data-action="update-reload"
        onClick={() => window.location.reload()}
        className={`rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 ${TRANSITION} ${FOCUS_RING}`}
      >
        Reload
      </button>
      <button
        type="button"
        data-action="update-dismiss"
        onClick={onDismiss}
        className={`rounded-md px-2 py-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 ${TRANSITION} ${FOCUS_RING}`}
      >
        Not now
      </button>
    </div>
  );
}
