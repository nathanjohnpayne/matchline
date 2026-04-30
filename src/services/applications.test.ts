/**
 * Service-layer test for `getApplication`'s anti-enumeration
 * behavior (Codex P2 on PR #181 — mirror `getRole` from cursor
 * #132 r1).
 *
 * Mocks `firebase/firestore`'s `getDoc` directly. Same shape as
 * `roles.test.ts`; this file only pins the try/catch logic that
 * the ApplicationEditor container relies on for routing missing
 * or foreign applicationIds to the not-found surface instead of
 * the error surface.
 */

import { FirebaseError } from "firebase/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.ts", () => ({
  getOwnerUidOrThrow: () => "user-alice",
  ownerScope: () => [],
}));

const getDoc = vi.fn();

const updateDoc = vi.fn();

vi.mock("firebase/firestore", () => ({
  getDoc: (...args: unknown[]) => getDoc(...args),
  getDocs: () => {
    throw new Error("getDocs not mocked in applications.test.ts");
  },
  onSnapshot: () => {
    throw new Error("onSnapshot not mocked in applications.test.ts");
  },
  query: () => undefined,
  setDoc: () => {
    throw new Error("setDoc not mocked in applications.test.ts");
  },
  updateDoc: (...args: unknown[]) => updateDoc(...args),
  where: () => undefined,
}));

vi.mock("./firestore.ts", () => ({
  typedCollection: () => undefined,
  typedDoc: () => ({}),
}));

beforeEach(() => {
  getDoc.mockReset();
  updateDoc.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const {
  getApplication,
  removeBulletFromAsset,
  removeBulletFromContent,
  editBulletInAsset,
  editBulletInContent,
  addBulletToAsset,
  reorderBulletsInAsset,
  reorderArray,
  sectionList,
  withSectionList,
} = await import("./applications.ts");

import type {
  Application,
  AssetRef,
  GeneratedAssetContent,
} from "./../types/crm.ts";

describe("getApplication — anti-enumeration (Codex P2 on PR #181)", () => {
  it("returns the Application when the doc exists and caller owns it", async () => {
    const fakeApp = {
      id: "app-1",
      owner_uid: "user-alice",
      role_id: "role-1",
      stage: "drafting",
      last_activity_at: "2026-04-01T00:00:00.000Z",
      generated_assets: [],
      approved_unit_ids: [],
    };
    getDoc.mockResolvedValueOnce({ exists: () => true, data: () => fakeApp });
    await expect(getApplication("app-1")).resolves.toEqual(fakeApp);
  });

  it("returns undefined when the doc does not exist (snap.exists() === false)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    await expect(getApplication("missing")).resolves.toBeUndefined();
  });

  it("returns undefined when Firestore rules deny the read (permission-denied) — collapses missing-OR-foreign into one shape", async () => {
    // Load-bearing test: without the try/catch, this would throw
    // and the editor container would route to its "error" surface,
    // leaking that the doc EXISTS (vs. returning undefined which
    // is the same shape as a missing doc). Collapsing to undefined
    // here matches the server-side anti-enumeration pattern that
    // `getRole` set the precedent for.
    getDoc.mockRejectedValueOnce(
      new FirebaseError(
        "permission-denied",
        "Missing or insufficient permissions.",
      ),
    );
    await expect(getApplication("foreign-app")).resolves.toBeUndefined();
  });

  it("propagates non-permission-denied errors (transport, unauthenticated, etc.)", async () => {
    const transport = new FirebaseError(
      "unavailable",
      "transient transport error",
    );
    getDoc.mockRejectedValueOnce(transport);
    await expect(getApplication("any")).rejects.toBe(transport);
  });

  it("propagates non-FirebaseError errors verbatim", async () => {
    const generic = new Error("something else");
    getDoc.mockRejectedValueOnce(generic);
    await expect(getApplication("any")).rejects.toBe(generic);
  });
});

function content(
  partial: Partial<GeneratedAssetContent> = {},
): GeneratedAssetContent {
  return {
    summary: { id: "summary", text: "summary", source_unit_ids: [] },
    bullets: [
      { id: "b1", text: "bullet one", source_unit_ids: [] },
      { id: "b2", text: "bullet two", source_unit_ids: [] },
    ],
    skills: [{ id: "sk1", text: "skill one", source_unit_ids: [] }],
    ...partial,
  };
}

function asset(partial: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "asset-1",
    owner_uid: "u",
    application_id: "app-1",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content(),
    validation_status: "passed",
    created_at: "2026-04-01T00:00:00.000Z",
    ...partial,
  };
}

function application(partial: Partial<Application> = {}): Application {
  return {
    id: "app-1",
    owner_uid: "u",
    role_id: "role-1",
    stage: "drafting",
    last_activity_at: "2026-04-01T00:00:00.000Z",
    generated_assets: [asset()],
    approved_unit_ids: [],
    ...partial,
  };
}

describe("removeBulletFromContent (pure helper)", () => {
  it("removes from bullets[] and reports found=true", () => {
    const r = removeBulletFromContent(content(), "b1");
    expect(r.found).toBe(true);
    expect(r.content.bullets.map((b) => b.id)).toEqual(["b2"]);
    // Skills + summary untouched.
    expect(r.content.skills.length).toBe(1);
    expect(r.content.summary.id).toBe("summary");
  });

  it("removes from skills[] when the id matches a skill", () => {
    const r = removeBulletFromContent(content(), "sk1");
    expect(r.found).toBe(true);
    expect(r.content.skills.length).toBe(0);
    expect(r.content.bullets.length).toBe(2);
  });

  it("removes from education[] when present and the id matches", () => {
    const c = content({
      education: [
        { id: "e1", text: "BS", source_unit_ids: [] },
        { id: "e2", text: "MS", source_unit_ids: [] },
      ],
    });
    const r = removeBulletFromContent(c, "e1");
    expect(r.found).toBe(true);
    expect(r.content.education?.map((e) => e.id)).toEqual(["e2"]);
  });

  it("preserves the original content reference and found=false when no id matches", () => {
    const c = content();
    const r = removeBulletFromContent(c, "ghost");
    expect(r.found).toBe(false);
    // Same reference: callers can short-circuit a no-op write.
    expect(r.content).toBe(c);
  });

  it("does not introduce an `education` key when input has no education and id doesn't match there", () => {
    // Defensive: the spread should not add `education: []` to an
    // asset that was created without education metadata.
    const c = content();
    expect(c.education).toBeUndefined();
    const r = removeBulletFromContent(c, "b1");
    expect(r.found).toBe(true);
    expect(r.content.education).toBeUndefined();
  });
});

describe("removeBulletFromAsset (Firestore-mocked)", () => {
  it("returns 'application-not-found' when the application doesn't exist", async () => {
    getDoc.mockResolvedValueOnce({ exists: () => false, data: () => undefined });
    const r = await removeBulletFromAsset("missing", "asset-1", "b1");
    expect(r.status).toBe("application-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' on permission-denied (anti-enumeration)", async () => {
    // getApplication's catch collapses permission-denied to
    // undefined; removeBulletFromAsset should treat that as
    // application-not-found, not throw — same UX as a missing doc.
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "denied"),
    );
    const r = await removeBulletFromAsset("foreign", "asset-1", "b1");
    expect(r.status).toBe("application-not-found");
  });

  it("returns 'asset-not-found' when the asset id is unknown", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "wrong-asset", "b1");
    expect(r.status).toBe("asset-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'asset-not-found' when the asset has no generated_content", async () => {
    const a = asset({ generated_content: undefined });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "b1");
    expect(r.status).toBe("asset-not-found");
  });

  it("refuses to remove the summary id (would corrupt the asset shape)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "summary");
    expect(r.status).toBe("bullet-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'bullet-not-found' when no item matches", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await removeBulletFromAsset("app-1", "asset-1", "ghost");
    expect(r.status).toBe("bullet-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("removes the matching bullet, flips status to stale, and writes the patched generated_assets", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await removeBulletFromAsset("app-1", "asset-1", "b1");
    expect(r.status).toBe("removed");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    expect(writePayload.generated_assets).toHaveLength(1);
    const writtenAsset = writePayload.generated_assets[0];
    expect(writtenAsset.validation_status).toBe("stale");
    expect(writtenAsset.generated_content?.bullets.map((b) => b.id)).toEqual([
      "b2",
    ]);
  });

  it("preserves other assets in the array when removing from a specific asset", async () => {
    const otherAsset = asset({
      id: "asset-2",
      kind: "cover_letter",
      validation_status: "passed",
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () =>
        application({ generated_assets: [asset(), otherAsset] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await removeBulletFromAsset("app-1", "asset-1", "b1");
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    expect(writePayload.generated_assets).toHaveLength(2);
    // The unrelated asset's status must NOT flip to stale.
    const untouched = writePayload.generated_assets.find(
      (a) => a.id === "asset-2",
    );
    expect(untouched?.validation_status).toBe("passed");
  });
});

describe("editBulletInContent (pure helper, sub-issue #188)", () => {
  it("edits a matching bullet's text and clears its source_unit_ids", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "summary", text: "summary", source_unit_ids: [] },
      bullets: [
        {
          id: "b1",
          text: "Old bullet text.",
          source_unit_ids: ["unit-a", "unit-b"],
        },
        { id: "b2", text: "Other bullet.", source_unit_ids: ["unit-c"] },
      ],
      skills: [],
    };
    const r = editBulletInContent(c, "b1", "New bullet text.");
    expect(r.found).toBe(true);
    expect(r.changed).toBe(true);
    const edited = r.content.bullets.find((b) => b.id === "b1");
    expect(edited?.text).toBe("New bullet text.");
    // Cleared source_unit_ids — prior groundings may not apply
    // to the new text; explicit re-grounding via the popover.
    expect(edited?.source_unit_ids).toEqual([]);
    // Untouched bullet keeps its source_unit_ids.
    const other = r.content.bullets.find((b) => b.id === "b2");
    expect(other?.source_unit_ids).toEqual(["unit-c"]);
  });

  it("edits the summary in place (summary lives at content.summary, not in an array)", () => {
    const c: GeneratedAssetContent = {
      summary: {
        id: "summary",
        text: "Old summary.",
        source_unit_ids: ["unit-a"],
      },
      bullets: [],
      skills: [],
    };
    const r = editBulletInContent(c, "summary", "New summary.");
    expect(r.found).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.content.summary.text).toBe("New summary.");
    expect(r.content.summary.source_unit_ids).toEqual([]);
    // ID stable on edit — flags keyed on this id remain valid.
    expect(r.content.summary.id).toBe("summary");
  });

  it("edits a skill or education entry by id", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "summary", text: "summary", source_unit_ids: [] },
      bullets: [],
      skills: [
        { id: "sk1", text: "Old skill.", source_unit_ids: ["u-x"] },
      ],
      education: [
        { id: "e1", text: "Old edu.", source_unit_ids: ["u-y"] },
      ],
    };
    const skillEdit = editBulletInContent(c, "sk1", "New skill.");
    expect(skillEdit.found).toBe(true);
    expect(skillEdit.changed).toBe(true);
    expect(skillEdit.content.skills[0]?.text).toBe("New skill.");
    expect(skillEdit.content.skills[0]?.source_unit_ids).toEqual([]);

    const eduEdit = editBulletInContent(c, "e1", "New edu.");
    expect(eduEdit.found).toBe(true);
    expect(eduEdit.changed).toBe(true);
    expect(eduEdit.content.education?.[0]?.text).toBe("New edu.");
    expect(eduEdit.content.education?.[0]?.source_unit_ids).toEqual([]);
  });

  it("returns found=true changed=false when newText matches existing (callers skip the write)", () => {
    const c: GeneratedAssetContent = {
      summary: {
        id: "summary",
        text: "Same.",
        source_unit_ids: ["unit-a"],
      },
      bullets: [
        { id: "b1", text: "Same bullet.", source_unit_ids: ["unit-b"] },
      ],
      skills: [],
    };
    const sumNoOp = editBulletInContent(c, "summary", "Same.");
    expect(sumNoOp.found).toBe(true);
    expect(sumNoOp.changed).toBe(false);
    expect(sumNoOp.content).toBe(c);
    // No-op preserves source_unit_ids since nothing was written.
    expect(sumNoOp.content.summary.source_unit_ids).toEqual(["unit-a"]);

    const bulNoOp = editBulletInContent(c, "b1", "Same bullet.");
    expect(bulNoOp.found).toBe(true);
    expect(bulNoOp.changed).toBe(false);
    expect(bulNoOp.content).toBe(c);
  });

  it("returns found=false when no item matches the id", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "summary", text: "summary", source_unit_ids: [] },
      bullets: [],
      skills: [],
    };
    const r = editBulletInContent(c, "ghost", "doesn't matter");
    expect(r.found).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(c);
  });

  it("preserves the bullet's id on edit (so existing flags don't orphan)", () => {
    // ValidationFlag.bullet_id references GeneratedItem.id; if
    // edit rotated the id, every flag on that bullet would orphan
    // and the popover would render flags under the wrong row.
    const c: GeneratedAssetContent = {
      summary: { id: "summary", text: "summary", source_unit_ids: [] },
      bullets: [
        { id: "stable-id", text: "before", source_unit_ids: [] },
      ],
      skills: [],
    };
    const r = editBulletInContent(c, "stable-id", "after");
    expect(r.content.bullets[0]?.id).toBe("stable-id");
  });
});

describe("editBulletInAsset (Firestore-mocked, sub-issue #188)", () => {
  it("rejects empty / whitespace-only text with 'empty-text'", async () => {
    expect(
      (await editBulletInAsset("app-1", "asset-1", "b1", "")).status,
    ).toBe("empty-text");
    expect(
      (await editBulletInAsset("app-1", "asset-1", "b1", "   \n  ")).status,
    ).toBe("empty-text");
    expect(getDoc).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' when the application doesn't exist", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    const r = await editBulletInAsset(
      "missing",
      "asset-1",
      "b1",
      "new text",
    );
    expect(r.status).toBe("application-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' on permission-denied (anti-enumeration parity)", async () => {
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "denied"),
    );
    const r = await editBulletInAsset(
      "foreign",
      "asset-1",
      "b1",
      "new text",
    );
    expect(r.status).toBe("application-not-found");
  });

  it("returns 'asset-not-found' when the asset id is unknown", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await editBulletInAsset(
      "app-1",
      "wrong-asset",
      "b1",
      "new text",
    );
    expect(r.status).toBe("asset-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'asset-not-found' when the asset has no generated_content", async () => {
    const a = asset({ generated_content: undefined });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    const r = await editBulletInAsset(
      "app-1",
      "asset-1",
      "b1",
      "new text",
    );
    expect(r.status).toBe("asset-not-found");
  });

  it("returns 'bullet-not-found' when no item matches", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await editBulletInAsset(
      "app-1",
      "asset-1",
      "ghost",
      "new text",
    );
    expect(r.status).toBe("bullet-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'no-change' when the text matches existing — no Firestore write", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await editBulletInAsset(
      "app-1",
      "asset-1",
      "b1",
      "bullet one", // matches the fixture's existing text
    );
    expect(r.status).toBe("no-change");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("edits the bullet, clears source_unit_ids, flips status to stale, and writes the patched generated_assets", async () => {
    const a = asset({
      validation_status: "passed",
      generated_content: {
        summary: { id: "summary", text: "summary", source_unit_ids: [] },
        bullets: [
          {
            id: "b1",
            text: "Old text.",
            source_unit_ids: ["unit-a", "unit-b"],
          },
        ],
        skills: [],
      },
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await editBulletInAsset(
      "app-1",
      "asset-1",
      "b1",
      "New text.",
    );
    expect(r.status).toBe("edited");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const writtenAsset = writePayload.generated_assets[0];
    expect(writtenAsset.validation_status).toBe("stale");
    const editedBullet = writtenAsset.generated_content?.bullets[0];
    expect(editedBullet?.text).toBe("New text.");
    expect(editedBullet?.source_unit_ids).toEqual([]);
    expect(editedBullet?.id).toBe("b1");
  });

  it("does not flip an unrelated asset's status to stale when editing a specific asset", async () => {
    const otherAsset = asset({
      id: "asset-2",
      kind: "cover_letter",
      validation_status: "passed",
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () =>
        application({ generated_assets: [asset(), otherAsset] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await editBulletInAsset("app-1", "asset-1", "b1", "Edited.");
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const untouched = writePayload.generated_assets.find(
      (a) => a.id === "asset-2",
    );
    expect(untouched?.validation_status).toBe("passed");
  });

  it("can edit the summary (unlike removal which refuses summary)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await editBulletInAsset(
      "app-1",
      "asset-1",
      "summary",
      "New summary text.",
    );
    expect(r.status).toBe("edited");
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    expect(
      writePayload.generated_assets[0].generated_content?.summary.text,
    ).toBe("New summary text.");
  });
});

describe("addBulletToAsset (Firestore-mocked, sub-issue #193)", () => {
  it("returns 'application-not-found' when the application doesn't exist", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    const r = await addBulletToAsset("missing", "asset-1", "bullets");
    expect(r.status).toBe("application-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' on permission-denied (anti-enumeration parity)", async () => {
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "denied"),
    );
    const r = await addBulletToAsset("foreign", "asset-1", "bullets");
    expect(r.status).toBe("application-not-found");
  });

  it("returns 'asset-not-found' when the asset id is unknown", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await addBulletToAsset("app-1", "wrong-asset", "bullets");
    expect(r.status).toBe("asset-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'asset-not-found' when the asset has no generated_content", async () => {
    const a = asset({ generated_content: undefined });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    const r = await addBulletToAsset("app-1", "asset-1", "bullets");
    expect(r.status).toBe("asset-not-found");
  });

  it("appends to bullets[] with a fresh id, empty text + source_unit_ids, flips status to stale", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await addBulletToAsset("app-1", "asset-1", "bullets", {
      generateId: () => "fresh-id",
    });
    expect(r.status).toBe("added");
    expect(r.status === "added" ? r.bulletId : null).toBe("fresh-id");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const writtenAsset = writePayload.generated_assets[0];
    expect(writtenAsset.validation_status).toBe("stale");
    const bullets = writtenAsset.generated_content?.bullets ?? [];
    expect(bullets).toHaveLength(3);
    const newBullet = bullets[2];
    expect(newBullet.id).toBe("fresh-id");
    expect(newBullet.text).toBe("");
    expect(newBullet.source_unit_ids).toEqual([]);
  });

  it("appends to skills[] when section='skills'", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await addBulletToAsset("app-1", "asset-1", "skills", {
      generateId: () => "new-skill",
    });
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const skills =
      writePayload.generated_assets[0].generated_content?.skills ?? [];
    expect(skills).toHaveLength(2);
    expect(skills[1].id).toBe("new-skill");
  });

  it("initializes education[] when undefined and section='education'", async () => {
    // Pre-pipeline assets may omit education entirely. Adding to
    // an education-less asset creates the section as [newBullet].
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await addBulletToAsset("app-1", "asset-1", "education", {
      generateId: () => "new-edu",
    });
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const education =
      writePayload.generated_assets[0].generated_content?.education ?? [];
    expect(education).toHaveLength(1);
    expect(education[0].id).toBe("new-edu");
  });

  it("appends to existing education[] when present", async () => {
    const a = asset({
      generated_content: {
        summary: { id: "s", text: "summary", source_unit_ids: [] },
        bullets: [],
        skills: [],
        education: [{ id: "e1", text: "BS", source_unit_ids: [] }],
      },
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await addBulletToAsset("app-1", "asset-1", "education", {
      generateId: () => "e2",
    });
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const education =
      writePayload.generated_assets[0].generated_content?.education ?? [];
    expect(education).toHaveLength(2);
    expect(education[1].id).toBe("e2");
  });

  it("does not flip an unrelated asset's status to stale when adding to a specific asset", async () => {
    const otherAsset = asset({
      id: "asset-2",
      kind: "cover_letter",
      validation_status: "passed",
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () =>
        application({ generated_assets: [asset(), otherAsset] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await addBulletToAsset("app-1", "asset-1", "bullets", {
      generateId: () => "x",
    });
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const untouched = writePayload.generated_assets.find(
      (a) => a.id === "asset-2",
    );
    expect(untouched?.validation_status).toBe("passed");
  });
});

describe("reorderArray (pure helper)", () => {
  it("moves an element forward (lower index → higher)", () => {
    expect(reorderArray(["a", "b", "c", "d"], 0, 2)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves an element backward (higher index → lower)", () => {
    expect(reorderArray(["a", "b", "c", "d"], 3, 1)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("returns a new array reference (immutable)", () => {
    const input = ["a", "b"];
    const out = reorderArray(input, 0, 1);
    expect(out).not.toBe(input);
    expect(input).toEqual(["a", "b"]);
  });
});

describe("sectionList + withSectionList (pure helpers)", () => {
  it("sectionList returns bullets / skills / education", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "s", text: "summary", source_unit_ids: [] },
      bullets: [{ id: "b", text: "b", source_unit_ids: [] }],
      skills: [{ id: "sk", text: "sk", source_unit_ids: [] }],
      education: [{ id: "e", text: "e", source_unit_ids: [] }],
    };
    expect(sectionList(c, "bullets").map((x) => x.id)).toEqual(["b"]);
    expect(sectionList(c, "skills").map((x) => x.id)).toEqual(["sk"]);
    expect(sectionList(c, "education").map((x) => x.id)).toEqual(["e"]);
  });

  it("sectionList returns [] for education when undefined", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "s", text: "summary", source_unit_ids: [] },
      bullets: [],
      skills: [],
    };
    expect(sectionList(c, "education")).toEqual([]);
  });

  it("withSectionList replaces only the targeted section, leaves others untouched", () => {
    const c: GeneratedAssetContent = {
      summary: { id: "s", text: "summary", source_unit_ids: [] },
      bullets: [{ id: "b1", text: "b1", source_unit_ids: [] }],
      skills: [{ id: "sk1", text: "sk1", source_unit_ids: [] }],
    };
    const next = withSectionList(c, "bullets", [
      { id: "b2", text: "b2", source_unit_ids: [] },
    ]);
    expect(next.bullets.map((b) => b.id)).toEqual(["b2"]);
    expect(next.skills).toBe(c.skills);
    expect(next.summary).toBe(c.summary);
  });
});

describe("reorderBulletsInAsset (Firestore-mocked, sub-issue #195)", () => {
  it("returns 'no-change' when fromIndex === toIndex (no Firestore work)", async () => {
    const r = await reorderBulletsInAsset("app-1", "asset-1", "bullets", 0, 0);
    expect(r.status).toBe("no-change");
    expect(getDoc).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' when the application doesn't exist", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => false,
      data: () => undefined,
    });
    const r = await reorderBulletsInAsset(
      "missing",
      "asset-1",
      "bullets",
      0,
      1,
    );
    expect(r.status).toBe("application-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'application-not-found' on permission-denied (anti-enumeration parity)", async () => {
    getDoc.mockRejectedValueOnce(
      new FirebaseError("permission-denied", "denied"),
    );
    const r = await reorderBulletsInAsset(
      "foreign",
      "asset-1",
      "bullets",
      0,
      1,
    );
    expect(r.status).toBe("application-not-found");
  });

  it("returns 'asset-not-found' when the asset id is unknown", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await reorderBulletsInAsset(
      "app-1",
      "wrong-asset",
      "bullets",
      0,
      1,
    );
    expect(r.status).toBe("asset-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'index-not-found' when fromIndex is out of range", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await reorderBulletsInAsset(
      "app-1",
      "asset-1",
      "bullets",
      99,
      0,
    );
    expect(r.status).toBe("index-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'index-not-found' when toIndex is out of range", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await reorderBulletsInAsset(
      "app-1",
      "asset-1",
      "bullets",
      0,
      99,
    );
    expect(r.status).toBe("index-not-found");
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("returns 'index-not-found' for negative indices (distinct values to avoid the equal short-circuit)", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    const r = await reorderBulletsInAsset(
      "app-1",
      "asset-1",
      "bullets",
      -1,
      0,
    );
    expect(r.status).toBe("index-not-found");
  });

  it("reorders bullets within a section, flips status to stale, writes the patched generated_assets", async () => {
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application(),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await reorderBulletsInAsset(
      "app-1",
      "asset-1",
      "bullets",
      0,
      1,
    );
    expect(r.status).toBe("reordered");
    expect(updateDoc).toHaveBeenCalledTimes(1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const writtenAsset = writePayload.generated_assets[0];
    expect(writtenAsset.validation_status).toBe("stale");
    const bullets = writtenAsset.generated_content?.bullets ?? [];
    // Fixture order [b1, b2]; reorder 0 → 1 produces [b2, b1].
    expect(bullets.map((b) => b.id)).toEqual(["b2", "b1"]);
  });

  it("reorders skills when section='skills'", async () => {
    const a = asset({
      generated_content: {
        summary: { id: "s", text: "summary", source_unit_ids: [] },
        bullets: [],
        skills: [
          { id: "sk1", text: "skill 1", source_unit_ids: [] },
          { id: "sk2", text: "skill 2", source_unit_ids: [] },
          { id: "sk3", text: "skill 3", source_unit_ids: [] },
        ],
      },
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () => application({ generated_assets: [a] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    const r = await reorderBulletsInAsset(
      "app-1",
      "asset-1",
      "skills",
      2,
      0,
    );
    expect(r.status).toBe("reordered");
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const skills =
      writePayload.generated_assets[0].generated_content?.skills ?? [];
    // Reorder 2 → 0: [sk1, sk2, sk3] → [sk3, sk1, sk2].
    expect(skills.map((s) => s.id)).toEqual(["sk3", "sk1", "sk2"]);
  });

  it("does not flip an unrelated asset's status to stale when reordering a specific asset", async () => {
    const otherAsset = asset({
      id: "asset-2",
      kind: "cover_letter",
      validation_status: "passed",
    });
    getDoc.mockResolvedValueOnce({
      exists: () => true,
      data: () =>
        application({ generated_assets: [asset(), otherAsset] }),
    });
    updateDoc.mockResolvedValueOnce(undefined);
    await reorderBulletsInAsset("app-1", "asset-1", "bullets", 0, 1);
    const writePayload = updateDoc.mock.calls[0]?.[1] as {
      generated_assets: AssetRef[];
    };
    const untouched = writePayload.generated_assets.find(
      (a) => a.id === "asset-2",
    );
    expect(untouched?.validation_status).toBe("passed");
  });
});
