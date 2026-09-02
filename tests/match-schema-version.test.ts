/**
 * Pins the reader's schema-version constant against the writer's
 * (#444).
 *
 * `MATCH_SCHEMA_VERSION` is stamped on every row by
 * `functions/src/matching/pipeline.ts`;
 * `RATIONALE_GATED_SCHEMA_VERSION` is what the browser bundle
 * compares against. They cannot share a module — the app imports
 * its copy at runtime and the functions package is a separate
 * build — so this file, one of the few tsconfig projects spanning
 * both, is what keeps them honest. Same arrangement as
 * `callable-timeout-budget.test.ts`.
 *
 * If a future write-contract change bumps the writer without
 * moving the reader, every freshly written match would be read
 * as trustworthy by the version clause anyway (>= is a floor) —
 * so the failure this catches is the opposite direction: a reader
 * floor raised above what the writer stamps, which would silently
 * hide EVERY rationale.
 */

import { describe, expect, it } from "vitest";

import { MATCH_SCHEMA_VERSION } from "../functions/src/matching/pipeline.ts";
import { RATIONALE_GATED_SCHEMA_VERSION } from "../src/routes/RoleDetail/matchProvenance.ts";

describe("match schema version", () => {
  it("the reader's floor is never above what the writer stamps", () => {
    expect(RATIONALE_GATED_SCHEMA_VERSION).toBeLessThanOrEqual(
      MATCH_SCHEMA_VERSION,
    );
  });

  it("both are positive integers", () => {
    for (const v of [MATCH_SCHEMA_VERSION, RATIONALE_GATED_SCHEMA_VERSION]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it("a row stamped by the pipeline reads as trustworthy", () => {
    // The end-to-end statement the two constants exist to make.
    expect(MATCH_SCHEMA_VERSION).toBeGreaterThanOrEqual(
      RATIONALE_GATED_SCHEMA_VERSION,
    );
  });
});
