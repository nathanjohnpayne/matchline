/**
 * Unit tests for the busy store (#429).
 *
 * The keyed design exists because two surfaces can be busy at once — a
 * JD parse on one Role while an extraction runs elsewhere. A boolean
 * would let whichever finished first clear the other's suppression.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  _resetAppBusyForTests,
  isAppBusy,
  setAppBusy,
  subscribeAppBusy,
} from "./appBusy.ts";

beforeEach(() => _resetAppBusyForTests());

describe("appBusy", () => {
  it("starts idle", () => {
    expect(isAppBusy()).toBe(false);
  });

  it("reports busy while a key is set, idle once cleared", () => {
    setAppBusy("a", true);
    expect(isAppBusy()).toBe(true);
    setAppBusy("a", false);
    expect(isAppBusy()).toBe(false);
  });

  it("stays busy until EVERY key clears", () => {
    // The reason the store is keyed rather than a boolean.
    setAppBusy("extract", true);
    setAppBusy("parse", true);
    setAppBusy("parse", false);
    expect(isAppBusy()).toBe(true);
    setAppBusy("extract", false);
    expect(isAppBusy()).toBe(false);
  });

  it("is idempotent for repeated set and clear", () => {
    // React effects can re-run; a counter would drift.
    setAppBusy("a", true);
    setAppBusy("a", true);
    setAppBusy("a", false);
    expect(isAppBusy()).toBe(false);
    setAppBusy("a", false);
    expect(isAppBusy()).toBe(false);
  });

  it("notifies subscribers only on aggregate change", () => {
    const seen = vi.fn();
    subscribeAppBusy(seen);
    setAppBusy("a", true);
    setAppBusy("b", true); // already busy — no churn
    setAppBusy("b", false); // still busy — no churn
    setAppBusy("a", false);
    expect(seen.mock.calls.map(([v]) => v)).toEqual([true, false]);
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeAppBusy(seen);
    off();
    setAppBusy("a", true);
    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps notifying other subscribers when one throws", () => {
    const good = vi.fn();
    subscribeAppBusy(() => {
      throw new Error("bad subscriber");
    });
    subscribeAppBusy(good);
    expect(() => setAppBusy("a", true)).not.toThrow();
    expect(good).toHaveBeenCalledWith(true);
  });
});
