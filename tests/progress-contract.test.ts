/**
 * Cross-package progress vocabulary contract (#428).
 *
 * The client cannot import `functions/src/llm/progress.ts` — separate
 * package, separate `node_modules` — so the stage vocabulary is
 * declared on both sides. Nothing but this test connects them, and a
 * silent divergence would mean the server emits a stage the client
 * discards, degrading the report to its no-event fallback with no
 * error anywhere.
 *
 * Same arrangement, and same reasoning, as
 * `tests/callable-timeout-budget.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { PROGRESS_STAGES as SERVER_STAGES } from "../functions/src/llm/progress.ts";
import {
  PROGRESS_STAGES as CLIENT_STAGES,
  parseProgressEvent,
} from "../src/services/progress.ts";

describe("progress vocabulary contract", () => {
  it("declares the same stages on both sides, in the same order", () => {
    expect([...CLIENT_STAGES]).toEqual([...SERVER_STAGES]);
  });

  it("accepts every stage the server can emit", () => {
    // The failure this catches: a stage added server-side and not
    // client-side is dropped by parseProgressEvent, silently reverting
    // the UI to its fallback.
    for (const stage of SERVER_STAGES) {
      expect(parseProgressEvent({ stage })).toEqual({ stage });
    }
  });
});
