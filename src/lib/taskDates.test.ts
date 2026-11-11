import { describe, expect, it } from "vitest";

import { dateInputToIso, formatDueDate, isoToDateInput } from "./taskDates.ts";

describe("dateInputToIso", () => {
  it("stores a picked day as local noon", () => {
    expect(dateInputToIso("2026-10-23")).toBe(
      new Date(2026, 9, 23, 12, 0, 0).toISOString(),
    );
  });

  it("returns undefined for blank or malformed input", () => {
    expect(dateInputToIso("")).toBeUndefined();
    expect(dateInputToIso("10/23/2026")).toBeUndefined();
    expect(dateInputToIso("2026-1-3")).toBeUndefined();
  });

  it("rejects a day that does not exist", () => {
    expect(dateInputToIso("2026-02-31")).toBeUndefined();
    expect(dateInputToIso("2026-13-01")).toBeUndefined();
  });
});

describe("isoToDateInput", () => {
  it("round-trips a picked day", () => {
    expect(isoToDateInput(dateInputToIso("2026-10-23"))).toBe("2026-10-23");
  });

  it("formats any instant as its local day", () => {
    expect(isoToDateInput(new Date(2026, 0, 5, 23, 30).toISOString())).toBe("2026-01-05");
  });

  it("returns an empty string for missing or invalid input", () => {
    expect(isoToDateInput(undefined)).toBe("");
    expect(isoToDateInput("nope")).toBe("");
  });
});

describe("formatDueDate", () => {
  it("returns a short label, or null when there is no valid date", () => {
    expect(formatDueDate(new Date(2026, 9, 23, 12).toISOString())).toMatch(/23/);
    expect(formatDueDate(undefined)).toBeNull();
    expect(formatDueDate("nope")).toBeNull();
  });
});
