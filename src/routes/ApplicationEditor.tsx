import { useParams } from "react-router-dom";

export default function ApplicationEditor() {
  const { applicationId } = useParams<{ applicationId: string }>();

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        Application Editor
      </h1>
      <p className="text-sm text-zinc-500">
        Application: {applicationId ?? "—"}
      </p>
      <p className="text-zinc-600 dark:text-zinc-400">
        Two-pane view: generated output on the left, approved Experience
        Units on the right. Inline traceability annotations mark every
        claim. Export is blocked while any validation flag is unresolved.
      </p>
      <p className="text-sm text-zinc-500">
        Sprint 0 placeholder. Traceability and validation flags land in
        Sprint 1; export in Sprint 2.
      </p>
    </section>
  );
}
