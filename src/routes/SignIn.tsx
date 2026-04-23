/**
 * Sign-in surface. Minimalist centered-card layout per
 * `docs/design/ui-guidance.md § Sign-in (#57)`: no marketing, one
 * primary action, monochrome aesthetic with restrained accent.
 *
 * V1 uses Firebase Auth's email/password provider (the only method
 * enabled on matchline-dev as of 2026-04-23). Switching to Google
 * SSO later is a provider flip + a button variant; the form shape
 * below stays the same.
 */

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { getAuthClient } from "../firebase.ts";
import { useCurrentUser } from "../lib/auth.tsx";
import { friendlyAuthError } from "../lib/auth-errors.ts";

type Mode = "sign-in" | "create-account";

/**
 * Client-side minimum for new accounts. Stricter than Firebase's
 * default server-side policy (6 chars) so a new account won't be
 * created below this threshold. Sign-in does NOT enforce this —
 * existing accounts with older/looser passwords must still work.
 */
const MIN_NEW_PASSWORD_LENGTH = 8;

export default function SignIn() {
  const navigate = useNavigate();
  const { user, pending } = useCurrentUser();

  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in → bounce to the post-auth landing surface.
  // Use <Navigate> rather than calling navigate() during render —
  // calling the imperative navigate() mid-render is a side-effect
  // that violates React's render purity and can trip Strict Mode's
  // double-render warning.
  if (!pending && user) {
    return <Navigate to="/units" replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    // Client-side policy enforcement. The <form> carries noValidate
    // so the browser's bubble-style validation doesn't fire — that
    // means `minLength={MIN_NEW_PASSWORD_LENGTH}` on the input is
    // UX hint, not a gate. Enforce the policy here for create-account
    // mode only; sign-in mode must accept any length because existing
    // accounts may have been created under an older/looser policy.
    if (mode === "create-account" && password.length < MIN_NEW_PASSWORD_LENGTH) {
      setError("That password is too short. Try a longer one.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const auth = getAuthClient();
      if (mode === "sign-in") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        await createUserWithEmailAndPassword(auth, email, password);
      }
      navigate("/units", { replace: true });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            match<span className="text-zinc-400 dark:text-zinc-500">|</span>line
          </div>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            From what you&rsquo;ve done to what&rsquo;s next.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          noValidate
        >
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Email
              </span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 transition duration-150 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-100 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-900"
                disabled={busy}
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Password
              </span>
              <input
                type="password"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                required
                minLength={mode === "create-account" ? MIN_NEW_PASSWORD_LENGTH : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 transition duration-150 placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-zinc-100 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-900"
                disabled={busy}
              />
            </label>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !email || !password}
              className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition duration-150 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-900"
            >
              {busy
                ? mode === "sign-in"
                  ? "Signing in…"
                  : "Creating account…"
                : mode === "sign-in"
                  ? "Sign in"
                  : "Create account"}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === "sign-in" ? "create-account" : "sign-in");
                setError(null);
              }}
              className="w-full text-center text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {mode === "sign-in"
                ? "Don't have an account? Create one."
                : "Already have an account? Sign in."}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

