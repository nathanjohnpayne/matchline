import { describe, expect, it } from "vitest";

import type { ValidationFlag } from "../../types/crm.ts";

import { flagsByBullet } from "./flagsByBullet.ts";

function flag(
  partial: Partial<ValidationFlag> & { id: string },
): ValidationFlag {
  return {
    asset_id: "asset",
    bullet_id: "b",
    claim_id: "c",
    status: "untraceable",
    rationale: "r",
    created_at: "2026-04-01T00:00:00.000Z",
    ...partial,
  };
}

describe("flagsByBullet", () => {
  it("returns an empty map for undefined or empty flags", () => {
    expect(flagsByBullet(undefined).size).toBe(0);
    expect(flagsByBullet([]).size).toBe(0);
  });

  it("groups multiple flags on the same bullet id", () => {
    const result = flagsByBullet([
      flag({ id: "f1", bullet_id: "b1", status: "untraceable" }),
      flag({ id: "f2", bullet_id: "b1", status: "specificity" }),
      flag({ id: "f3", bullet_id: "b2", status: "untraceable" }),
    ]);
    expect(result.get("b1")?.length).toBe(2);
    expect(result.get("b2")?.length).toBe(1);
  });

  it("drops 'traced' flags (they passed validation, no badge needed)", () => {
    const result = flagsByBullet([
      flag({ id: "f1", bullet_id: "b1", status: "traced" }),
      flag({ id: "f2", bullet_id: "b1", status: "untraceable" }),
    ]);
    expect(result.get("b1")?.length).toBe(1);
    expect(result.get("b1")?.[0]?.status).toBe("untraceable");
  });

  it("does not create a key when all of a bullet's flags are 'traced'", () => {
    const result = flagsByBullet([
      flag({ id: "f1", bullet_id: "b1", status: "traced" }),
    ]);
    expect(result.has("b1")).toBe(false);
  });

  it("preserves source order of flags within a bullet", () => {
    const result = flagsByBullet([
      flag({ id: "f1", bullet_id: "b1", status: "untraceable" }),
      flag({ id: "f2", bullet_id: "b1", status: "specificity" }),
    ]);
    const list = result.get("b1") ?? [];
    expect(list.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});
