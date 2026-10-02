import { describe, expect, it } from "vitest";

import {
  assetContentVersion,
  canonicalJson,
  validationAttestationId,
} from "./attestation.ts";

const CONTENT = {
  summary: { id: "s", text: "Summary.", source_unit_ids: ["u1"] },
  bullets: [{ id: "b1", text: "Led a team.", source_unit_ids: ["u2"] }],
  skills: [],
};

describe("canonicalJson", () => {
  it("is independent of object key order at every level", () => {
    const reordered = {
      skills: [],
      bullets: [{ source_unit_ids: ["u2"], text: "Led a team.", id: "b1" }],
      summary: { text: "Summary.", source_unit_ids: ["u1"], id: "s" },
    };
    expect(canonicalJson(reordered)).toBe(canonicalJson(CONTENT));
  });

  it("keeps array order, which is meaningful (bullet order)", () => {
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it("drops undefined members, as Firestore never stores them", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("assetContentVersion", () => {
  it("is stable for equal content and prefixed with its encoding version", () => {
    expect(assetContentVersion(CONTENT)).toBe(assetContentVersion(structuredClone(CONTENT)));
    expect(assetContentVersion(CONTENT)).toMatch(/^cv2-[0-9a-f]{64}$/);
  });

  it("ignores item order within a section, which reorder preserves `passed` across", () => {
    const two = {
      ...CONTENT,
      bullets: [
        { id: "b1", text: "Led a team.", source_unit_ids: ["u2"] },
        { id: "b2", text: "Shipped it.", source_unit_ids: ["u3"] },
      ],
      skills: [
        { id: "k1", text: "Go", source_unit_ids: ["u2"] },
        { id: "k2", text: "SQL", source_unit_ids: ["u3"] },
      ],
    };
    const reordered = {
      ...two,
      bullets: [two.bullets[1], two.bullets[0]],
      skills: [two.skills[1], two.skills[0]],
    };
    expect(assetContentVersion(reordered)).toBe(assetContentVersion(two));
  });

  it("still distinguishes which section an item is in", () => {
    const item = { id: "x1", text: "Go", source_unit_ids: ["u2"] };
    expect(assetContentVersion({ ...CONTENT, bullets: [item], skills: [] })).not.toBe(
      assetContentVersion({ ...CONTENT, bullets: [], skills: [item] }),
    );
  });

  it("changes with any edit to the content", () => {
    const v = assetContentVersion(CONTENT);
    expect(
      assetContentVersion({ ...CONTENT, bullets: [{ ...CONTENT.bullets[0], text: "Led two teams." }] }),
    ).not.toBe(v);
    expect(
      assetContentVersion({ ...CONTENT, bullets: [{ ...CONTENT.bullets[0], source_unit_ids: ["u3"] }] }),
    ).not.toBe(v);
  });
});

describe("validationAttestationId", () => {
  it("joins the asset id and content version into a valid Firestore doc id", () => {
    const id = validationAttestationId("asset-1", assetContentVersion(CONTENT));
    expect(id).toMatch(/^asset-1__cv2-[0-9a-f]{64}$/);
    expect(id).not.toContain("/");
  });
});
