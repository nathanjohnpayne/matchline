import { FirebaseError } from "firebase/app";
import {
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  type QueryConstraint,
} from "firebase/firestore";

import type {
  Application,
  ApplicationStage,
  AssetRef,
  GeneratedAssetContent,
  GeneratedItem,
} from "../types/crm.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PATH = "applications";

const col = () => typedCollection<Application>(PATH);
const ref = (id: string) => typedDoc<Application>(PATH, id);

export async function listApplications(
  ...constraints: QueryConstraint[]
): Promise<Application[]> {
  const snap = await getDocs(query(col(), ...ownerScope(), ...constraints));
  return snap.docs.map((d) => d.data());
}

export async function listApplicationsByStage(
  stage: ApplicationStage,
): Promise<Application[]> {
  return listApplications(where("stage", "==", stage));
}

/**
 * Fetch an Application doc by id. Returns `undefined` for BOTH
 * "doc doesn't exist" AND "doc exists but caller doesn't own it"
 * — anti-enumeration mirror of `getRole` (and the server-side
 * pattern at #109 / #120).
 *
 * The Firestore rules layer rejects cross-owner reads with
 * `permission-denied`. Without this catch, a foreign Application
 * id would surface as a thrown error that the ApplicationEditor
 * container would route to its "error" state — leaking that the
 * doc EXISTS (a missing doc would just return
 * `snap.exists() === false`, a different code path). Collapsing
 * both shapes to `undefined` means the caller can't distinguish
 * the two, matching the not-found surface the editor renders.
 *
 * Codex P2 on PR #181 caught the inconsistency with `getRole`.
 *
 * Other error codes (transport, unauthenticated, etc.) propagate
 * normally so the container's error state still fires for genuine
 * failures.
 */
export async function getApplication(
  id: string,
): Promise<Application | undefined> {
  try {
    const snap = await getDoc(ref(id));
    return snap.exists() ? snap.data() : undefined;
  } catch (err) {
    if (err instanceof FirebaseError && err.code === "permission-denied") {
      return undefined;
    }
    throw err;
  }
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertApplication(
  app: Omit<Application, "owner_uid">,
): Promise<void> {
  await setDoc(
    ref(app.id),
    { ...app, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}

/**
 * Outcome of a `removeBulletFromAsset` call. The route uses this to
 * pick the right post-mutation surface — successful removal → re-
 * fetch the Application; not-found / wrong-asset → render an inline
 * error.
 */
export type RemoveBulletResult =
  | { readonly status: "removed" }
  | { readonly status: "application-not-found" }
  | { readonly status: "asset-not-found" }
  | { readonly status: "bullet-not-found" };

/**
 * Strip a bullet from an Application's generated asset and flip the
 * asset's `validation_status` to `"stale"`.
 *
 * Wired from the Application Editor's flag-resolution popover (#24,
 * PR 2): "Remove the bullet" is one of the three resolution paths
 * for an unresolved validation flag. The user is removing fabricated
 * or unsupportable claims rather than fixing them.
 *
 * Why client-side instead of a callable: the mutation is a single-
 * doc, owner-scoped, transactional read-modify-write that
 * Firestore's rules already gate. A callable would add latency
 * without any new validation we can't do here. Concurrent edits
 * would race, but matchline is single-user at V1; if multi-user
 * lands later, lift this into a transaction.
 *
 * The `validation_status: "stale"` flip is load-bearing: per the
 * type comments in `src/types/crm.ts:147–151`, "the editor flips
 * to stale on any post-validation edit." A bullet removal IS a
 * post-validation edit. The export gate (#24, PR 2) refuses to
 * export stale assets — the user must re-validate after removing
 * a bullet, which the orchestrator (`functions/src/validation/
 * validate.ts`) does atomically.
 *
 * `bullet_id` matches against summary, bullets, skills, and
 * education — every flag-bearing item carries a stable id, and
 * a flag's `bullet_id` (vestigially named) refers to whichever
 * GeneratedItem holds the offending claim. Removal from `summary`
 * is intentionally NOT supported (callers should disable the
 * Remove button for summary-level flags) — the Application can't
 * have an empty summary, so removal would corrupt the asset
 * shape. This function rejects with `bullet-not-found` if asked
 * to remove from `summary`.
 */
export async function removeBulletFromAsset(
  applicationId: string,
  assetId: string,
  bulletId: string,
): Promise<RemoveBulletResult> {
  const app = await getApplication(applicationId);
  if (app === undefined) return { status: "application-not-found" };

  const assets = app.generated_assets ?? [];
  const assetIndex = assets.findIndex((a) => a.id === assetId);
  if (assetIndex === -1) return { status: "asset-not-found" };
  const target = assets[assetIndex];
  const content = target.generated_content;
  if (content === undefined) return { status: "asset-not-found" };

  // Refuse to nuke the summary — the Application Editor's view
  // disables Remove for summary-level flags, but defending here
  // closes the gap if a future caller misses that.
  if (content.summary.id === bulletId) return { status: "bullet-not-found" };

  const removed = removeBulletFromContent(content, bulletId);
  if (!removed.found) return { status: "bullet-not-found" };

  const nextAsset: AssetRef = {
    ...target,
    generated_content: removed.content,
    validation_status: "stale",
  };
  const nextAssets = [...assets];
  nextAssets[assetIndex] = nextAsset;

  await updateDoc(ref(applicationId), {
    generated_assets: nextAssets,
  });
  return { status: "removed" };
}

/**
 * Outcome of an `editBulletInAsset` call. Mirrors the
 * `RemoveBulletResult` shape so the editor's UI surface can apply
 * one decision pattern across both mutation paths.
 *
 * `no-change` is a separate status from `edited` so the UI can
 * skip the validation re-run + refetch when the user opened an
 * editor and saved without modifying the text — the post-edit
 * orchestrator round-trip would be a no-op write + a wasted
 * validation invocation otherwise.
 */
export type EditBulletResult =
  | { readonly status: "edited" }
  | { readonly status: "no-change" }
  | { readonly status: "application-not-found" }
  | { readonly status: "asset-not-found" }
  | { readonly status: "bullet-not-found" }
  | { readonly status: "empty-text" };

/**
 * Replace a bullet's text in an Application's generated asset.
 * Wired from the Application Editor's inline-edit row (#24, PR 3).
 *
 * Side effects on success (`status === "edited"`):
 *   1. The bullet's `text` is replaced with `newText`.
 *   2. The bullet's `source_unit_ids` is cleared. The prior
 *      groundings were established by the generator against the
 *      OLD text; new text may make claims those Units don't
 *      support. Clearing forces explicit re-grounding via the
 *      flag popover's "Add a supporting Unit" path or accepts
 *      the resulting "untraceable" flags. Honest-by-default —
 *      the alternative (preserve groundings) silently keeps
 *      stale evidence on rewritten claims.
 *   3. The asset's `validation_status` flips to `"stale"` (per
 *      the type contract: any post-validation edit). The
 *      Application Editor's export gate refuses to export stale
 *      assets; the user must re-run validation (the route does
 *      this automatically post-edit).
 *
 * `summary`, `bullets`, `skills`, and `education` items are all
 * editable via this path — every GeneratedItem carries a stable
 * id, and the validation orchestrator iterates all four uniformly.
 * Summary is allowed here (unlike `removeBulletFromAsset`'s
 * summary refusal): editing the summary's text is a normal
 * operation; removing it would corrupt the shape.
 *
 * Empty / whitespace-only text is rejected with `empty-text`.
 * Bullets with no content can't be validated meaningfully and
 * would just generate noise. The user should use Remove
 * instead.
 */
export async function editBulletInAsset(
  applicationId: string,
  assetId: string,
  bulletId: string,
  newText: string,
): Promise<EditBulletResult> {
  if (newText.trim().length === 0) return { status: "empty-text" };

  const app = await getApplication(applicationId);
  if (app === undefined) return { status: "application-not-found" };

  const assets = app.generated_assets ?? [];
  const assetIndex = assets.findIndex((a) => a.id === assetId);
  if (assetIndex === -1) return { status: "asset-not-found" };
  const target = assets[assetIndex];
  const content = target.generated_content;
  if (content === undefined) return { status: "asset-not-found" };

  const result = editBulletInContent(content, bulletId, newText);
  if (!result.found) return { status: "bullet-not-found" };
  if (!result.changed) return { status: "no-change" };

  const nextAsset: AssetRef = {
    ...target,
    generated_content: result.content,
    validation_status: "stale",
  };
  const nextAssets = [...assets];
  nextAssets[assetIndex] = nextAsset;

  await updateDoc(ref(applicationId), {
    generated_assets: nextAssets,
  });
  return { status: "edited" };
}

/**
 * Pure helper: walk the four GeneratedItem locations in
 * `GeneratedAssetContent` (summary + bullets + skills + education)
 * and replace the matching entry's `text` with `newText`, clearing
 * its `source_unit_ids`. Returns the new content + a `found` flag
 * (id matched something) and a `changed` flag (text actually
 * differed). Callers short-circuit no-op writes via `changed`.
 *
 * Exported so the unit tests can pin the walk order + edit shape
 * without mocking Firestore. Used by `editBulletInAsset`.
 */
export function editBulletInContent(
  content: GeneratedAssetContent,
  bulletId: string,
  newText: string,
): {
  readonly content: GeneratedAssetContent;
  readonly found: boolean;
  readonly changed: boolean;
} {
  // Summary is a single item, not an array — handle separately.
  if (content.summary.id === bulletId) {
    if (content.summary.text === newText) {
      return { content, found: true, changed: false };
    }
    return {
      content: {
        ...content,
        summary: { ...content.summary, text: newText, source_unit_ids: [] },
      },
      found: true,
      changed: true,
    };
  }
  // Bullets / skills / education share the same array shape.
  const editList = (
    list: readonly GeneratedItem[] | undefined,
  ): {
    readonly list: GeneratedItem[];
    readonly found: boolean;
    readonly changed: boolean;
  } => {
    if (list === undefined) {
      return { list: [], found: false, changed: false };
    }
    let found = false;
    let changed = false;
    const out = list.map((item) => {
      if (item.id !== bulletId) return item;
      found = true;
      if (item.text === newText) return item;
      changed = true;
      return { ...item, text: newText, source_unit_ids: [] };
    });
    return { list: out, found, changed };
  };
  const bullets = editList(content.bullets);
  if (bullets.found) {
    if (!bullets.changed) return { content, found: true, changed: false };
    return {
      content: { ...content, bullets: bullets.list },
      found: true,
      changed: true,
    };
  }
  const skills = editList(content.skills);
  if (skills.found) {
    if (!skills.changed) return { content, found: true, changed: false };
    return {
      content: { ...content, skills: skills.list },
      found: true,
      changed: true,
    };
  }
  const education = editList(content.education);
  if (education.found) {
    if (!education.changed) return { content, found: true, changed: false };
    return {
      content: { ...content, education: education.list },
      found: true,
      changed: true,
    };
  }
  return { content, found: false, changed: false };
}

/**
 * Pure helper: walk the four GeneratedItem arrays in
 * `GeneratedAssetContent` and remove any entry whose `id` matches
 * `bulletId`. Returns the new content + a `found` flag so callers
 * can report `bullet-not-found` rather than write a no-op patch.
 *
 * Exported so the unit tests can pin the array-walk order without
 * mocking Firestore.
 */
export function removeBulletFromContent(
  content: GeneratedAssetContent,
  bulletId: string,
): { readonly content: GeneratedAssetContent; readonly found: boolean } {
  const removeFrom = (
    list: readonly GeneratedItem[] | undefined,
  ): { readonly list: GeneratedItem[]; readonly removed: boolean } => {
    if (list === undefined) return { list: [], removed: false };
    const out = list.filter((b) => b.id !== bulletId);
    return { list: out, removed: out.length !== list.length };
  };
  const bullets = removeFrom(content.bullets);
  const skills = removeFrom(content.skills);
  const education = removeFrom(content.education);
  const found = bullets.removed || skills.removed || education.removed;
  if (!found) return { content, found: false };
  return {
    content: {
      ...content,
      bullets: bullets.list,
      skills: skills.list,
      ...(content.education === undefined
        ? {}
        : { education: education.list }),
    },
    found: true,
  };
}
