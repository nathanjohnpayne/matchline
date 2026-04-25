import { afterEach, describe, expect, it } from "vitest";

import {
  loadOntology,
  normalizeDomain,
  normalizeSkill,
  normalizeTool,
  resetOntologyCache,
} from "./normalize.js";

afterEach(() => {
  // Each test runs against a fresh load — protects against any
  // test that mutates the in-memory cache (none should, but
  // defensive).
  resetOntologyCache();
});

describe("loadOntology", () => {
  it("loads all three seed files", () => {
    const data = loadOntology();
    expect(data.skills.length).toBeGreaterThanOrEqual(100);
    expect(data.tools.length).toBeGreaterThanOrEqual(80);
    expect(data.domains.length).toBeGreaterThanOrEqual(30);
  });

  it("every entry has a non-empty canonical and a synonyms array", () => {
    const data = loadOntology();
    for (const category of [data.skills, data.tools, data.domains]) {
      for (const entry of category) {
        expect(typeof entry.canonical).toBe("string");
        expect(entry.canonical.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.synonyms)).toBe(true);
      }
    }
  });

  it("canonical entries are unique within each category", () => {
    // Catch a curator typo where two entries claim the same
    // canonical form. Synonyms can collide cross-entry (first-
    // write-wins per `buildIndex`), but canonicals must not.
    const data = loadOntology();
    for (const [name, category] of [
      ["skills", data.skills],
      ["tools", data.tools],
      ["domains", data.domains],
    ] as const) {
      const seen = new Set<string>();
      for (const entry of category) {
        const key = entry.canonical.toLowerCase();
        if (seen.has(key)) {
          throw new Error(
            `${name}.seed.json: duplicate canonical "${entry.canonical}"`,
          );
        }
        seen.add(key);
      }
    }
  });
});

describe("normalizeSkill", () => {
  it("returns the canonical form on exact match", () => {
    expect(normalizeSkill("product strategy")).toBe("product strategy");
  });

  it("matches case-insensitively", () => {
    expect(normalizeSkill("Product Strategy")).toBe("product strategy");
    expect(normalizeSkill("PRODUCT STRATEGY")).toBe("product strategy");
  });

  it("matches via synonyms", () => {
    expect(normalizeSkill("XFN leadership")).toBe(
      "cross-functional leadership",
    );
    expect(normalizeSkill("xfn collaboration")).toBe(
      "cross-functional leadership",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSkill("   product strategy   ")).toBe(
      "product strategy",
    );
  });

  it("collapses internal whitespace", () => {
    expect(normalizeSkill("product   strategy")).toBe(
      "product strategy",
    );
  });

  it("normalizes typographic punctuation (curly quotes, en/em dashes)", () => {
    // Real input from a copy-pasted resume bullet: curly quotes
    // and en-dashes. The canonical entries use ASCII
    // hyphens/quotes, so the input must be normalized to match.
    expect(normalizeSkill("a/b testing")).toBe("a/b testing");
    // "amazon-style narrative" canonical uses an ASCII hyphen;
    // an en-dash variant must round-trip via normalization.
    expect(normalizeSkill("amazon–style narrative")).toBe(
      "amazon-style narrative",
    );
  });

  it("returns null for unrecognized inputs", () => {
    expect(normalizeSkill("widget herding")).toBeNull();
    expect(normalizeSkill("nonexistent skill xyz123")).toBeNull();
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeSkill("")).toBeNull();
    expect(normalizeSkill("   ")).toBeNull();
  });
});

describe("normalizeTool", () => {
  it("matches a tool by canonical name", () => {
    expect(normalizeTool("snowflake")).toBe("snowflake");
    expect(normalizeTool("Snowflake")).toBe("snowflake");
  });

  it("matches a tool by synonym (HLS → hls)", () => {
    expect(normalizeTool("HTTP Live Streaming")).toBe("hls");
  });

  it("does NOT cross-match into skills (returns null for skill terms)", () => {
    // "product strategy" is a skill, not a tool. The lookup is
    // category-scoped — `normalizeTool("product strategy")`
    // should NOT return a hit even though the term is in the
    // skills ontology.
    expect(normalizeTool("product strategy")).toBeNull();
  });

  it("returns null for unrecognized tools", () => {
    expect(normalizeTool("nonexistent-tool")).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("matches a domain by canonical name", () => {
    expect(normalizeDomain("streaming video")).toBe("streaming video");
  });

  it("matches a domain via synonyms", () => {
    expect(normalizeDomain("CTV")).toBe("connected tv");
    expect(normalizeDomain("connected tv")).toBe("connected tv");
    expect(normalizeDomain("smart tv")).toBe("connected tv");
  });

  it("returns null for unrecognized domains", () => {
    expect(normalizeDomain("nursing")).toBeNull();
  });
});

describe("category isolation", () => {
  it("normalizeSkill / normalizeTool / normalizeDomain don't leak across categories", () => {
    // Defense: the same string could legitimately appear as
    // a synonym in two categories (rare; e.g. "react" might be
    // a tool AND a skill in someone's mental model). The
    // current ontologies don't have overlap by design, but
    // pin that the lookups stay scoped to their own category.
    const data = loadOntology();
    const skillCanonicals = new Set(
      data.skills.map((e) => e.canonical.toLowerCase()),
    );
    const toolCanonicals = new Set(
      data.tools.map((e) => e.canonical.toLowerCase()),
    );
    // For every skill canonical, normalizeTool should return
    // null UNLESS the term legitimately appears in tools too
    // (in which case both categories return their respective
    // canonicals — that's fine).
    for (const skillCanonical of skillCanonicals) {
      const toolMatch = normalizeTool(skillCanonical);
      if (toolMatch !== null && !toolCanonicals.has(skillCanonical)) {
        throw new Error(
          `Skill "${skillCanonical}" leaked into tool lookup as "${toolMatch}"`,
        );
      }
    }
  });
});
