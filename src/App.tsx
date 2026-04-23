import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import ApplicationEditor from "./routes/ApplicationEditor.tsx";
import Onboarding from "./routes/Onboarding.tsx";
import Pipeline from "./routes/Pipeline.tsx";
import RoleDetail from "./routes/RoleDetail.tsx";
import UnitReview from "./routes/UnitReview.tsx";

const navItems = [
  { to: "/onboarding", label: "Onboarding" },
  { to: "/units", label: "Unit Review" },
  { to: "/roles/example", label: "Role Detail" },
  { to: "/applications/example", label: "Application Editor" },
  { to: "/pipeline", label: "Pipeline" },
] as const;

export default function App() {
  return (
    <div className="flex h-full flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold tracking-tight">Matchline</div>
          <nav className="flex gap-4 text-sm">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? "text-zinc-900 underline underline-offset-4 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Navigate to="/onboarding" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/units" element={<UnitReview />} />
          <Route path="/roles/:roleId" element={<RoleDetail />} />
          <Route
            path="/applications/:applicationId"
            element={<ApplicationEditor />}
          />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="*" element={<Navigate to="/onboarding" replace />} />
        </Routes>
      </main>
    </div>
  );
}
