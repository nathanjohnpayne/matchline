/**
 * "Create new Role" form route (sub-issue #200, front-end for the
 * existing `upsertRole` service). Surfaced as a #26 prereq during
 * QA spin-up — `upsertRole` was in the service layer with no UI
 * caller; the user had no way to create a Role without writing
 * to Firestore directly.
 *
 * Single-page form at `/roles/new`. Only Title is required (#431):
 * the JD often arrives after the role is spotted, so a Role can be
 * saved as a lead and its JD pasted later on Role Detail. URL,
 * location, remote policy, comp range and JD are optional. Submit
 * calls `upsertRole`; on success, redirects to `/roles/:newRoleId`
 * so the user can move to Requirements → Matches → Generate.
 *
 * The in-progress form is persisted to `localStorage` as the user
 * types (`src/lib/formDraft.ts`) and restored on mount, so a reload
 * or accidental navigation does not cost the typing (#431). A
 * successful create or an explicit Cancel discards it.
 *
 * `company_id` is required by the `Role` type but there's no
 * Company UI yet (Phase 2). V1 stamps a fresh placeholder UUID;
 * a future "link to Company" affordance will rewrite the field
 * post-creation.
 *
 * Status state machine mirrors Onboarding (sub-issue #199) +
 * BulletEditor (#188): editing / saving / error.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";

import { upsertRole } from "../services/roles.ts";
import { beginAppBusy, beginUnsavedWork } from "../lib/appBusy.ts";
import {
  clearFormDraft,
  loadFormDraft,
  saveFormDraft,
} from "../lib/formDraft.ts";
import {
  REMOTE_POLICIES,
  ROLE_NEW_DRAFT_KEY,
  canSubmitRoleNew,
  isRoleNewFormDirty,
  restoreRoleNewForm,
  submitRoleNewForm,
  type RoleNewFormState as FormState,
} from "./roleNewForm.ts";

export type RoleNewStatus = "editing" | "saving" | "error";

export default function RoleNew(): ReactElement {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(() =>
    restoreRoleNewForm(loadFormDraft(ROLE_NEW_DRAFT_KEY)),
  );
  const [status, setStatus] = useState<RoleNewStatus>("editing");
  const [error, setError] = useState<Error | null>(null);

  // The new-Role form lives only in React state, so a reload from the
  // update banner would discard it. Declaring it as unsaved work gates
  // that reload behind a confirmation (#456). Distinct from the create
  // lease below: that one suppresses the prompt outright while the
  // write is in flight, this one only asks first.
  //
  // The lease stays even with the draft persisted below: storage can be
  // unavailable (private mode, quota), and then the form is back to
  // living only in React state.
  useEffect(() => {
    if (!isRoleNewFormDirty(form)) return;
    return beginUnsavedWork("roleNew.form");
  }, [form]);

  // Persist the draft on every change; an all-blank form clears it so
  // a stale draft does not come back after the user empties the fields
  // (#431).
  useEffect(() => {
    if (isRoleNewFormDirty(form)) {
      saveFormDraft(ROLE_NEW_DRAFT_KEY, form);
    } else {
      clearFormDraft(ROLE_NEW_DRAFT_KEY);
    }
  }, [form]);

  const onChange =
    (key: keyof FormState) =>
    (
      e: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ): void => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
      if (status === "error") setStatus("editing");
    };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (status === "saving") return;
    if (!canSubmitRoleNew(form)) {
      setStatus("error");
      setError(new Error("Title is required."));
      return;
    }
    setStatus("saving");
    setError(null);
    // Role creation is a Firestore write with no lease of its own, so a
    // visible update banner kept Reload enabled over it and could
    // discard the pending create (Codex P1, #434). Per-invocation lease,
    // released in the finally below.
    const releaseBusy = beginAppBusy("roleNew.create");
    try {
      const id = await submitRoleNewForm(form, {
        upsertRole,
        newId: () => globalThis.crypto.randomUUID(),
        now: () => new Date(),
      });
      clearFormDraft(ROLE_NEW_DRAFT_KEY);
      navigate(`/roles/${id}`);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      releaseBusy();
    }
  };

  const onCancel = (): void => {
    // Cancel is a deliberate discard, unlike a reload or a stray
    // navigation, so it drops the persisted draft (#431).
    clearFormDraft(ROLE_NEW_DRAFT_KEY);
    // Prefer router-back so the user lands where they came from
    // (e.g., the Pipeline view, an existing Role detail). When
    // there's no history (the user landed here via a direct URL
    // or a fresh tab), fall back to /units. CodeRabbit Minor on
    // PR #205.
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/units");
  };

  const saving = status === "saving";

  return (
    <section
      className="mx-auto max-w-2xl space-y-4"
      data-testid="role-new"
      data-role-new-status={status}
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          New Role
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Start tracking a Role with just a title. Paste the JD now or
          later: once it&apos;s in, the next step parses the requirements +
          matches them against your approved Experience Units.
        </p>
      </header>

      {status === "error" && error !== null && (
        <p
          role="alert"
          data-testid="role-new-error"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {error.message}
        </p>
      )}

      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label
            htmlFor="role-new-title"
            className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            Title <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <input
            id="role-new-title"
            type="text"
            value={form.title}
            onChange={onChange("title")}
            disabled={saving}
            required
            placeholder="Senior Software Engineer"
            data-testid="role-new-title"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
          />
        </div>

        <div>
          <label
            htmlFor="role-new-jd"
            className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
          >
            Job description{" "}
            <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
          </label>
          <textarea
            id="role-new-jd"
            value={form.jdRaw}
            onChange={onChange("jdRaw")}
            disabled={saving}
            rows={12}
            placeholder="Paste the full JD as plain text, or add it later from the Role page."
            data-testid="role-new-jd"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="role-new-url"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              JD URL <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
            </label>
            <input
              id="role-new-url"
              type="url"
              value={form.jdUrl}
              onChange={onChange("jdUrl")}
              disabled={saving}
              placeholder="https://…"
              data-testid="role-new-url"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
            />
          </div>
          <div>
            <label
              htmlFor="role-new-location"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Location <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
            </label>
            <input
              id="role-new-location"
              type="text"
              value={form.location}
              onChange={onChange("location")}
              disabled={saving}
              placeholder="San Francisco, CA"
              data-testid="role-new-location"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
            />
          </div>
          <div>
            <label
              htmlFor="role-new-remote"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Remote policy{" "}
              <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
            </label>
            <select
              id="role-new-remote"
              value={form.remotePolicy}
              onChange={onChange("remotePolicy")}
              disabled={saving}
              data-testid="role-new-remote"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
            >
              <option value="">—</option>
              {REMOTE_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="role-new-comp"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Comp range{" "}
              <span className="text-zinc-400 dark:text-zinc-600">(optional)</span>
            </label>
            <input
              id="role-new-comp"
              type="text"
              value={form.compRange}
              onChange={onChange("compRange")}
              disabled={saving}
              placeholder="$200k–$280k"
              data-testid="role-new-comp"
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-zinc-900 focus:outline-none disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-100"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {saving && (
            <span
              className="text-xs italic text-zinc-500"
              data-testid="role-new-saving"
              aria-live="polite"
            >
              Saving&hellip;
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            data-action="role-new-cancel"
            className="rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !canSubmitRoleNew(form)}
            data-action="role-new-submit"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-50 hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Create Role
          </button>
        </div>
      </form>
    </section>
  );
}
