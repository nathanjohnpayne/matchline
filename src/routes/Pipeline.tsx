import type { ApplicationStage } from "../types/crm.ts";

const stages: readonly ApplicationStage[] = [
  "saved",
  "drafting",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

export default function Pipeline() {
  return (
    <section className="mx-auto max-w-7xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Pipeline</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Kanban by application stage. Replaces the spreadsheet.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        {stages.map((stage) => (
          <div
            key={stage}
            className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {stage}
            </div>
            <div className="mt-2 text-sm text-zinc-400">0</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-zinc-500">
        Sprint 0 placeholder. Card contents, task sidebar, and follow-up
        reminders land in Sprint 2.
      </p>
    </section>
  );
}
