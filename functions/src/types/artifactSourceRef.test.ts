import { describe, expect, it } from "vitest";

import {
  buildArtifactSourceRef,
  parseArtifactSourceRef,
  type ArtifactSourceRef,
} from "./artifactSourceRef.ts";

describe("buildArtifactSourceRef", () => {
  it("builds the #87 format with and without a section", () => {
    expect(buildArtifactSourceRef({ uid: "u1", filename: "deck.pptx" })).toBe(
      "artifact://users/u1/artifacts/deck.pptx",
    );
    expect(
      buildArtifactSourceRef({
        uid: "u1",
        filename: "deck.pptx",
        section: "slide-4",
      }),
    ).toBe("artifact://users/u1/artifacts/deck.pptx#slide-4");
  });

  it("percent-encodes characters that would break the path or fragment", () => {
    expect(
      buildArtifactSourceRef({
        uid: "u1",
        filename: "Q3 #1/final é.pdf",
        section: "page 2#b",
      }),
    ).toBe(
      "artifact://users/u1/artifacts/Q3%20%231%2Ffinal%20%C3%A9.pdf#page%202%23b",
    );
  });

  it("rejects empty parts that could not round-trip", () => {
    expect(() => buildArtifactSourceRef({ uid: "", filename: "a.pdf" })).toThrow(
      RangeError,
    );
    expect(() => buildArtifactSourceRef({ uid: "u1", filename: "" })).toThrow(
      RangeError,
    );
    expect(() =>
      buildArtifactSourceRef({ uid: "u1", filename: "a.pdf", section: "" }),
    ).toThrow(RangeError);
  });
});

describe("parseArtifactSourceRef", () => {
  const roundTrips: readonly ArtifactSourceRef[] = [
    { uid: "u1", filename: "resume.pdf" },
    { uid: "u1", filename: "resume.pdf", section: "page-3" },
    { uid: "u1", filename: "notes #2.docx" },
    { uid: "u1", filename: "notes #2.docx", section: "Section #4" },
    { uid: "u1", filename: "board review deck.pptx", section: "slide 7" },
    { uid: "u1", filename: "Résumé – 2026 → final.pdf" },
    { uid: "u1", filename: "履歴書.pdf", section: "職歴" },
    { uid: "u1", filename: "emoji 🚀.pdf", section: "p. 1" },
    { uid: "u1", filename: "a/b.pdf" },
    { uid: "u1", filename: "100%.pdf", section: "50%" },
  ];

  it.each(roundTrips)("round-trips %j", (input) => {
    const ref = buildArtifactSourceRef(input);
    expect(parseArtifactSourceRef(ref)).toEqual(input);
    // Strict parsing makes the pair a bijection on valid refs.
    expect(buildArtifactSourceRef(parseArtifactSourceRef(ref)!)).toBe(ref);
  });

  it("omits section, rather than setting it undefined, for a whole-file ref", () => {
    const parsed = parseArtifactSourceRef(
      "artifact://users/u1/artifacts/resume.pdf",
    );
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!)).toEqual(["uid", "filename"]);
  });

  it.each([
    // The resume pipeline's format (functions/src/extraction/resume.ts).
    "resume:3f2a9c:0",
    // The manual-entry default and free text (experienceUnits-state.ts).
    "manual entry",
    "resume.pdf",
    "profile.html",
    "",
  ])("returns null for the non-artifact ref %j", (ref) => {
    expect(parseArtifactSourceRef(ref)).toBeNull();
  });

  it.each([
    ["wrong scheme case", "Artifact://users/u1/artifacts/a.pdf"],
    ["no path", "artifact://"],
    ["missing filename", "artifact://users/u1/artifacts/"],
    ["missing uid", "artifact://users//artifacts/a.pdf"],
    ["extra segment", "artifact://users/u1/artifacts/dir/a.pdf"],
    ["wrong collection", "artifact://users/u1/uploads/a.pdf"],
    ["wrong root", "artifact://people/u1/artifacts/a.pdf"],
    ["empty fragment", "artifact://users/u1/artifacts/a.pdf#"],
    ["malformed escape", "artifact://users/u1/artifacts/a%ZZ.pdf"],
    ["truncated UTF-8 escape", "artifact://users/u1/artifacts/a%C3.pdf"],
    ["unencoded space", "artifact://users/u1/artifacts/a b.pdf"],
    ["unencoded fragment hash", "artifact://users/u1/artifacts/a.pdf#p#2"],
    ["non-canonical lowercase escape", "artifact://users/u1/artifacts/a%2fb.pdf"],
  ])("returns null for a malformed artifact ref (%s)", (_label, ref) => {
    expect(parseArtifactSourceRef(ref)).toBeNull();
  });
});
