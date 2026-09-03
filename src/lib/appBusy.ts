/**
 * "Is a long-running operation in flight?" — a tiny module-level store
 * (#429).
 *
 * The update-reload prompt must not appear while an extraction, JD
 * parse, or resume generation is running: those are calls with 300-540s
 * budgets (`services/callable-timeouts.ts`), and offering a reload
 * mid-flight invites the user to destroy a call that is about to
 * succeed and pay the Anthropic cost twice. `fiveacross` learned the
 * same rule against its proof-capture sheet (#219 there).
 *
 * **Why a store rather than React context.** The producers
 * (`Onboarding`, `RoleDetail`) and the consumer (`UpdatePrompt`,
 * mounted in the app shell) sit on different branches of the tree, so a
 * provider would have to wrap the whole app to relate them. A store
 * keeps the relationship explicit and, being outside React, is testable
 * without rendering anything.
 *
 * **Why a lease rather than a keyed flag.** The first version took a
 * caller-supplied string key, and Codex found the race on PR #434: an
 * extraction survives navigation away from Onboarding, the user returns
 * and starts a second one, and when the *first* settles its `delete`
 * clears the only `onboarding.extract` entry while the second is still
 * running — exposing the reload prompt during a live call. The same
 * applied to parses of different Roles.
 *
 * Handing back a release function instead makes that unrepresentable:
 * every invocation holds its own lease, and releasing one cannot
 * release another's. The label survives only as a debugging aid.
 */

type Listener = (busy: boolean) => void;

/** Active leases, keyed by an internally-generated token. */
const leases = new Map<number, string>();
const listeners = new Set<Listener>();
let nextToken = 1;

/** True while any operation holds a lease. */
export function isAppBusy(): boolean {
  return leases.size > 0;
}

function notify(before: boolean): void {
  const after = isAppBusy();
  if (before === after) return;
  for (const listener of listeners) {
    try {
      listener(after);
    } catch {
      // One bad subscriber must not stop the others, and must never
      // propagate into the caller's request path.
    }
  }
}

/**
 * Take a busy lease for one operation. Returns a release function.
 *
 * The release is idempotent — React effects and `finally` blocks can
 * both run, and a second call is a no-op rather than releasing someone
 * else's lease.
 *
 * @param label human-readable owner, e.g. `"onboarding.extract"`. Not
 *   used for identity; two concurrent operations may share a label.
 */
export function beginAppBusy(label: string): () => void {
  const token = nextToken++;
  const before = isAppBusy();
  leases.set(token, label);
  notify(before);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const wasBusy = isAppBusy();
    leases.delete(token);
    notify(wasBusy);
  };
}

/** Subscribe to aggregate busy changes. Returns an unsubscribe. */
export function subscribeAppBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop all state so cases cannot leak into one another. */
export function _resetAppBusyForTests(): void {
  leases.clear();
  listeners.clear();
  nextToken = 1;
}
