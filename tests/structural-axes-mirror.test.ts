/**
 * Pins the app's copy of the structural-axes list against the
 * matcher's (#602).
 *
 * `computeGaps` decides "could not be evaluated" from the persisted
 * `component_applicability`, using the five axes that carry
 * Requirement-side evidence. The list is declared in
 * `functions/src/matching/score.ts`, which the browser bundle
 * cannot import (its ontology loader pulls in `node:fs`), so the
 * app keeps a mirror. This file spans both packages and keeps them
 * equal: an axis added on one side only would either reclassify an
 * evaluated must-have as not evaluated or the reverse.
 */

import { describe, expect, it } from "vitest";

import { STRUCTURAL_AXES as SERVER } from "../functions/src/matching/score.ts";
import { STRUCTURAL_AXES as CLIENT } from "../src/routes/RoleDetail/computeGaps.ts";

describe("structural axes mirror", () => {
  it("the app's list equals the matcher's, in order", () => {
    expect([...CLIENT]).toEqual([...SERVER]);
  });
});
