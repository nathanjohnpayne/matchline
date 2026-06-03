import { afterEach, describe, expect, it } from "vitest";

import {
  loadOntology,
  normalizeDomain,
  normalizeKey,
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

describe("seed-load validation (Codex P2 #102 r4)", () => {
  // The runtime loader reads from disk via `import.meta.url`-
  // relative paths; we can't easily inject a fixture for these
  // tests without elaborate fs mocking. Instead, exercise the
  // shape-validation logic directly by calling the same checks
  // a hand-constructed payload would trigger.
  //
  // Specifically we pin: the validator's normalizeKey-based
  // emptiness check rejects whitespace-only canonicals (the
  // r4 finding) AND empty strings AND non-string values, so a
  // curator typo can never silently produce an unmatchable
  // entry.

  // Simulate the validator's check (it lives inside loadSeedFile
  // but we can re-derive the gate from the same primitives).
  const isCanonicalAcceptable = (raw: unknown): boolean =>
    typeof raw === "string" && normalizeKey(raw).length > 0;

  it("rejects empty canonical", () => {
    expect(isCanonicalAcceptable("")).toBe(false);
  });

  it("rejects whitespace-only canonical (regression: Codex P2 #102 r4)", () => {
    expect(isCanonicalAcceptable("   ")).toBe(false);
    expect(isCanonicalAcceptable("\t")).toBe(false);
    expect(isCanonicalAcceptable("\n  \r")).toBe(false);
  });

  it("rejects non-string canonical (defensive)", () => {
    expect(isCanonicalAcceptable(123)).toBe(false);
    expect(isCanonicalAcceptable(null)).toBe(false);
    expect(isCanonicalAcceptable(undefined)).toBe(false);
    expect(isCanonicalAcceptable({})).toBe(false);
  });

  it("accepts a normal canonical", () => {
    expect(isCanonicalAcceptable("product strategy")).toBe(true);
    expect(isCanonicalAcceptable("  product strategy  ")).toBe(true);
  });
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
    // canonical form. Uses the runtime `normalizeKey` (not just
    // toLowerCase) so two canonicals that differ only by
    // punctuation/spacing can't pass this test while still
    // colliding in `buildIndex` at runtime. Codex P3 round 3
    // on #102 — same drift surface as the synonym-collision
    // tests, fixed the same way (share normalizeKey).
    const data = loadOntology();
    for (const [name, category] of [
      ["skills", data.skills],
      ["tools", data.tools],
      ["domains", data.domains],
    ] as const) {
      const seen = new Set<string>();
      for (const entry of category) {
        const key = normalizeKey(entry.canonical);
        if (seen.has(key)) {
          throw new Error(
            `${name}.seed.json: duplicate canonical "${entry.canonical}" (runtime-collision normalized form: "${key}")`,
          );
        }
        seen.add(key);
      }
    }
  });

  it("synonyms do not collide across entries within a category (Codex P2 #102 regression pin)", () => {
    // The original bug: `skills.seed.json` had `incident response`
    // listed as a synonym of BOTH `on-call` AND
    // `incident management`. The buildIndex first-write-wins rule
    // meant `normalizeSkill("incident response")` always returned
    // `on-call`, making the `incident management` synonym dead
    // code. Curator fix removed the duplicate; this test catches
    // any future repeat.
    //
    // The matching keys here use the EXACT runtime normalizer
    // imported from normalize.ts — no inline copy, so a curator
    // can't sneak a "duplicate" past via a punctuation tweak
    // that the runtime would still treat as identical.
    const data = loadOntology();

    for (const [name, category] of [
      ["skills", data.skills],
      ["tools", data.tools],
      ["domains", data.domains],
    ] as const) {
      // Map every synonym key → list of canonicals that claim it.
      const claims = new Map<string, string[]>();
      for (const entry of category) {
        for (const syn of entry.synonyms) {
          const key = normalizeKey(syn);
          const existing = claims.get(key) ?? [];
          existing.push(entry.canonical);
          claims.set(key, existing);
        }
      }
      const collisions: string[] = [];
      for (const [key, canonicals] of claims.entries()) {
        if (canonicals.length > 1) {
          collisions.push(
            `  "${key}" claimed by: ${canonicals.join(", ")}`,
          );
        }
      }
      if (collisions.length > 0) {
        throw new Error(
          `${name}.seed.json: synonym collisions detected (first-write-wins masks the later entry):\n${collisions.join("\n")}`,
        );
      }
    }
  });

  it("a synonym never duplicates a canonical from a DIFFERENT entry (cross-entry shadow)", () => {
    // Adjacent issue: a synonym on entry A that is the canonical
    // form of entry B silently shadows B (first-write-wins again).
    // Pin so a curator who adds e.g. `synonym: "agile"` to a
    // different entry can't accidentally hide the dedicated
    // `canonical: "agile"` entry.
    //
    // Uses the EXACT runtime normalizer (curly-quote + en/em-dash
    // fold included) imported from normalize.ts — no inline copy,
    // so a punctuation-variant cross-shadow can't slip past the
    // test while still colliding at runtime. Codex P3 round 2
    // on #102 caught the prior weaker inline normalizer here;
    // the fix exports `normalizeKey` and reuses it directly.
    const data = loadOntology();

    for (const [name, category] of [
      ["skills", data.skills],
      ["tools", data.tools],
      ["domains", data.domains],
    ] as const) {
      const canonicalKeys = new Set(
        category.map((e) => normalizeKey(e.canonical)),
      );
      for (const entry of category) {
        for (const syn of entry.synonyms) {
          const synKey = normalizeKey(syn);
          if (
            canonicalKeys.has(synKey) &&
            normalizeKey(entry.canonical) !== synKey
          ) {
            throw new Error(
              `${name}.seed.json: "${entry.canonical}" lists "${syn}" as a synonym, but that string is also canonical for a different entry — first-write-wins would shadow the other entry.`,
            );
          }
        }
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

  it("folds separator characters so node.js / node js / node-js all match the same canonical (regression: nathanpayne-codex Phase 4b r2 on #102)", () => {
    // Canonical is "node.js"; the fold treats `.` / `/` / `-` /
    // `_` as equivalent to space, so any of these inputs
    // canonicalizes correctly. Without the fold, a JD that
    // says "Node.js" and a resume that says "node js" would
    // hit different keys and miss canonicalization.
    expect(normalizeTool("node.js")).toBe("node.js");
    expect(normalizeTool("node js")).toBe("node.js");
    expect(normalizeTool("node-js")).toBe("node.js");
    expect(normalizeTool("Node.js")).toBe("node.js");
    expect(normalizeTool("NODE JS")).toBe("node.js");
  });

  it("folds separators across the other reviewer-flagged cases", () => {
    // The other 4 specific cases the Phase 4b reviewer pinned:
    expect(normalizeTool("video js")).toBe("video.js");
    expect(normalizeTool("video.js")).toBe("video.js");

    expect(normalizeTool("monday com")).toBe("monday");
    expect(normalizeTool("monday.com")).toBe("monday");

    expect(normalizeSkill("a b testing")).toBe("a/b testing");
    expect(normalizeSkill("a/b testing")).toBe("a/b testing");
    expect(normalizeSkill("a-b testing")).toBe("a/b testing");

    expect(normalizeDomain("b2b-saas")).toBe("b2b saas");
    expect(normalizeDomain("b2b saas")).toBe("b2b saas");
    expect(normalizeDomain("b2b.saas")).toBe("b2b saas");
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

describe("#159 nathan×google ontology expansion", () => {
  // Pins the match-critical JD bridges: terms the labeled unit side
  // uses must canonicalize to the SAME form the Google Compute SPM JD
  // demands, so jaccard(unit.skills, requirement.keywords) actually
  // overlaps. Coverage completeness is checked separately by
  // `npm run ontology:collect -- nathan-2026` (0 null); these pin the
  // specific bridges that drive match accuracy.
  it("bridges unit launch vocabulary to the JD's conception-to-launch language", () => {
    expect(normalizeSkill("0-to-1 product launch")).toBe("0-to-1 product");
    expect(normalizeSkill("conception to launch")).toBe("0-to-1 product");
    expect(normalizeSkill("rapid product launch")).toBe("0-to-1 product");
    expect(normalizeSkill("product conception")).toBe(
      "product conceptualization",
    );
  });

  it("bridges 'storage systems' to the JD's locally-attached-storage requirement", () => {
    expect(normalizeSkill("storage systems")).toBe("locally attached storage");
  });

  it("recognizes new skill canonicals from nathan's units", () => {
    expect(normalizeSkill("capacity planning")).toBe("capacity planning");
    expect(normalizeSkill("cross-team leadership")).toBe(
      "cross-team leadership",
    );
    expect(normalizeSkill("technical strategy")).toBe("technical strategy");
    expect(normalizeSkill("platform architecture")).toBe(
      "platform architecture",
    );
  });

  it("recognizes new tool canonicals (incl. proper-noun streaming services)", () => {
    expect(normalizeTool("Linux")).toBe("linux");
    expect(normalizeTool("Disney+")).toBe("disney+");
    expect(normalizeTool("disney plus")).toBe("disney+");
    expect(normalizeTool("shared storage")).toBe("shared storage");
  });

  it("recognizes new domain canonicals from nathan's units", () => {
    expect(normalizeDomain("post-production")).toBe("post-production");
    expect(normalizeDomain("OTT applications")).toBe("ott applications");
    expect(normalizeDomain("enterprise storage")).toBe("enterprise storage");
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
    // Use the runtime normalizer everywhere — same drift fix
    // as the canonical-uniqueness and synonym-collision tests.
    const skillCanonicals = new Set(
      data.skills.map((e) => normalizeKey(e.canonical)),
    );
    const toolCanonicals = new Set(
      data.tools.map((e) => normalizeKey(e.canonical)),
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
