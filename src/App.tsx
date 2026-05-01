import { signOut } from "firebase/auth";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";

import Wordmark from "./components/Wordmark.tsx";
import { getAuthClient } from "./firebase.ts";
import { useCurrentUser } from "./lib/auth.tsx";
import ApplicationEditor from "./routes/ApplicationEditor/index.tsx";
import Onboarding from "./routes/Onboarding.tsx";
import Pipeline from "./routes/Pipeline.tsx";
import RoleDetail from "./routes/RoleDetail/index.tsx";
import RoleNew from "./routes/RoleNew.tsx";
import SignIn from "./routes/SignIn.tsx";
import UnitReview from "./routes/UnitReview/index.tsx";

const navItems = [
  { to: "/onboarding", label: "Onboarding" },
  { to: "/units", label: "Unit Review" },
  { to: "/roles/new", label: "+ New Role" },
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
          <Route path="/roles/new" element={<RoleNew />} />
          <Route path="/roles/:roleId" element={<RoleDetail />} />
          <Route
            path="/applications/:applicationId"
            element={<ApplicationEditor />}
          />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="*" element={<Navigate to="/units" replace />} />
        </Routes>
      </main>
    </div>
  );
}
