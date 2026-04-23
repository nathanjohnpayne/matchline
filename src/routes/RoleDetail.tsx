import { useParams } from "react-router-dom";

export default function RoleDetail() {
  const { roleId } = useParams<{ roleId: string }>();

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Role Detail</h1>
      <p className="text-sm text-zinc-500">Role: {roleId ?? "—"}</p>
      <p className="text-zinc-600 dark:text-zinc-400">
        Per-role workspace. Tabs: Requirements, Matches, Applications.
        Persistent action bar for generation and stage updates.
      </p>
      <p className="text-sm text-zinc-500">
        Sprint 0 placeholder. Matches tab is the heart of the product and
        ships in Sprint 1.
      </p>
    </section>
  );
}
