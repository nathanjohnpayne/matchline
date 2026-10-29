/**
 * Swipe geometry for the Calibrate card, kept pure so the thresholds are
 * testable without a pointer. The numbers follow swipewatch's mechanics:
 * a press becomes a drag after 10 px of travel, and a drag becomes a swipe
 * past 100 px along its dominant axis.
 */

import type { Label } from "../../lib/labelDeck/deck.ts";

export const DRAG_START_PX = 10;
export const SWIPE_PX = 100;
/** Travel before the stamp for a direction starts to show. */
const STAMP_START_PX = 20;

export type Direction = "right" | "left" | "down" | "up";

export const LABEL_FOR: Record<Direction, Label> = { right: "true", left: "false", down: "mixed", up: "unsure" };
export const DIRECTION_FOR: Record<Label, Direction> = { true: "right", false: "left", mixed: "down", unsure: "up" };

const dominant = (dx: number, dy: number): Direction =>
  Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";

/** The swipe a released drag makes, or null to snap back. */
export function swipeDirection(dx: number, dy: number): Direction | null {
  return Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_PX ? dominant(dx, dy) : null;
}

/** Which stamp a drag in progress shows, and how strongly (0–1). */
export function stamp(dx: number, dy: number): { direction: Direction; strength: number } | null {
  const travel = Math.max(Math.abs(dx), Math.abs(dy));
  if (travel <= STAMP_START_PX) return null;
  return { direction: dominant(dx, dy), strength: Math.min(1, travel / SWIPE_PX) };
}

/** Card transform while dragging: follow the pointer, tilt with horizontal travel. */
export const dragTransform = (dx: number, dy: number): string => `translate(${dx}px, ${dy}px) rotate(${dx * 0.05}deg)`;

/** Where a card flies to when it leaves in `direction`. */
export function exitTransform(direction: Direction): string {
  switch (direction) {
    case "right":
      return "translate(140%, 0) rotate(18deg)";
    case "left":
      return "translate(-140%, 0) rotate(-18deg)";
    case "down":
      return "translate(0, 120%)";
    case "up":
      return "translate(0, -120%)";
  }
}
