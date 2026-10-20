import { describe, expect, it } from "vitest";

import type { Application, ApplicationStage } from "../../types/crm.ts";

import {
  EMPTY_MOVE_STATE,
  isNoopMove,
  neighborStage,
  pipelineMoveReducer,
  type PipelineMoveState,
} from "./pipelineMoves.ts";

function app(id: string, stage: ApplicationStage): Application {
  return {
    id,
    owner_uid: "u",
    role_id: `role-${id}`,
    stage,
    last_activity_at: "2026-10-01T00:00:00.000Z",
    generated_assets: [],
    approved_unit_ids: [],
  };
}

const AT = "2026-10-20T02:00:00.000Z";

function loaded(...apps: Application[]): PipelineMoveState {
  return pipelineMoveReducer(EMPTY_MOVE_STATE, { type: "loaded", applications: apps });
}

describe("neighborStage", () => {
  it("steps left and right through the board order", () => {
    expect(neighborStage("saved", 1)).toBe("drafting");
    expect(neighborStage("applied", -1)).toBe("drafting");
    expect(neighborStage("offer", 1)).toBe("rejected");
  });

  it("returns null at either end", () => {
    expect(neighborStage("saved", -1)).toBeNull();
    expect(neighborStage("withdrawn", 1)).toBeNull();
  });

  it("returns null for an unknown stage", () => {
    expect(neighborStage("ghosted" as ApplicationStage, 1)).toBeNull();
  });
});

describe("pipelineMoveReducer", () => {
  it("applies a move at once: new stage, new last_activity_at, pending", () => {
    const next = pipelineMoveReducer(loaded(app("a1", "saved")), {
      type: "move",
      id: "a1",
      stage: "applied",
      at: AT,
    });
    expect(next.applications[0]).toMatchObject({ stage: "applied", last_activity_at: AT });
    expect(next.pending.get("a1")?.stage).toBe("saved");
  });

  it("confirm keeps the move and clears pending", () => {
    const moved = pipelineMoveReducer(loaded(app("a1", "saved")), {
      type: "move",
      id: "a1",
      stage: "applied",
      at: AT,
    });
    const next = pipelineMoveReducer(moved, { type: "confirm", id: "a1" });
    expect(next.applications[0]?.stage).toBe("applied");
    expect(next.pending.size).toBe(0);
  });

  it("fail restores the exact pre-move Application and clears pending", () => {
    const original = app("a1", "saved");
    const moved = pipelineMoveReducer(loaded(original, app("a2", "offer")), {
      type: "move",
      id: "a1",
      stage: "applied",
      at: AT,
    });
    const next = pipelineMoveReducer(moved, { type: "fail", id: "a1" });
    expect(next.applications[0]).toEqual(original);
    expect(next.applications[1]?.stage).toBe("offer");
    expect(next.pending.size).toBe(0);
  });

  it("treats a move to the card's own column as a no-op", () => {
    const state = loaded(app("a1", "saved"));
    expect(isNoopMove(state, "a1", "saved")).toBe(true);
    expect(
      pipelineMoveReducer(state, { type: "move", id: "a1", stage: "saved", at: AT }),
    ).toBe(state);
  });

  it("ignores an unknown Application", () => {
    const state = loaded(app("a1", "saved"));
    expect(isNoopMove(state, "nope", "applied")).toBe(true);
    expect(
      pipelineMoveReducer(state, { type: "move", id: "nope", stage: "applied", at: AT }),
    ).toBe(state);
  });

  it("refuses a second move while the first is in flight", () => {
    const moved = pipelineMoveReducer(loaded(app("a1", "saved")), {
      type: "move",
      id: "a1",
      stage: "applied",
      at: AT,
    });
    expect(isNoopMove(moved, "a1", "offer")).toBe(true);
    expect(
      pipelineMoveReducer(moved, { type: "move", id: "a1", stage: "offer", at: AT }),
    ).toBe(moved);
  });

  it("ignores confirm and fail for a card with nothing in flight", () => {
    const state = loaded(app("a1", "saved"));
    expect(pipelineMoveReducer(state, { type: "confirm", id: "a1" })).toBe(state);
    expect(pipelineMoveReducer(state, { type: "fail", id: "a1" })).toBe(state);
  });

  it("a fresh load replaces applications and drops pending moves", () => {
    const moved = pipelineMoveReducer(loaded(app("a1", "saved")), {
      type: "move",
      id: "a1",
      stage: "applied",
      at: AT,
    });
    const next = pipelineMoveReducer(moved, {
      type: "loaded",
      applications: [app("a9", "offer")],
    });
    expect(next.applications.map((a) => a.id)).toEqual(["a9"]);
    expect(next.pending.size).toBe(0);
  });

  it("touched updates last_activity_at only", () => {
    const state = loaded(app("a1", "applied"));
    const touched = pipelineMoveReducer(state, { type: "touched", id: "a1", at: AT });
    expect(touched.applications[0]).toMatchObject({ stage: "applied", last_activity_at: AT });
    expect(pipelineMoveReducer(state, { type: "touched", id: "nope", at: AT })).toBe(state);
  });

  it("a touch during a pending move survives that move's rollback", () => {
    const state = loaded(app("a1", "applied"));
    const moving = pipelineMoveReducer(state, {
      type: "move",
      id: "a1",
      stage: "offer",
      at: "2026-10-20T02:00:00.000Z",
    });
    const completedAt = "2026-10-20T03:00:00.000Z";
    const touched = pipelineMoveReducer(moving, { type: "touched", id: "a1", at: completedAt });
    expect(touched.applications[0]).toMatchObject({ stage: "offer", last_activity_at: completedAt });

    const rolledBack = pipelineMoveReducer(touched, { type: "fail", id: "a1" });
    expect(rolledBack.applications[0]).toMatchObject({
      stage: "applied",
      last_activity_at: completedAt,
    });
  });

  it("never moves last_activity_at backwards", () => {
    const state = loaded(app("a1", "applied"));
    const newer = pipelineMoveReducer(state, { type: "touched", id: "a1", at: AT });
    const older = pipelineMoveReducer(newer, {
      type: "touched",
      id: "a1",
      at: "2026-09-01T00:00:00.000Z",
    });
    expect(older.applications[0]?.last_activity_at).toBe(AT);
  });
});
