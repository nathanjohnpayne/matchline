/**
 * "Is a long-running operation in flight?" — a tiny module-level store
 * (#429).
 *
 * The update-reload prompt must not appear while an extraction or JD
 * parse is running: those are ~108s calls (#428), and offering a reload
 * mid-flight invites the user to destroy a call that is about to
 * succeed and pay the Anthropic cost twice. `fiveacross` learned the
 * same rule against its proof-capture sheet (#219 there).
 *
 * **Why a store rather than React context.** The producers
 * (`Onboarding`, `RoleDetail`) and the consumer (`UpdatePrompt`,
 * mounted in the app shell) sit on different branches of the tree, so a
 * provider would have to wrap the whole app to relate them. A keyed
 * store keeps the relationship explicit and, being outside React, is
 * testable without rendering anything.
 *
 * **Why keyed.** Two surfaces can be busy independently — a JD parse on
 * one Role while an extraction runs elsewhere. A boolean would let
 * whichever finished first clear the other's suppression. The key is
 * the owning surface; busy is the union.
 */

type Listener = (busy: boolean) => void;

const busyKeys = new Set<string>();
const listeners = new Set<Listener>();

/** True while any surface has an operation in flight. */
export function isAppBusy(): boolean {
  return busyKeys.size > 0;
}

/**
 * Mark `key` busy or idle. Idempotent — a `Set` absorbs a repeated
 * set/clear, which matters because React effects can re-run.
 *
 * Listeners fire only on a change of the aggregate, so a second
 * surface becoming busy while one already is does not churn.
 */
export function setAppBusy(key: string, busy: boolean): void {
  const before = isAppBusy();
  if (busy) busyKeys.add(key);
  else busyKeys.delete(key);
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

/** Subscribe to aggregate busy changes. Returns an unsubscribe. */
export function subscribeAppBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop all state so cases cannot leak into one another. */
export function _resetAppBusyForTests(): void {
  busyKeys.clear();
  listeners.clear();
}
