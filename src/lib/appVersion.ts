/**
 * Update-detection primitives for the reload prompt (#429).
 *
 * Everything decision-shaped lives here as a pure function so it can be
 * tested without a timer, a network, or a DOM. `UpdatePrompt.tsx` owns
 * only the polling loop and the markup.
 *
 * **Mechanism.** matchline has no service worker — `vite.config.ts`
 * registers only `@vitejs/plugin-react` — so this follows the poll
 * pattern that `friends-and-family-billing` and `overridebroadway`
 * already use rather than the `vite-plugin-pwa` route `fiveacross`
 * takes. Adopting a whole PWA surface (worker registration, offline
 * caching semantics, install prompts) to answer "is there a newer
 * build?" would be a large side effect for a small question. The
 * *behavioural* refinements fiveacross learned are worth borrowing
 * regardless of mechanism, and two of them are implemented below.
 */

/**
 * The running build's id. Falls back to `""` under test and in any
 * context where the define did not run — `shouldPromptForUpdate`
 * treats an empty current build as "cannot compare", so a missing
 * stamp disables the prompt rather than firing it constantly.
 */
export const CURRENT_BUILD_ID: string =
  typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "";

/** Where the poll looks. Emitted into `dist/` by the build. */
export const VERSION_URL = "/version.json";

const DISMISSED_KEY = "matchline:dismissed-build";

export interface VersionPayload {
  readonly buildId: string;
}

/**
 * Parse a `/version.json` response body.
 *
 * **Why this is stricter than `JSON.parse` in a `try`.** `firebase.json`
 * rewrites `**` to `/index.html`. A real `dist/version.json` is matched
 * as a static file first, so the happy path is fine — but if the build
 * step ever stops emitting it, the fetch returns the SPA's HTML with a
 * 200. `JSON.parse` then throws into the caller's catch, the catch is
 * written to tolerate offline clients, and the version check is
 * silently dead forever. That is the failure mode #429 called out, and
 * it is indistinguishable from "no update available" unless the shape
 * is checked explicitly.
 *
 * Returns `null` for anything that is not a well-formed payload, so the
 * caller can tell "not a version document" from "no newer build".
 */
export function parseVersionPayload(raw: unknown): VersionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const buildId = (raw as { buildId?: unknown }).buildId;
  if (typeof buildId !== "string" || buildId.trim() === "") return null;
  return { buildId: buildId.trim() };
}

/** Read the build the user last declined. Storage may be unavailable. */
export function readDismissedBuild(
  storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage(),
): string | null {
  try {
    return storage?.getItem(DISMISSED_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Persist a declined build. Silent no-op where storage is unavailable. */
export function rememberDismissedBuild(
  buildId: string,
  storage: Pick<Storage, "setItem"> | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(DISMISSED_KEY, buildId);
  } catch {
    // Private mode, disabled site data, quota. Losing the dismissal
    // means the prompt reappears next poll — annoying, never broken.
  }
}

/**
 * `localStorage`, or `undefined` where merely touching it throws.
 * Some privacy modes make the getter itself raise a `SecurityError`,
 * which would escape a plain `try { localStorage.getItem }`.
 */
function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export interface ShouldPromptInput {
  /** Build id of the running bundle. */
  readonly currentBuildId: string;
  /** Build id most recently observed at `VERSION_URL`, if readable. */
  readonly latestBuildId: string | null;
  /** Build the user declined, if any. */
  readonly dismissedBuildId: string | null;
  /**
   * True while a long-running operation is in flight. See
   * `src/lib/appBusy.ts`.
   */
  readonly busy: boolean;
}

/**
 * Decide whether to offer a reload.
 *
 * Three rules, in order, each earning its place:
 *
 * 1. **Comparable or nothing.** An unknown current or latest build
 *    means no prompt. Guessing produces a banner the user can never
 *    dismiss.
 * 2. **Never interrupt work.** `fiveacross` suppresses its banner while
 *    a proof capture is open (#219 there). matchline's equivalent is an
 *    in-flight extraction — a ~108s call (#428). Offering a reload
 *    mid-extraction invites the user to destroy a call that is about to
 *    succeed and to pay the Anthropic cost a second time. Suppression
 *    is display-only: the newer build is still observed, so the prompt
 *    appears the moment the operation settles.
 * 3. **Dismissal is per build, not per session.** `fiveacross` #605
 *    learned this the hard way: an in-memory "Not now" re-prompts on
 *    every subsequent check for the same build, while a persisted
 *    session flag hides genuinely newer builds forever. Keying the
 *    decline to the build id gives both — that build stays quiet, the
 *    next one asks again.
 */
export function shouldPromptForUpdate(input: ShouldPromptInput): boolean {
  const { currentBuildId, latestBuildId, dismissedBuildId, busy } = input;
  if (currentBuildId === "" || latestBuildId === null || latestBuildId === "") {
    return false;
  }
  if (latestBuildId === currentBuildId) return false;
  if (busy) return false;
  if (dismissedBuildId !== null && dismissedBuildId === latestBuildId) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

export interface VersionPollerOptions {
  /** Injected for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Called with each newly observed build id. */
  readonly onBuildId: (buildId: string) => void;
}

export interface VersionPoller {
  /** Run one check. Resolves when it has settled, for tests. */
  readonly check: () => Promise<void>;
  /** Stop accepting results. Idempotent. */
  readonly stop: () => void;
}

/**
 * Poll `VERSION_URL` for the deployed build id.
 *
 * Extracted from the component so the fetch/parse/ordering logic is
 * testable without a DOM. The repo has no jsdom or Testing Library in
 * devDependencies and its component convention is
 * `renderToStaticMarkup`, so a React-effect fixture would have meant
 * adding a test stack to cover logic that does not need React at all.
 * Codex P1 on PR #434 asked for coverage of this path; extracting it
 * gives that without the dependency.
 *
 * **Ordering.** The interval starts a new check without awaiting the
 * previous one, so a slow response carrying build A can land after a
 * later poll already saw build B and drag `latestBuildId` backwards —
 * hiding the prompt until another successful poll, possibly
 * indefinitely if the tab is then throttled or offline. Each check
 * takes a monotonic sequence number and a stale one is discarded.
 * Codex P2, same round.
 */
export function createVersionPoller({
  fetchImpl,
  onBuildId,
}: VersionPollerOptions): VersionPoller {
  const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let issued = 0;
  let newestApplied = 0;
  let stopped = false;

  const check = async (): Promise<void> => {
    const seq = ++issued;
    try {
      // Cache-busting query AND `no-store`: `firebase.json` sets
      // `no-cache` on this path, but an intermediary that ignores the
      // header would otherwise pin the first response forever and the
      // check would never observe a deploy.
      const res = await doFetch(`${VERSION_URL}?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = parseVersionPayload(await res.json());
      // `null` means the response was not a version document — most
      // likely the SPA's index.html arriving via the catch-all rewrite.
      // Treat it as "no reading", never as "no update".
      if (payload === null) return;
      if (stopped || seq <= newestApplied) return;
      newestApplied = seq;
      onBuildId(payload.buildId);
    } catch {
      // Offline, DNS, or a non-JSON body. Transient by assumption; the
      // next tick tries again.
    }
  };

  return {
    check,
    stop: () => {
      stopped = true;
    },
  };
}
