import { describe, expect, it } from "vitest";

import type { AssetRef, GeneratedAssetContent } from "../../types/crm.ts";

import { selectPrimaryResumeAsset } from "./selectPrimaryResumeAsset.ts";

function content(): GeneratedAssetContent {
  return {
    summary: { id: "s", text: "summary", source_unit_ids: [] },
    bullets: [],
    skills: [],
  };
}

function asset(partial: Partial<AssetRef> & { id: string }): AssetRef {
  const defaults: Omit<AssetRef, "id"> = {
    owner_uid: "u",
    application_id: "app",
    kind: "resume",
    format: "json",
    storage_path: "",
    generated_content: content(),
    validation_status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

describe("selectPrimaryResumeAsset", () => {
  it("returns null when no assets exist", () => {
    expect(selectPrimaryResumeAsset([])).toBeNull();
  });

  it("returns null when no resume/json/generated asset exists", () => {
    expect(
      selectPrimaryResumeAsset([
        asset({ id: "binary", format: "pdf", generated_content: undefined }),
      ]),
    ).toBeNull();
    expect(
      selectPrimaryResumeAsset([asset({ id: "letter", kind: "cover_letter" })]),
    ).toBeNull();
    expect(
      selectPrimaryResumeAsset([
        asset({ id: "no-content", generated_content: undefined }),
      ]),
    ).toBeNull();
  });

  it("returns the most-recently-created eligible asset", () => {
    // Two json/resume assets; pick by created_at desc.
    const older = asset({ id: "older", created_at: "2026-01-01T00:00:00.000Z" });
    const newer = asset({ id: "newer", created_at: "2026-04-01T00:00:00.000Z" });
    expect(selectPrimaryResumeAsset([older, newer])?.id).toBe("newer");
    expect(selectPrimaryResumeAsset([newer, older])?.id).toBe("newer");
  });

  it("ignores ineligible assets when picking the most recent", () => {
    // Newer cover_letter must not win over an older resume.
    const olderResume = asset({
      id: "resume",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const newerLetter = asset({
      id: "letter",
      kind: "cover_letter",
      created_at: "2026-04-01T00:00:00.000Z",
    });
    expect(
      selectPrimaryResumeAsset([olderResume, newerLetter])?.id,
    ).toBe("resume");
  });
});
