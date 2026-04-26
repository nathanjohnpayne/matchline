import { signOut } from "firebase/auth";
import { Suspense, lazy } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";

import Wordmark from "./components/Wordmark.tsx";
import { getAuthClient } from "./firebase.ts";
import { useCurrentUser } from "./lib/auth.tsx";
import ApplicationEditor from "./routes/ApplicationEditor.tsx";
import Onboarding from "./routes/Onboarding.tsx";
import Pipeline from "./routes/Pipeline.tsx";
import RoleDetail from "./routes/RoleDetail/index.tsx";
import SignIn from "./routes/SignIn.tsx";
import UnitReview from "./routes/UnitReview/index.tsx";

/**
 * True iff the dev-only debug routes (e.g. PDF prototype)
 * should be registered. Vite's `import.meta.env.DEV` is
 * true under `npm run dev` and statically false in
 * production builds — the false branch tree-shakes
 * entirely from the production bundle.
 *
 * cursor #140 r1: the prior shape registered debug routes
 * in production, exposing the route surface to any
 * authenticated user who guessed the URL.
 *
 * Exported for `App.test.tsx` to verify the gate's
 * behavior. The actual bundle-time value is what matters
 * — this export is just the runtime mirror.
 */
export const DEBUG_ROUTES_ENABLED: boolean = import.meta.env.DEV;

// Lazy-load the PDF prototype route: `@react-pdf/renderer`
// is ~1.5MB minified and only used by the debug surface
// (#50 / `/debug/pdf-prototype`).
//
// The lazy import is itself gated on DEBUG_ROUTES_ENABLED.
// Under production, Vite's static replacement of
// `import.meta.env.DEV` collapses this to
// `const PdfPrototype = null;` and tree-shakes the
// `import("./routes/debug/PdfPrototype.tsx")` reference,
// so the 1.5MB chunk isn't even emitted into dist/.
// Under `npm run dev` the lazy import is active and the
// chunk loads on first navigation.
const PdfPrototype = DEBUG_ROUTES_ENABLED
  ? lazy(() => import("./routes/debug/PdfPrototype.tsx"))
  : null;

const navItems = [
  { to: "/onboarding", label: "Onboarding" },
  { to: "/units", label: "Unit Review" },
  { to: "/roles/example", label: "Role Detail" },
  { to: "/applications/example", label: "Application Editor" },
  { to: "/pipeline", label: "Pipeline" },
] as const;

export default function App() {
  const { user, pending } = useCurrentUser();
  const location = useLocation();

  // While Firebase resolves the first auth state, render a tiny
  // monochrome splash so the shell doesn't flash unauthenticated
  // content before redirect-to-sign-in kicks in.
  if (pending) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-400 dark:bg-zinc-950 dark:text-zinc-600">
        Loading&hellip;
      </div>
    );
  }

  // Unauthenticated: render sign-in at /sign-in, redirect every other
  // path to it. Preserving the attempted path for post-auth bounce-back
  // is a follow-on polish, not required for #57's acceptance criteria.
  if (!user) {
    if (location.pathname === "/sign-in") {
      return <SignIn />;
    }
    return <Navigate to="/sign-in" replace />;
  }

  // Authenticated: the app shell.
  return (
    <div className="flex h-full flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <Wordmark className="text-lg" />
          <nav className="flex items-center gap-4 text-sm">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? "text-zinc-900 underline underline-offset-4 dark:text-zinc-100"
                    : "text-zinc-500 transition duration-150 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }
              >
                {item.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={async () => {
                try {
                  await signOut(getAuthClient());
                } catch (err) {
                  // Rare — Firebase's sign-out is mostly a local
                  // token clear. Log for diagnosis; user can retry.
                  // A user-visible error surface here is overkill
                  // for a single-user app at V1 scale.
                  console.error("Sign-out failed:", err);
                }
              }}
              className="ml-2 text-xs text-zinc-400 transition duration-150 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-100"
              aria-label={`Sign out ${user.email ?? ""}`}
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/units" replace />} />
          <Route path="/sign-in" element={<Navigate to="/units" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/units" element={<UnitReview />} />
          <Route path="/roles/:roleId" element={<RoleDetail />} />
          <Route
            path="/applications/:applicationId"
            element={<ApplicationEditor />}
          />
          <Route path="/pipeline" element={<Pipeline />} />
          {/*
            Hidden debug route per #50 — PDF rendering
            prototype. NOT linked from the main nav.
            DEV-ONLY: gated on `import.meta.env.DEV` so it
            only registers under `npm run dev`, never in
            production builds. cursor #140 r1 caught the
            prior shape (registered in production for any
            authenticated user). The Vite production build
            tree-shakes the false branch entirely.
            Production navigation to /debug/pdf-prototype
            falls through to the catch-all redirect to
            /units.
          */}
          {DEBUG_ROUTES_ENABLED && PdfPrototype !== null && (
            <Route
              path="/debug/pdf-prototype"
              element={
                <Suspense
                  fallback={
                    <p className="text-sm text-zinc-500 p-6">
                      Loading PDF prototype…
                    </p>
                  }
                >
                  <PdfPrototype />
                </Suspense>
              }
            />
          )}
          <Route path="*" element={<Navigate to="/units" replace />} />
        </Routes>
      </main>
    </div>
  );
}
