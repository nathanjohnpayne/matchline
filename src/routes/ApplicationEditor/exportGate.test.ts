import { describe, expect, it } from "vitest";

import type { ExperienceUnit } from "../../types/capability.ts";
import type {
  AssetRef,
  ValidationFlag,
  ValidationStatus,
} from "../../types/crm.ts";

import { unitEvidenceVersion } from "../../../functions/src/validation/unitEvidenceVersion.ts";

import {
  assetContentVersion,
  type ValidationAttestation,
} from "../../../functions/src/validation/attestation.ts";

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

  it("never enables for pending, stale or failed", () => {
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

  it("offers re-validation for pending, stale and failed while keeping export blocked", () => {
    for (const status of ["pending", "stale", "failed"] as const) {
      const state = exportGateState(asset(status));
      expect(state.enabled, status).toBe(false);
      expect(state.enabled === false && state.canRevalidate, status).toBe(true);
    }
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

// -- `passed` requires a server attestation for the current content (#502) --

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

/**
 * What `validateAsset` records for `a`'s content: by default a pass,
 * with each of u1..u3 at the version `unit()` builds.
 */
function attest(
  a: AssetRef,
  overrides: Partial<ValidationAttestation> = {},
): ValidationAttestation {
  return {
    owner_uid: "u",
    application_id: "app",
    asset_id: a.id,
    content_version: assetContentVersion(a.generated_content),
    status: "passed",
    validated_at: VALIDATED_AT,
    validated_unit_versions: {
      u1: unitEvidenceVersion(unit("u1")),
      u2: unitEvidenceVersion(unit("u2")),
      u3: unitEvidenceVersion(unit("u3")),
    },
    ...overrides,
  };
}

const byId = (...units: ExperienceUnit[]) =>
  new Map(units.map((u) => [u.id, u]));

const ALL = () => byId(unit("u1"), unit("u2"), unit("u3"));

describe("exportGateState: server attestation", () => {
  it("enables a passed asset the server attested for its current content", () => {
    const a = passedAsset();
    expect(exportGateState(a, ALL(), attest(a))).toEqual({ enabled: true, disabledReason: null });
  });

  it("waits, without offering a re-run, while the attestation is still loading", () => {
    const state = exportGateState(passedAsset(), ALL(), undefined);
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("Checking");
    expect(state.enabled === false && state.canRevalidate === true).toBe(false);
  });

  it("blocks a client-written `passed` the server never attested, and offers a re-run", () => {
    // The #502 attack: the asset's status sits in a client-writable
    // list, so it can say `passed` for content no validator saw.
    const state = exportGateState(passedAsset(), ALL(), null);
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("couldn't be confirmed");
    expect(state.enabled === false && state.canRevalidate).toBe(true);
  });

  it("blocks when the attestation is for other content (an edit after validation)", () => {
    const validated = passedAsset();
    const edited = passedAsset({
      generated_content: {
        ...validated.generated_content!,
        bullets: [{ id: "b1", text: "Led ten teams.", source_unit_ids: ["u2"] }],
      },
    });
    expect(exportGateState(edited, ALL(), attest(validated)).enabled).toBe(false);
  });

  it("blocks when the server's verdict for this content is a failure", () => {
    const a = passedAsset();
    expect(exportGateState(a, ALL(), attest(a, { status: "failed" })).enabled).toBe(false);
  });

  it("blocks an attestation for a different asset", () => {
    const a = passedAsset();
    expect(exportGateState(a, ALL(), attest(a, { asset_id: "other" })).enabled).toBe(false);
  });

  it("keeps the status-based copy for pending, stale and failed whatever the attestation says", () => {
    const a = passedAsset();
    const stale = exportGateState({ ...a, validation_status: "stale" }, ALL(), attest(a));
    expect(stale.disabledReason).toContain("Resume edited since the last validation run");
  });
});

// -- `passed` re-checked against the cited Units --------------------------

describe("exportGateState: cited-evidence re-check", () => {
  const gate = (a: AssetRef, units: ReadonlyMap<string, ExperienceUnit>) =>
    exportGateState(a, units, attest(a));

  it("collects cited ids across summary, bullets, skills and education", () => {
    expect([...citedUnitIds(passedAsset())].sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("stays enabled when every cited Unit is approved and at the validated version", () => {
    expect(gate(passedAsset(), ALL())).toEqual({ enabled: true, disabledReason: null });
  });

  it("blocks when a cited Unit was rejected after validation", () => {
    const state = gate(
      passedAsset(),
      byId(unit("u1"), unit("u2", { user_approved: false, rejected: true }), unit("u3")),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("1 Unit that is no longer approved");
  });

  it("blocks when a cited Unit is flagged or pending (anything but approved)", () => {
    expect(
      gate(passedAsset(), byId(unit("u1", { user_approved: false, flagged: true }), unit("u2"), unit("u3")))
        .enabled,
    ).toBe(false);
    expect(
      gate(passedAsset(), byId(unit("u1"), unit("u2"), unit("u3", { user_approved: false }))).enabled,
    ).toBe(false);
  });

  it("blocks when a cited Unit no longer exists", () => {
    const state = gate(passedAsset(), byId(unit("u1"), unit("u2")));
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("1 Unit that no longer exists");
  });

  it("offers re-validation only when re-running validation is the fix", () => {
    const edited = gate(passedAsset(), byId(unit("u1"), unit("u2", { raw_text: "Led two teams." }), unit("u3")));
    expect(edited.enabled === false && edited.canRevalidate).toBe(true);

    const unapproved = gate(passedAsset(), byId(unit("u1"), unit("u2", { user_approved: false }), unit("u3")));
    expect(unapproved.enabled === false && unapproved.canRevalidate).toBe(false);

    const missing = gate(passedAsset(), byId(unit("u1"), unit("u3")));
    expect(missing.enabled === false && missing.canRevalidate).toBe(false);
  });

  it("stays enabled when only fields the validator ignores change, timestamp included", () => {
    const state = gate(
      passedAsset(),
      byId(unit("u1"), unit("u2", { updated_at: "2026-05-01T00:00:00.000Z", skills: ["go"] }), unit("u3")),
    );
    expect(state.enabled).toBe(true);
  });

  it("blocks an edit made DURING validation, which a timestamp comparison misses", () => {
    // The validator read u2, the user edited it at 04-05, and the
    // verdict was stamped at 04-10 (validated_at). updated_at <
    // validated_at, so only the recorded version catches it.
    const state = gate(
      passedAsset(),
      byId(
        unit("u1"),
        unit("u2", { raw_text: "Led two teams.", updated_at: "2026-04-05T00:00:00.000Z" }),
        unit("u3"),
      ),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("1 Unit this resume cites has changed");
  });

  it("blocks changed evidence written under the validated updated_at", () => {
    // `upsertExperienceUnit` writes the caller's timestamp verbatim,
    // so evidence can change without updated_at moving (#501 review).
    const state = gate(
      passedAsset(),
      byId(
        unit("u1"),
        unit("u2", { metrics: [{ claim: "Grew revenue", value: 40, unit: "%", confidence: "high" }] }),
        unit("u3"),
      ),
    );
    expect(state.enabled).toBe(false);
    expect(state.disabledReason).toContain("changed since the last validation run");
  });

  it("blocks a cited Unit the validator never loaded", () => {
    const a = passedAsset();
    const state = exportGateState(
      a,
      ALL(),
      attest(a, {
        validated_unit_versions: {
          u1: unitEvidenceVersion(unit("u1")),
          u2: unitEvidenceVersion(unit("u2")),
        },
      }),
    );
    expect(state.enabled).toBe(false);
  });

  it("names the most severe problem and pluralizes", () => {
    const state = gate(
      passedAsset(),
      byId(unit("u1", { user_approved: false }), unit("u2", { user_approved: false })),
    );
    // u3 missing outranks u1/u2 unapproved.
    expect(state.disabledReason).toContain("1 Unit that no longer exists");
    const two = gate(
      passedAsset(),
      byId(unit("u1", { user_approved: false }), unit("u2", { user_approved: false }), unit("u3")),
    );
    expect(two.disabledReason).toContain("2 Units that are no longer approved");
  });

  it("ignores Units that are loaded but not cited", () => {
    const state = gate(
      passedAsset(),
      byId(unit("u1"), unit("u2"), unit("u3"), unit("u9", { user_approved: false, rejected: true })),
    );
    expect(state.enabled).toBe(true);
  });

  it("leaves non-passed states' copy unchanged when Units are supplied", () => {
    const a = { ...passedAsset(), validation_status: "stale" as const };
    const state = exportGateState(a, byId(unit("u1", { user_approved: false })), attest(a));
    expect(state.disabledReason).toContain("Resume edited since the last validation run");
  });

  it("checks only the attestation when no Units are supplied", () => {
    const a = passedAsset();
    expect(exportGateState(a, undefined, attest(a)).enabled).toBe(true);
    expect(exportGateState(a, undefined, null).enabled).toBe(false);
  });
});
