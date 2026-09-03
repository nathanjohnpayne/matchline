/**
 * "Create new Role" form route (sub-issue #200, front-end for the
 * existing `upsertRole` service). Surfaced as a #26 prereq during
 * QA spin-up — `upsertRole` was in the service layer with no UI
 * caller; the user had no way to create a Role without writing
 * to Firestore directly.
 *
 * V1 scope: single-page form at `/roles/new`. Title + JD text
 * required; URL, location, remote policy, comp range optional.
 * Submit calls `upsertRole`; on success, redirects to
 * `/roles/:newRoleId` so the user can move to Requirements →
 * Matches → Generate.
 *
 * `company_id` is required by the `Role` type but there's no
 * Company UI yet (Phase 2). V1 stamps a fresh placeholder UUID;
 * a future "link to Company" affordance will rewrite the field
 * post-creation.
 *
 * Status state machine mirrors Onboarding (sub-issue #199) +
 * BulletEditor (#188): editing / saving / error.
 */

import { useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router-dom";

import { upsertRole } from "../services/roles.ts";
import type { RemotePolicy } from "../types/crm.ts";
import { beginUnsavedWork } from "../lib/appBusy.ts";

export type RoleNewStatus = "editing" | "saving" | "error";

const REMOTE_POLICIES: readonly RemotePolicy[] = ["onsite", "hybrid", "remote"];

interface FormState {
  readonly title: string;
  readonly jdRaw: string;
  readonly jdUrl: string;
  readonly location: string;
  readonly remotePolicy: RemotePolicy | "";
  readonly compRange: string;
}

const EMPTY_FORM: FormState = {
  title: "",
  jdRaw: "",
  jdUrl: "",
  location: "",
  remotePolicy: "",
  compRange: "",
};

export default function RoleNew(): ReactElement {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [status, setStatus] = useState<RoleNewStatus>("editing");
  const [error, setError] = useState<Error | null>(null);

  // The new-Role form lives only in React state, so a reload from the
  // update banner would discard it. Declaring it as unsaved work gates
  // that reload behind a confirmation (Codex P2, #434).
  useEffect(() => {
    const dirty = Object.values(form).some(
      (v) => typeof v === "string" && v.trim() !== "",
    );
    if (!dirty) return;
    return beginUnsavedWork("roleNew.form");
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
    if (form.title.trim().length === 0) {
      setStatus("error");
      setError(new Error("Title is required."));
      return;
    }
    if (form.jdRaw.trim().length === 0) {
      setStatus("error");
      setError(new Error("Paste the job description text first."));
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      const id = globalThis.crypto.randomUUID();
      // Build the role payload with CONDITIONAL SPREADS for the
      // optional fields. Writing `undefined` values would be
      // rejected by Firestore — this client doesn't set
      // `ignoreUndefinedProperties` (same quirk that bit PR #198
      // on `validation_flags`). Omitting the key entirely is the
      // documented way to express "absent" on a setDoc write.
      // Codex P1 on PR #205.
      const trimmedUrl = form.jdUrl.trim();
      const trimmedLocation = form.location.trim();
      const trimmedComp = form.compRange.trim();
      await upsertRole({
        id,
        // Phase 2 will introduce a real Company link UI; for now
        // stamp a placeholder per-Role UUID. Each Role gets its
        // own placeholder; the future "merge into Company X"
        // flow can rewrite this field.
        company_id: globalThis.crypto.randomUUID(),
        title: form.title.trim(),
        jd_raw: form.jdRaw,
        discovered_at: new Date().toISOString(),
        ...(trimmedUrl !== "" && { jd_url: trimmedUrl }),
        ...(trimmedLocation !== "" && { location: trimmedLocation }),
        ...(form.remotePolicy !== "" && { remote_policy: form.remotePolicy }),
        ...(trimmedComp !== "" && { comp_range: trimmedComp }),
      });
      navigate(`/roles/${id}`);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const onCancel = (): void => {
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
          Paste a JD to start tracking a Role. The next step parses the
          requirements + matches them against your approved Experience
          Units.
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
            <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <textarea
            id="role-new-jd"
            value={form.jdRaw}
            onChange={onChange("jdRaw")}
            disabled={saving}
            required
            rows={12}
            placeholder="Paste the full JD as plain text."
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
            disabled={
              saving ||
              form.title.trim().length === 0 ||
              form.jdRaw.trim().length === 0
            }
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
