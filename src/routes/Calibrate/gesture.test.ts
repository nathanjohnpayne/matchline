import { describe, expect, it } from "vitest";

import { DIRECTION_FOR, LABEL_FOR, SWIPE_PX, dragTransform, exitTransform, stamp, swipeDirection } from "./gesture.ts";

describe("swipe geometry", () => {
  it("swipes only past the threshold, along the dominant axis", () => {
    expect(swipeDirection(SWIPE_PX, 0)).toBeNull();
    expect(swipeDirection(SWIPE_PX + 1, 40)).toBe("right");
    expect(swipeDirection(-150, 90)).toBe("left");
    expect(swipeDirection(30, 140)).toBe("down");
    expect(swipeDirection(-60, -101)).toBe("up");
  });

  it("maps directions to labels and back", () => {
    expect(LABEL_FOR).toEqual({ right: "true", left: "false", down: "mixed", up: "unsure" });
    for (const [dir, label] of Object.entries(LABEL_FOR)) expect(DIRECTION_FOR[label]).toBe(dir);
  });

  it("fades the stamp in with travel and caps it at full strength", () => {
    expect(stamp(15, 0)).toBeNull();
    expect(stamp(50, 10)).toEqual({ direction: "right", strength: 0.5 });
    expect(stamp(0, -300)).toEqual({ direction: "up", strength: 1 });
  });

  it("tilts with horizontal travel and flies off the way it was swiped", () => {
    expect(dragTransform(40, -10)).toBe("translate(40px, -10px) rotate(2deg)");
    expect(exitTransform("left")).toContain("-140%");
    expect(exitTransform("down")).toBe("translate(0, 120%)");
  });
});
