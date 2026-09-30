import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  AssetRef,
  ValidationFlag,
  ValidationStatus,
} from "../../types/crm.ts";

import { citedUnitIds, exportGateState } from "./exportGate.ts";

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

  it("offers re-validation for pending and stale, not for failed", () => {
    const pending = exportGateState(asset("pending"));
    const stale = exportGateState(asset("stale"));
    const failed = exportGateState(asset("failed"));
    expect(pending.enabled === false && pending.canRevalidate).toBe(true);
    expect(stale.enabled === false && stale.canRevalidate).toBe(true);
    expect(failed.enabled === false && failed.canRevalidate === true).toBe(false);
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

// -- `passed` re-checked against the cited Units --------------------------

describe("exportGateState: cited-evidence re-check", () => {
  const VALIDATED_AT = "2026-04-10T00:00:00.000Z";

  function unit(
    id: string,
    partial: Partial<ExperienceUnit> = {},
  ): ExperienceUnit {
    return {
      id,
      owner_uid: "u",
      source_type: "resume",
      source_ref: "ref",
      raw_text: "Led a team.",
      normalized_summary: "Led a team.",
      unit_type: "achievement",
      skills: [],
      tools: [],
      domains: [],
      seniority_signals: [],
      scope_signals: [],
      business_outcomes: [],
      metrics: [],
      evidence_type: "verified",
      confidence_score: 1,
      user_approved: true,
      rejected: false,
      flagged: false,
      created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z",
      ...partial,
    };
  }

  /** A passed asset whose summary cites u1 and whose bullets cite u2 + u3. */
  function passedAsset(partial: Partial<AssetRef> = {}): AssetRef {
    return {
      ...asset("passed"),
      validated_at: VALIDATED_AT,
      generated_content: {
        summary: { id: "s", text: "Summary.", source_unit_ids: ["u1"] },
        bullets: [
          { id: "b1", text: "Led a team.", source_unit_ids: ["u2"] },
          { id: "b2", text: "Shipped it.", source_unit_ids: ["u2", "u3"] },
        ],
        skills: [],
        education: [{ id: "e1", text: "BSc.", source_unit_ids: [] }],
      },
      ...partial,
    };
  }

  const byId = (...units: ExperienceUnit[]) =>
    new Map(units.map((u) => [u.id, u]));

  it("collects cited ids across summary, bullets, skills and education", () => {
    expect([...citedUnitIds(passedAsset())].sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("stays enabled when every cited Unit is approved and unchanged since validation", () => {
    const state = exportGateState(passedAsset(), byId(unit("u1"), unit("u2"), unit("u3")));
    expect(state).toEqual({ enabled: true, disabledReason: null });
  });

  it("blocks when a cited Unit was rejected after validation", () => {
    const state = exportGateState(
      passedAsset(),
      byId(
        unit("u1"),
        unit("u2", { user_approved: false, rejected: true }),
        unit("u3"),
      ),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("1 Unit that is no longer approved");
  });

  it("blocks when a cited Unit is flagged or pending (anything but approved)", () => {
    const flagged = exportGateState(
      passedAsset(),
      byId(unit("u1", { user_approved: false, flagged: true }), unit("u2"), unit("u3")),
    );
    expect(flagged.enabled).toBe(false);
    const pending = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2"), unit("u3", { user_approved: false })),
    );
    expect(pending.enabled).toBe(false);
  });

  it("blocks when a cited Unit no longer exists", () => {
    const state = exportGateState(passedAsset(), byId(unit("u1"), unit("u2")));
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("1 Unit that no longer exists");
  });

  it("offers re-validation only when re-running validation is the fix", () => {
    const edited = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2", { updated_at: "2026-04-11T00:00:00.000Z" }), unit("u3")),
    );
    expect(edited.enabled === false && edited.canRevalidate).toBe(true);

    const unapproved = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2", { user_approved: false }), unit("u3")),
    );
    expect(unapproved.enabled === false && unapproved.canRevalidate).toBe(false);

    const missing = exportGateState(passedAsset(), byId(unit("u1"), unit("u3")));
    expect(missing.enabled === false && missing.canRevalidate).toBe(false);
  });

  it("blocks when a cited Unit was edited after validated_at", () => {
    const state = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2", { updated_at: "2026-04-11T00:00:00.000Z" }), unit("u3")),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("changed since the last validation run");
  });

  describe("with validated_unit_versions (current validator output)", () => {
    const versioned = (versions: Record<string, string>) =>
      passedAsset({ validated_unit_versions: versions });
    const V = "2026-04-01T00:00:00.000Z";

    it("stays enabled when every cited Unit is at the validated version", () => {
      const state = exportGateState(
        versioned({ u1: V, u2: V, u3: V }),
        byId(unit("u1"), unit("u2"), unit("u3")),
      );
      expect(state.enabled).toBe(true);
    });

    it("blocks an edit made DURING validation, which a timestamp comparison misses", () => {
      // The validator read u2 at version V, the user edited it at
      // 04-05, and the verdict was stamped at 04-10 (validated_at).
      // updated_at < validated_at, so only the version catches it.
      const state = exportGateState(
        versioned({ u1: V, u2: V, u3: V }),
        byId(unit("u1"), unit("u2", { updated_at: "2026-04-05T00:00:00.000Z" }), unit("u3")),
      );
      expect(state.enabled).toBe(false);
      expect(state.disabledReason).toContain("1 Unit this resume cites has changed");
    });

    it("is immune to a client clock that runs behind the server", () => {
      // An edit after validation, stamped by a slow client clock with
      // a time EARLIER than validated_at, still changes the version.
      const state = exportGateState(
        versioned({ u1: V, u2: V, u3: V }),
        byId(unit("u1"), unit("u2", { updated_at: "2026-03-01T00:00:00.000Z" }), unit("u3")),
      );
      expect(state.enabled).toBe(false);
    });

    it("blocks a cited Unit the validator never loaded", () => {
      const state = exportGateState(
        versioned({ u1: V, u2: V }),
        byId(unit("u1"), unit("u2"), unit("u3")),
      );
      expect(state.enabled).toBe(false);
    });
  });

  it("does not block on an edit that predates validation", () => {
    const state = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2", { updated_at: "2026-04-09T23:59:59.000Z" }), unit("u3")),
    );
    expect(state.enabled).toBe(true);
  });

  it("names the most severe problem and pluralizes", () => {
    const state = exportGateState(
      passedAsset(),
      byId(unit("u1", { user_approved: false }), unit("u2", { user_approved: false })),
    );
    // u3 missing outranks u1/u2 unapproved.
    expect(state.disabledReason).toContain("1 Unit that no longer exists");
    const two = exportGateState(
      passedAsset(),
      byId(unit("u1", { user_approved: false }), unit("u2", { user_approved: false }), unit("u3")),
    );
    expect(two.disabledReason).toContain("2 Units that are no longer approved");
  });

  it("ignores Units that are loaded but not cited", () => {
    const state = exportGateState(
      passedAsset(),
      byId(unit("u1"), unit("u2"), unit("u3"), unit("u9", { user_approved: false, rejected: true })),
    );
    expect(state.enabled).toBe(true);
  });

  it("skips the edit check for a legacy asset with no validated_at, but not the approval check", () => {
    const legacy = passedAsset({ validated_at: undefined });
    expect(
      exportGateState(
        legacy,
        byId(unit("u1"), unit("u2", { updated_at: "2030-01-01T00:00:00.000Z" }), unit("u3")),
      ).enabled,
    ).toBe(true);
    expect(
      exportGateState(legacy, byId(unit("u1"), unit("u2", { user_approved: false }), unit("u3")))
        .enabled,
    ).toBe(false);
  });

  it("leaves non-passed states' copy unchanged when Units are supplied", () => {
    const state = exportGateState(
      { ...passedAsset(), validation_status: "stale" },
      byId(unit("u1", { user_approved: false })),
    );
    expect(state.disabledReason).toContain("Resume edited since the last validation run");
  });

  it("keeps the status-only behavior when no Units are supplied", () => {
    expect(exportGateState(passedAsset()).enabled).toBe(true);
  });
});
