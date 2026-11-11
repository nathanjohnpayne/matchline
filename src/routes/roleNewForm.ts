/**
 * Pure form logic for the Create Role route (`RoleNew.tsx`), lifted
 * out so the submit gate, the payload shape and the draft restore are
 * unit-testable without rendering (#431).
 *
 * A Role needs only a Title (#431). A role spotted on a job board or
 * in a recruiter message is a lead before its JD arrives; the JD is
 * pasted later on Role Detail's Requirements tab, and parsing,
 * matching and generation stay gated on it there.
 */

import type { RemotePolicy, Role } from "../types/crm.ts";

export const REMOTE_POLICIES: readonly RemotePolicy[] = [
  "onsite",
  "hybrid",
  "remote",
];

export interface RoleNewFormState {
  readonly title: string;
  readonly jdRaw: string;
  readonly jdUrl: string;
  readonly location: string;
  readonly remotePolicy: RemotePolicy | "";
  readonly compRange: string;
}

export const EMPTY_ROLE_NEW_FORM: RoleNewFormState = {
  title: "",
  jdRaw: "",
  jdUrl: "",
  location: "",
  remotePolicy: "",
  compRange: "",
};

/** Storage key for the persisted draft, keyed to the route. */
export const ROLE_NEW_DRAFT_KEY = "/roles/new";

/** True when any field holds non-whitespace text. */
export function isRoleNewFormDirty(form: RoleNewFormState): boolean {
  return Object.values(form).some(
    (v) => typeof v === "string" && v.trim() !== "",
  );
}

/** Title is the only required field (#431). */
export function canSubmitRoleNew(form: RoleNewFormState): boolean {
  return form.title.trim().length > 0;
}

/**
 * Rebuild a form from a stored draft. Anything that is not a plain
 * object yields the empty form; individual fields that are missing or
 * the wrong type fall back to their empty value, so a draft written by
 * an older build (or tampered with) never crashes the route or puts a
 * non-string into a controlled input.
 */
export function restoreRoleNewForm(stored: unknown): RoleNewFormState {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return EMPTY_ROLE_NEW_FORM;
  }
  const s = stored as Record<string, unknown>;
  const str = (k: keyof RoleNewFormState): string =>
    typeof s[k] === "string" ? s[k] : "";
  const remote = s.remotePolicy;
  return {
    title: str("title"),
    jdRaw: str("jdRaw"),
    jdUrl: str("jdUrl"),
    location: str("location"),
    remotePolicy: REMOTE_POLICIES.includes(remote as RemotePolicy)
      ? (remote as RemotePolicy)
      : "",
    compRange: str("compRange"),
  };
}

/**
 * Build the `upsertRole` payload. Optional fields use CONDITIONAL
 * SPREADS: writing `undefined` values would be rejected by Firestore
 * (this client does not set `ignoreUndefinedProperties`; the same
 * quirk bit PR #198 on `validation_flags`). Omitting the key is the
 * documented way to express "absent" on a setDoc write. Codex P1 on
 * PR #205.
 *
 * `jd_raw` is always written, as `""` when no JD was pasted. The rest
 * of the app already treats an empty `jd_raw` as "no JD yet" (Role
 * Detail's Requirements tab), so a required string with an empty
 * default keeps every existing reader working (#431).
 */
export function buildRoleFromForm(
  form: RoleNewFormState,
  ids: { readonly id: string; readonly companyId: string },
  now: Date,
): Omit<Role, "owner_uid"> {
  const trimmedUrl = form.jdUrl.trim();
  const trimmedLocation = form.location.trim();
  const trimmedComp = form.compRange.trim();
  return {
    id: ids.id,
    // Phase 2 will introduce a real Company link UI; for now each
    // Role gets its own placeholder company UUID. The future "merge
    // into Company X" flow can rewrite this field.
    company_id: ids.companyId,
    title: form.title.trim(),
    // A whitespace-only paste is not a JD.
    jd_raw: form.jdRaw.trim() === "" ? "" : form.jdRaw,
    discovered_at: now.toISOString(),
    ...(trimmedUrl !== "" && { jd_url: trimmedUrl }),
    ...(trimmedLocation !== "" && { location: trimmedLocation }),
    ...(form.remotePolicy !== "" && { remote_policy: form.remotePolicy }),
    ...(trimmedComp !== "" && { comp_range: trimmedComp }),
  };
}

export interface RoleNewSubmitDeps {
  /** The service write (`upsertRole` in the app). */
  readonly upsertRole: (role: Omit<Role, "owner_uid">) => Promise<void>;
  /** Fresh UUID source, called once for the Role and once for its placeholder company. */
  readonly newId: () => string;
  readonly now: () => Date;
}

/**
 * The create step behind the form's submit: validate, build the
 * payload, write it, and return the new Role's id for the redirect.
 * The component calls this with the real `upsertRole`; tests call it
 * with a fake, which is how the submit wiring is covered without a DOM
 * test environment (CodeRabbit on PR #575). Throws without writing
 * when the title is missing; a failed write rejects with the service
 * error so the form can show it and keep the draft.
 */
export async function submitRoleNewForm(
  form: RoleNewFormState,
  deps: RoleNewSubmitDeps,
): Promise<string> {
  if (!canSubmitRoleNew(form)) {
    throw new Error("Title is required.");
  }
  const id = deps.newId();
  await deps.upsertRole(
    buildRoleFromForm(form, { id, companyId: deps.newId() }, deps.now()),
  );
  return id;
}

