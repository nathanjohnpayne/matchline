/**
 * Browser-local persistence for in-progress form drafts (#431).
 *
 * A form whose only copy lives in React state loses everything on a
 * reload, a tab close, or an accidental navigation. Drafts are stored
 * in `localStorage` under a per-route key so returning to the route
 * restores what was typed.
 *
 * Every draft shares one key prefix so they can all be dropped in one
 * call (`clearAllFormDrafts`): `localStorage` is per-browser, not
 * per-account, and a draft typed by one account must not reappear for
 * the next one to sign in on the same machine. Two paths enforce that:
 * the Sign out button clears drafts, and `claimFormDrafts` clears them
 * whenever a different account signs in, which also covers a session
 * that ended without the button (token expiry, sign-out in another tab).
 *
 * Storage failures never throw. Private modes, disabled site data and
 * quota errors degrade to "no persistence", which is the behavior the
 * form had before this module existed.
 */

const PREFIX = "matchline:draft:";
/** Uid of the account the stored drafts belong to. */
const OWNER_KEY = "matchline:draft-owner";

/**
 * `localStorage`, or `undefined` where merely touching it throws.
 * Same guard as `src/lib/appVersion.ts`: some privacy modes make the
 * getter itself raise a `SecurityError`.
 */
function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read the raw JSON value stored for `key`. Returns `undefined` when
 * nothing is stored, the value is not valid JSON, or storage is
 * unavailable. Callers validate the shape themselves.
 */
export function loadFormDraft(
  key: string,
  storage: Storage | undefined = safeLocalStorage(),
): unknown {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (raw === null || raw === undefined) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveFormDraft(
  key: string,
  value: unknown,
  storage: Storage | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage: the draft is simply not persisted.
  }
}

export function clearFormDraft(
  key: string,
  storage: Storage | undefined = safeLocalStorage(),
): void {
  try {
    storage?.removeItem(PREFIX + key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Remove every stored draft. Called on sign-out. */
export function clearAllFormDrafts(
  storage: Storage | undefined = safeLocalStorage(),
): void {
  try {
    if (storage === undefined) return;
    // Collect first: removing while iterating shifts `key(i)`.
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Storage unavailable: there are no drafts to leak.
  }
}

/**
 * Record `uid` as the owner of the stored drafts, clearing every draft
 * first when they belong to a different account (or to no recorded
 * account). Call it as soon as a user is known and before any route
 * reads its draft.
 */
export function claimFormDrafts(
  uid: string,
  storage: Storage | undefined = safeLocalStorage(),
): void {
  try {
    if (storage === undefined) return;
    if (storage.getItem(OWNER_KEY) === uid) return;
    clearAllFormDrafts(storage);
    storage.setItem(OWNER_KEY, uid);
  } catch {
    // Storage unavailable: no drafts are persisted, so none can leak.
  }
}
