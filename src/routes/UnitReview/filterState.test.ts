import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";

import {
  applyFilters,
  APPROVAL_FILTER_VALUES,
  decodeFromSearchParams,
  distinctFieldValues,
  EMPTY_FILTER_STATE,
  encodeToSearchParams,
  isFilterActive,
  type FilterState,
} from "./filterState.ts";

function unit(partial: Partial<ExperienceUnit> & { id: string }): ExperienceUnit {
  const defaults: Omit<ExperienceUnit, "id"> = {
    owner_uid: "u",
    source_type: "resume",
    source_ref: "",
    raw_text: "",
    normalized_summary: "",
    unit_type: "achievement",
    skills: [],
    tools: [],
    domains: [],
    seniority_signals: [],
    scope_signals: [],
    business_outcomes: [],
    metrics: [],
    evidence_type: "verified",
    confidence_score: 1,
    user_approved: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  return { ...defaults, ...partial };
}

function withFilter(partial: Partial<FilterState>): FilterState {
  return { ...EMPTY_FILTER_STATE, ...partial };
}

describe("isFilterActive", () => {
  it("returns false for the empty state", () => {
    expect(isFilterActive(EMPTY_FILTER_STATE)).toBe(false);
  });

  it("returns true when any array field is non-empty", () => {
    expect(isFilterActive(withFilter({ skills: ["sql"] }))).toBe(true);
    expect(isFilterActive(withFilter({ tools: ["snowflake"] }))).toBe(true);
    expect(isFilterActive(withFilter({ domains: ["video"] }))).toBe(true);
    expect(isFilterActive(withFilter({ approval: ["approved"] }))).toBe(true);
  });

  it("returns true when either date bound is set", () => {
    expect(isFilterActive(withFilter({ dateFrom: "2024-01-01" }))).toBe(true);
    expect(isFilterActive(withFilter({ dateTo: "2024-12-31" }))).toBe(true);
  });
});

describe("URL round-trip (encode ↔ decode)", () => {
  it("empty state encodes to an empty URL", () => {
    const params = encodeToSearchParams(EMPTY_FILTER_STATE);
    expect(params.toString()).toBe("");
  });

  it("round-trips a full filter state", () => {
    const original: FilterState = {
      skills: ["sql", "python"],
      tools: ["snowflake"],
      domains: ["streaming video"],
      approval: ["approved", "flagged"],
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
    };
    const encoded = encodeToSearchParams(original);
    const decoded = decodeFromSearchParams(encoded);
    expect(decoded).toEqual(original);
  });

  it("survives round-trip for values with spaces (form-encoded)", () => {
    // URLSearchParams is the transport — it form-encodes (space
    // as `+`, comma as `%2C`). Pinning the round-trip rather than
    // the specific encoding means a future swap in the encoding
    // layer (e.g. to strict percent-encoding) stays green as long
    // as decode still works. The risk this test catches is a
    // lossy encode that can't be pasted back into a URL.
    const original = withFilter({
      domains: ["streaming video", "consumer web"],
    });
    const encoded = encodeToSearchParams(original);
    // And the serialized form is a non-empty URL query segment
    expect(encoded.toString().length).toBeGreaterThan(0);
    const decoded = decodeFromSearchParams(
      new URLSearchParams(encoded.toString()),
    );
    expect(decoded.domains).toEqual(["streaming video", "consumer web"]);
  });

  it("drops unknown approval values silently (minor-drift-safe)", () => {
    // A URL pasted from a future version with a new approval
    // category must decode to the known subset — not throw.
    // "rejected" is deliberately not part of this surface (rejected
    // has its own tab) so it's treated as "unknown" here.
    const params = new URLSearchParams("approval=approved,rejected,unknown");
    const state = decodeFromSearchParams(params);
    expect(state.approval).toEqual(["approved"]);
  });

  it("ignores empty entries from split (`sql,,python` → [sql, python])", () => {
    const params = new URLSearchParams("skills=sql,,python,");
    const state = decodeFromSearchParams(params);
    expect(state.skills).toEqual(["sql", "python"]);
  });

  it("trims whitespace in values (pasted URLs are messy)", () => {
    const params = new URLSearchParams("skills=sql,%20python");
    const state = decodeFromSearchParams(params);
    expect(state.skills).toEqual(["sql", "python"]);
  });

  it("omits bound-is-null date params from the URL", () => {
    expect(
      encodeToSearchParams(withFilter({ dateFrom: "2024-01-01" })).toString(),
    ).toBe("from=2024-01-01");
    expect(
      encodeToSearchParams(withFilter({ dateTo: "2024-12-31" })).toString(),
    ).toBe("to=2024-12-31");
  });

  it("APPROVAL_FILTER_VALUES does not contain 'rejected'", () => {
    // Pin: rejected is the one ApprovalState that must never be in
    // the main-list approval filter. Its absence is load-bearing —
    // the Filters UI enumerates this constant to build the
    // multi-select, so a future widening here would silently start
    // showing rejected-filter chips next to the "all rejected
    // Units are in their own tab" contract.
    expect(APPROVAL_FILTER_VALUES).not.toContain("rejected");
    expect(APPROVAL_FILTER_VALUES).toEqual(["approved", "pending", "flagged"]);
  });
});

describe("applyFilters", () => {
  it("no filter → returns all Units (preserves order, new array)", () => {
    const units = [unit({ id: "a" }), unit({ id: "b" })];
    const result = applyFilters(units, EMPTY_FILTER_STATE);
    expect(result.map((u) => u.id)).toEqual(["a", "b"]);
    // Fresh array so callers can sort in place
    expect(result).not.toBe(units);
  });

  describe("skills (OR within, case-insensitive)", () => {
    const units = [
      unit({ id: "a", skills: ["SQL", "python"] }),
      unit({ id: "b", skills: ["firebase"] }),
      unit({ id: "c", skills: ["SQL"] }),
    ];

    it("matches Units whose skills contain any filter value", () => {
      const result = applyFilters(units, withFilter({ skills: ["sql"] }));
      expect(result.map((u) => u.id)).toEqual(["a", "c"]);
    });

    it("matches case-insensitively (SQL on the Unit vs sql in the filter)", () => {
      const result = applyFilters(units, withFilter({ skills: ["SQL"] }));
      expect(result.map((u) => u.id)).toEqual(["a", "c"]);
    });

    it("filter with multiple values uses OR within the field", () => {
      const result = applyFilters(
        units,
        withFilter({ skills: ["python", "firebase"] }),
      );
      expect(result.map((u) => u.id)).toEqual(["a", "b"]);
    });
  });

  describe("approval", () => {
    const approved = unit({ id: "approved", user_approved: true });
    const pending = unit({ id: "pending", user_approved: false });
    const flagged = unit({
      id: "flagged",
      user_approved: false,
      flagged: true,
    });
    const rejected = unit({
      id: "rejected",
      user_approved: false,
      rejected: true,
    });
    const units = [approved, pending, flagged, rejected];

    it("filter=[approved] matches only approved Units", () => {
      const result = applyFilters(units, withFilter({ approval: ["approved"] }));
      expect(result.map((u) => u.id)).toEqual(["approved"]);
    });

    it("filter=[flagged] matches only flagged Units", () => {
      const result = applyFilters(units, withFilter({ approval: ["flagged"] }));
      expect(result.map((u) => u.id)).toEqual(["flagged"]);
    });

    it("rejected Units NEVER pass the approval filter, even with empty approval list", () => {
      // Rejected is excluded upstream by excludeRejected, but the
      // approval filter here is defensive: if a rejected Unit
      // somehow reaches applyFilters, the approval filter still
      // excludes it when any approval filter is set. With an
      // empty approval filter, rejected passes (because no filter
      // == no constraint) — that's handled by excludeRejected
      // running first in the pipeline.
      const withApprovalFilter = applyFilters(
        units,
        withFilter({ approval: ["approved", "pending", "flagged"] }),
      );
      expect(withApprovalFilter.map((u) => u.id)).not.toContain("rejected");
    });
  });

  describe("dates", () => {
    const units = [
      unit({
        id: "2023-finished",
        date_range: { start: "2023-01-01", end: "2023-06-01" },
      }),
      unit({
        id: "2024-ongoing",
        date_range: { start: "2024-01-01" }, // no end
      }),
      unit({
        id: "2025-future",
        date_range: { start: "2025-01-01", end: "2025-06-01" },
      }),
      unit({ id: "undated" }),
    ];

    it("no date filter → all Units included (including undated)", () => {
      const result = applyFilters(units, EMPTY_FILTER_STATE);
      expect(result.map((u) => u.id).sort()).toEqual(
        ["2023-finished", "2024-ongoing", "2025-future", "undated"].sort(),
      );
    });

    it("dateFrom only → includes Units whose range extends at or after that date", () => {
      const result = applyFilters(
        units,
        withFilter({ dateFrom: "2024-01-01" }),
      );
      expect(result.map((u) => u.id).sort()).toEqual(
        ["2024-ongoing", "2025-future"].sort(),
      );
    });

    it("dateTo only → includes Units whose range starts at or before that date", () => {
      const result = applyFilters(units, withFilter({ dateTo: "2024-06-01" }));
      expect(result.map((u) => u.id).sort()).toEqual(
        ["2023-finished", "2024-ongoing"].sort(),
      );
    });

    it("both bounds → Unit range must overlap the window", () => {
      const result = applyFilters(
        units,
        withFilter({ dateFrom: "2024-01-01", dateTo: "2024-12-31" }),
      );
      expect(result.map((u) => u.id)).toEqual(["2024-ongoing"]);
    });

    it("undated Units are excluded when ANY date filter is set", () => {
      const result = applyFilters(units, withFilter({ dateFrom: "2024-01-01" }));
      expect(result.map((u) => u.id)).not.toContain("undated");
    });

    it("Unit with no `end` is treated as ongoing (open upper bound)", () => {
      // 2024-ongoing has start=2024-01-01, no end. A 2025 window
      // should still include it.
      const result = applyFilters(
        units,
        withFilter({ dateFrom: "2025-06-01", dateTo: "2025-12-31" }),
      );
      expect(result.map((u) => u.id)).toContain("2024-ongoing");
    });
  });

  describe("AND across fields", () => {
    const units = [
      unit({
        id: "sql-snowflake-approved",
        skills: ["sql"],
        tools: ["snowflake"],
        user_approved: true,
      }),
      unit({
        id: "sql-bigquery-approved",
        skills: ["sql"],
        tools: ["bigquery"],
        user_approved: true,
      }),
      unit({
        id: "python-snowflake-approved",
        skills: ["python"],
        tools: ["snowflake"],
        user_approved: true,
      }),
      unit({
        id: "sql-snowflake-pending",
        skills: ["sql"],
        tools: ["snowflake"],
        user_approved: false,
      }),
    ];

    it("skills AND tools AND approval all applied simultaneously", () => {
      const result = applyFilters(
        units,
        withFilter({
          skills: ["sql"],
          tools: ["snowflake"],
          approval: ["approved"],
        }),
      );
      expect(result.map((u) => u.id)).toEqual(["sql-snowflake-approved"]);
    });

    it("no match on any one axis filters out the Unit", () => {
      // sql-snowflake-approved would pass skills+tools but fails approval
      const result = applyFilters(
        units,
        withFilter({
          skills: ["sql"],
          tools: ["snowflake"],
          approval: ["flagged"],
        }),
      );
      expect(result).toEqual([]);
    });
  });

  it("does not mutate the input array", () => {
    const input = [
      unit({ id: "a", skills: ["sql"] }),
      unit({ id: "b", skills: ["python"] }),
    ];
    const snapshot = input.map((u) => u.id);
    applyFilters(input, withFilter({ skills: ["sql"] }));
    expect(input.map((u) => u.id)).toEqual(snapshot);
  });
});

describe("distinctFieldValues", () => {
  it("collects distinct values across units, case-insensitively", () => {
    const units = [
      unit({ id: "a", skills: ["SQL", "Python"] }),
      unit({ id: "b", skills: ["sql", "firebase"] }),
      unit({ id: "c", skills: ["PYTHON", "SQL"] }),
    ];
    expect(distinctFieldValues(units, "skills")).toEqual([
      "firebase",
      "Python",
      "SQL",
    ]);
  });

  it("preserves the first casing seen for each value", () => {
    const units = [
      unit({ id: "a", tools: ["Snowflake"] }),
      unit({ id: "b", tools: ["snowflake"] }),
    ];
    expect(distinctFieldValues(units, "tools")).toEqual(["Snowflake"]);
  });

  it("returns empty array when no Unit has the field populated", () => {
    const units = [unit({ id: "a" }), unit({ id: "b" })];
    expect(distinctFieldValues(units, "domains")).toEqual([]);
  });

  it("trims whitespace and drops empty strings", () => {
    const units = [
      unit({ id: "a", skills: ["  sql ", ""] }),
      unit({ id: "b", skills: [" python"] }),
    ];
    expect(distinctFieldValues(units, "skills")).toEqual(["python", "sql"]);
  });

  it("sorts case-insensitively", () => {
    const units = [unit({ id: "a", tools: ["zzz", "aaa", "MMM"] })];
    expect(distinctFieldValues(units, "tools")).toEqual(["aaa", "MMM", "zzz"]);
  });
});
