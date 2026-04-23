/**
 * Client-side auth state. `AuthProvider` subscribes to Firebase Auth's
 * `onAuthStateChanged` and exposes the current `User` via context;
 * `useCurrentUser()` is the hook every route + service call uses to
 * scope its work to the signed-in owner.
 *
 * Sub-issue #57 (parent #16) — the first Phase 1 deliverable. Read
 * `docs/design/ui-guidance.md` for the surface direction.
 */

import { onAuthStateChanged, type User } from "firebase/auth";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { getAuthClient } from "../firebase.ts";

export interface AuthState {
  /** Currently signed-in user, or `null` once auth has resolved. */
  readonly user: User | null;
  /** True until Firebase Auth's first `onAuthStateChanged` callback. */
  readonly pending: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getAuthClient(), (next) => {
      setUser(next);
      setPending(false);
    });
    return unsubscribe;
  }, []);

  const value = useMemo<AuthState>(() => ({ user, pending }), [user, pending]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the current auth state. Returns `{ user: null, pending: true }`
 * on first render before Firebase has resolved. Routes that need a
 * signed-in user should render a `<PendingAuth>` splash while `pending`
 * is true and redirect to `/sign-in` when it flips to false and `user`
 * is still null.
 */
export function useCurrentUser(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error(
      "useCurrentUser() must be used inside <AuthProvider>. Wrap the app " +
        "root in main.tsx or update the test harness to provide it.",
    );
  }
  return ctx;
}
