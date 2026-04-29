import { describe, expect, it } from "vitest";

import type {
  AssetRef,
  ValidationFlag,
  ValidationStatus,
} from "../../types/crm.ts";

import { exportGateState } from "./exportGate.ts";

function flag(
  partial: Partial<ValidationFlag> & { id: string },
): ValidationFlag {
  return {
    asset_id: "asset",
    bullet_id: "b",
    claim_id: "c",
    status: "untraceable",
    rationale: "no supporting Unit",
    created_at: "2026-04-01T00:00:00.000Z",
    ...partial,
  };
}

function asset(
  status: ValidationStatus,
  flags: readonly ValidationFlag[] = [],
): AssetRef {
  return {
    id: "asset",
    owner_uid: "u",
    application_id: "app",
    kind: "resume",
    format: "json",
    storage_path: "",
    validation_status: status,
    validation_flags: [...flags],
    created_at: "2026-04-01T00:00:00.000Z",
  };
}

describe("exportGateState", () => {
  it("disables with the empty-asset message when no asset exists", () => {
    const state = exportGateState(null);
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("No generated resume");
  });

  it("enables iff validation_status === 'passed'", () => {
    expect(exportGateState(asset("passed")).enabled).toBe(true);
    expect(exportGateState(asset("pending")).enabled).toBe(false);
    expect(exportGateState(asset("stale")).enabled).toBe(false);
    expect(exportGateState(asset("failed")).enabled).toBe(false);
  });

  it("explains the pending state without a flag count", () => {
    const state = exportGateState(asset("pending"));
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("Validation hasn't run");
  });

  it("explains the stale state and prompts re-validation", () => {
    const state = exportGateState(asset("stale"));
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("edited");
    expect(state.disabledReason).toContain("Re-run validation");
  });

  it("counts unresolved flags (untraceable + specificity) when failed, ignoring traced", () => {
    const state = exportGateState(
      asset("failed", [
        flag({ id: "1", status: "untraceable" }),
        flag({ id: "2", status: "specificity" }),
        flag({ id: "3", status: "traced" }),
      ]),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("Resolve 2 validation flags");
  });

  it("uses singular 'flag' when exactly one unresolved flag", () => {
    const state = exportGateState(
      asset("failed", [flag({ id: "1", status: "untraceable" })]),
    );
    expect(state.disabledReason).toContain("Resolve 1 validation flag ");
    expect(state.disabledReason).not.toContain("flags");
  });

  it("uses plural 'flags' when zero or many unresolved", () => {
    // Theoretically failed-with-zero-unresolved shouldn't happen
    // (validate.ts's computeStatus would return "passed"), but the
    // gate should still produce coherent copy if the data ever
    // drifts.
    const zero = exportGateState(asset("failed", []));
    expect(zero.disabledReason).toContain("Resolve 0 validation flags");
    const many = exportGateState(
      asset("failed", [
        flag({ id: "1" }),
        flag({ id: "2" }),
        flag({ id: "3" }),
      ]),
    );
    expect(many.disabledReason).toContain("Resolve 3 validation flags");
  });

  it("treats undefined validation_flags as zero unresolved", () => {
    // Pre-validation legacy assets may have validation_status="failed"
    // somehow with validation_flags undefined; defend against it.
    const a: AssetRef = { ...asset("failed"), validation_flags: undefined };
    const state = exportGateState(a);
    expect(state.disabledReason).toContain("Resolve 0 validation flags");
  });
});
