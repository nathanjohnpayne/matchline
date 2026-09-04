/**
 * Unit tests for the busy store (#429).
 *
 * The lease design exists because a caller-supplied string key had a
 * race Codex found on PR #434: an operation that survives navigation,
 * followed by a second operation with the same key, meant the first
 * one settling released the only entry while the second was still
 * running — exposing the reload prompt during a live call.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  _resetAppBusyForTests,
  beginAppBusy,
  isAppBusy,
  subscribeAppBusy,
  beginUnsavedWork,
  hasUnsavedWork,
  subscribeUnsavedWork,
} from "./appBusy.ts";

beforeEach(() => _resetAppBusyForTests());

describe("appBusy", () => {
  it("starts idle", () => {
    expect(isAppBusy()).toBe(false);
  });

  it("is busy while a lease is held, idle once released", () => {
    const release = beginAppBusy("extract");
    expect(isAppBusy()).toBe(true);
    release();
    expect(isAppBusy()).toBe(false);
  });

  it("stays busy until EVERY lease is released", () => {
    const a = beginAppBusy("extract");
    const b = beginAppBusy("parse");
    b();
    expect(isAppBusy()).toBe(true);
    a();
    expect(isAppBusy()).toBe(false);
  });

  it("keeps concurrent same-label operations independent", () => {
    // The exact race Codex found: two extractions with the same label,
    // the first settling while the second is still in flight. With a
    // shared string key the first release cleared the only entry and
    // un-suppressed the banner mid-call.
    const first = beginAppBusy("onboarding.extract");
    const second = beginAppBusy("onboarding.extract");
    first();
    expect(isAppBusy()).toBe(true);
    second();
    expect(isAppBusy()).toBe(false);
  });

  it("makes release idempotent", () => {
    // Effects and finally blocks can both run; a second call must not
    // release someone else's lease.
    const a = beginAppBusy("extract");
    const b = beginAppBusy("parse");
    a();
    a();
    a();
    expect(isAppBusy()).toBe(true);
    b();
    expect(isAppBusy()).toBe(false);
  });

  it("notifies subscribers only on aggregate change", () => {
    const seen = vi.fn();
    subscribeAppBusy(seen);
    const a = beginAppBusy("a");
    const b = beginAppBusy("b"); // already busy — no churn
    b(); // still busy — no churn
    a();
    expect(seen.mock.calls.map(([v]) => v)).toEqual([true, false]);
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeAppBusy(seen);
    off();
    beginAppBusy("a");
    expect(seen).not.toHaveBeenCalled();
  });

  it("keeps notifying other subscribers when one throws", () => {
    const good = vi.fn();
    subscribeAppBusy(() => {
      throw new Error("bad subscriber");
    });
    subscribeAppBusy(good);
    expect(() => beginAppBusy("a")).not.toThrow();
    expect(good).toHaveBeenCalledWith(true);
  });

  it("releases in any order", () => {
    const a = beginAppBusy("a");
    const b = beginAppBusy("b");
    const c = beginAppBusy("c");
    b();
    c();
    expect(isAppBusy()).toBe(true);
    a();
    expect(isAppBusy()).toBe(false);
  });
});

describe("unsavedWork", () => {
  it("starts clean", () => {
    expect(hasUnsavedWork()).toBe(false);
  });

  it("tracks a dirty editor until released", () => {
    const release = beginUnsavedWork("onboarding.resumeDraft");
    expect(hasUnsavedWork()).toBe(true);
    release();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("keeps two dirty editors independent", () => {
    const a = beginUnsavedWork("onboarding.resumeDraft");
    const b = beginUnsavedWork("roleDetail.jdDraft");
    a();
    expect(hasUnsavedWork()).toBe(true);
    b();
    expect(hasUnsavedWork()).toBe(false);
  });

  it("is a separate signal from busy", () => {
    // The two mean different things to the reload prompt: busy
    // suppresses it outright, dirty only gates it behind a confirm.
    const dirty = beginUnsavedWork("draft");
    expect(hasUnsavedWork()).toBe(true);
    expect(isAppBusy()).toBe(false);
    const busy = beginAppBusy("call");
    expect(isAppBusy()).toBe(true);
    dirty();
    expect(isAppBusy()).toBe(true);
    expect(hasUnsavedWork()).toBe(false);
    busy();
  });

  it("notifies subscribers only on aggregate change", () => {
    const seen = vi.fn();
    subscribeUnsavedWork(seen);
    const a = beginUnsavedWork("a");
    const b = beginUnsavedWork("b");
    b();
    a();
    expect(seen.mock.calls.map(([v]) => v)).toEqual([true, false]);
  });

  it("has an idempotent release", () => {
    const a = beginUnsavedWork("a");
    const b = beginUnsavedWork("b");
    a();
    a();
    expect(hasUnsavedWork()).toBe(true);
    b();
    expect(hasUnsavedWork()).toBe(false);
  });
});
