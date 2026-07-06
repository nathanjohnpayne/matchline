/**
 * Sign-in surface. Minimalist centered-card layout per
 * `docs/design/ui-guidance.md § Sign-in (#57)`: no marketing, one
 * primary action, monochrome aesthetic with restrained accent.
 *
 * Two auth methods on matchline-dev:
 *   1. Google SSO (primary; one-click via popup) — recommended
 *      for a single-user-V1 cloud-resident app where there's no
 *      reason to manage passwords.
 *   2. Email + password (fallback; rendered below an "or" divider)
 *      — kept for the no-popup case (corporate networks, strict
 *      browser privacy) and for any pre-existing accounts.
 */

import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import Wordmark from "../components/Wordmark.tsx";
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

  async function onGoogleSignIn() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const auth = getAuthClient();
      // Popup flow: simpler return path than redirect (no
      // post-redirect bounce-handling, no auth state recovery on
      // load). If a user's browser blocks popups they can fall
      // back to the email/password form below. We don't pre-call
      // `provider.setCustomParameters({ prompt: "select_account" })`
      // — Firebase's default lets Google reuse the active session,
      // which matches the "one click" promise.
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      navigate("/units", { replace: true });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
    }
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

    const normalizedEmail = email.trim();
    if (!normalizedEmail) {
      setError("Enter an email address.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const auth = getAuthClient();
      if (mode === "sign-in") {
        await signInWithEmailAndPassword(auth, normalizedEmail, password);
      } else {
        await createUserWithEmailAndPassword(auth, normalizedEmail, password);
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
          <Wordmark className="text-3xl text-zinc-900 dark:text-zinc-100" />
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            From what you&rsquo;ve done to what&rsquo;s next.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          {/* Primary path: Google SSO. Sits above the divider so
              the "no password to manage" path is the obvious one. */}
          <button
            type="button"
            onClick={onGoogleSignIn}
            disabled={busy}
            data-action="sign-in-google"
            className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 transition duration-150 hover:bg-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-100 dark:focus:ring-offset-zinc-900"
          >
            {/* Inline SVG of the Google "G" mark — avoids a remote
                request and survives offline / strict-CSP scenarios.
                Sized to match the button's text height. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 18 18"
              className="h-4 w-4"
            >
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
              />
            </svg>
            {busy ? "Signing in…" : "Continue with Google"}
          </button>

          {/* Visible "or" divider — restrained accent per UI
              guidance. The label sits in the line so the eye
              can move past it without re-anchoring. */}
          <div
            className="my-5 flex items-center gap-3 text-xs text-zinc-400 dark:text-zinc-500"
            aria-hidden="true"
          >
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
            <span>or</span>
            <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-700" />
          </div>

          <form onSubmit={onSubmit} noValidate>
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
                if (busy) return;
                setMode(mode === "sign-in" ? "create-account" : "sign-in");
                setError(null);
              }}
              disabled={busy}
              className="w-full text-center text-xs text-zinc-500 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {mode === "sign-in"
                ? "Don't have an account? Create one."
                : "Already have an account? Sign in."}
            </button>
          </div>
          </form>
        </div>
      </div>
    </div>
  );
}

