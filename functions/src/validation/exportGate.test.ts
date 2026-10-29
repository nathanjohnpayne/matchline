/**
 * Tests for the shared export gate (#521): the server re-check the
 * `exportAsset` callable runs, and the counting the editor's gate uses.
 * The editor-side copy and precedence stay pinned by
 * `src/routes/ApplicationEditor/exportGate.test.ts`.
 */

import { describe, expect, it } from "vitest";

import type { GeneratedAssetContent } from "../types/crm.ts";
import { assetContentVersion, type ValidationAttestation } from "./attestation.ts";
import {
  attestationRefusal,
  checkExportGate,
  citedEvidenceCounts,
  citedUnitIdsOf,
  evidenceRefusal,
  isOlderEvidenceVersion,
  type GateUnit,
} from "./exportGate.ts";
import { unitEvidenceVersion } from "./unitEvidenceVersion.ts";

const ALICE = "user-alice";
const APP = "app-1";
const ASSET = "asset-1";

const CONTENT: GeneratedAssetContent = {
  summary: { id: "s", text: "Product leader.", source_unit_ids: ["u1"] },
  bullets: [
    { id: "b1", text: "Shipped the thing.", source_unit_ids: ["u1", "u2"] },
    { id: "b2", text: "Grew the other thing.", source_unit_ids: ["u2"] },
  ],
  skills: [{ id: "k1", text: "Roadmapping", source_unit_ids: ["u3"] }],
  education: [{ id: "e1", text: "BA, Somewhere", source_unit_ids: [] }],
};

function unit(id: string, overrides: Partial<GateUnit> = {}): GateUnit {
  return { id, raw_text: `raw ${id}`, normalized_summary: `summary ${id}`, user_approved: true, ...overrides };
}

const UNITS = new Map<string, GateUnit>(["u1", "u2", "u3"].map((id) => [id, unit(id)]));

function versionsOf(units: ReadonlyMap<string, GateUnit>): Record<string, string> {
  return Object.fromEntries([...units].map(([id, u]) => [id, unitEvidenceVersion(u)]));
}

function attestation(overrides: Partial<ValidationAttestation> = {}, content: unknown = CONTENT): ValidationAttestation {
  return {
    owner_uid: ALICE,
    application_id: APP,
    asset_id: ASSET,
    content_version: assetContentVersion(content),
    status: "passed",
    validated_at: "2026-10-29T00:00:00.000Z",
    validated_unit_versions: versionsOf(UNITS),
    ...overrides,
  };
}

const SCOPE = { assetId: ASSET, applicationId: APP, ownerUid: ALICE };

describe("checkExportGate", () => {
  it("passes a passed attestation for the current content with current evidence, returning that content", () => {
    const result = checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation(), unitsById: UNITS });
    expect(result).toEqual({ ok: true, content: CONTENT });
    if (result.ok) expect(result.content).toBe(CONTENT);
  });

  it("refuses malformed content before looking at the attestation", () => {
    for (const content of [null, {}, { ...CONTENT, bullets: [{ id: "b", text: 3, source_unit_ids: [] }] }]) {
      expect(checkExportGate({ scope: SCOPE, content, attestation: attestation(), unitsById: UNITS })).toEqual({
        ok: false,
        reason: "malformed-content",
      });
    }
  });

  it("refuses with no attestation", () => {
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: null, unitsById: UNITS })).toEqual({
      ok: false,
      reason: "no-attestation",
    });
  });

  it("refuses a failed attestation", () => {
    expect(
      checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation({ status: "failed" }), unitsById: UNITS }),
    ).toEqual({ ok: false, reason: "not-passed" });
  });

  it("refuses a stale pass recorded for earlier content", () => {
    const before = { ...CONTENT, bullets: [{ ...CONTENT.bullets[0], text: "Shipped a smaller thing." }, CONTENT.bullets[1]] };
    const stale = attestation({}, before);
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: stale, unitsById: UNITS })).toEqual({
      ok: false,
      reason: "attestation-mismatch",
    });
  });

  it.each([
    ["asset_id", { asset_id: "asset-2" }],
    ["application_id", { application_id: "app-2" }],
    ["owner_uid", { owner_uid: "user-bob" }],
  ] as const)("refuses an attestation for a different %s", (_field, overrides) => {
    expect(
      checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation(overrides), unitsById: UNITS }),
    ).toEqual({ ok: false, reason: "attestation-mismatch" });
  });

  it("keeps passing when items are only reordered within a section", () => {
    const reordered = { ...CONTENT, bullets: [CONTENT.bullets[1], CONTENT.bullets[0]] };
    expect(checkExportGate({ scope: SCOPE, content: reordered, attestation: attestation(), unitsById: UNITS }).ok).toBe(
      true,
    );
  });

  it("refuses edited item text, whose content version has no matching attestation", () => {
    const edited = { ...CONTENT, summary: { ...CONTENT.summary, text: "Product leader and more." } };
    expect(checkExportGate({ scope: SCOPE, content: edited, attestation: attestation(), unitsById: UNITS })).toEqual({
      ok: false,
      reason: "attestation-mismatch",
    });
  });

  it("refuses a missing cited Unit", () => {
    const units = new Map(UNITS);
    units.delete("u3");
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation(), unitsById: units })).toEqual({
      ok: false,
      reason: "evidence-missing",
    });
  });

  it("refuses an unapproved cited Unit", () => {
    const units = new Map(UNITS).set("u2", unit("u2", { user_approved: false }));
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation(), unitsById: units })).toEqual({
      ok: false,
      reason: "evidence-unapproved",
    });
  });

  it("refuses evidence recorded under an older format", () => {
    const att = attestation({ validated_unit_versions: { ...versionsOf(UNITS), u1: "ev2:abc" } });
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: att, unitsById: UNITS })).toEqual({
      ok: false,
      reason: "evidence-outdated",
    });
  });

  it("refuses a cited Unit edited since validation, or one with no recorded version", () => {
    const edited = new Map(UNITS).set("u1", unit("u1", { raw_text: "changed" }));
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: attestation(), unitsById: edited })).toEqual({
      ok: false,
      reason: "evidence-changed",
    });
    const { u3: _dropped, ...withoutU3 } = versionsOf(UNITS);
    const att = attestation({ validated_unit_versions: withoutU3 });
    expect(checkExportGate({ scope: SCOPE, content: CONTENT, attestation: att, unitsById: UNITS })).toEqual({
      ok: false,
      reason: "evidence-changed",
    });
  });

  it("passes content that cites no Units", () => {
    const bare: GeneratedAssetContent = {
      summary: { id: "s", text: "x", source_unit_ids: [] },
      bullets: [],
      skills: [],
    };
    const att = attestation({ validated_unit_versions: {} }, bare);
    expect(checkExportGate({ scope: SCOPE, content: bare, attestation: att, unitsById: new Map() }).ok).toBe(true);
  });
});

describe("evidence precedence", () => {
  it("is missing > unapproved > outdated > changed", () => {
    expect(evidenceRefusal({ missing: 1, unapproved: 1, outdated: 1, edited: 1 })).toBe("evidence-missing");
    expect(evidenceRefusal({ missing: 0, unapproved: 1, outdated: 1, edited: 1 })).toBe("evidence-unapproved");
    expect(evidenceRefusal({ missing: 0, unapproved: 0, outdated: 1, edited: 1 })).toBe("evidence-outdated");
    expect(evidenceRefusal({ missing: 0, unapproved: 0, outdated: 0, edited: 1 })).toBe("evidence-changed");
    expect(evidenceRefusal({ missing: 0, unapproved: 0, outdated: 0, edited: 0 })).toBeNull();
  });

  it("counts each cited Unit once, in its most severe bucket", () => {
    const units = new Map<string, GateUnit>([
      ["u1", unit("u1", { user_approved: false, raw_text: "changed" })],
      ["u2", unit("u2", { raw_text: "changed" })],
    ]);
    const versions = { ...versionsOf(UNITS), u2: versionsOf(UNITS).u2 };
    expect(citedEvidenceCounts(CONTENT, versions, units)).toEqual({ missing: 1, unapproved: 1, outdated: 0, edited: 1 });
  });
});

describe("helpers", () => {
  it("collects cited ids across every section, once each", () => {
    expect([...citedUnitIdsOf(CONTENT)]).toEqual(["u1", "u2", "u3"]);
  });

  it("checks the attestation scope only for the ids given", () => {
    expect(attestationRefusal({ assetId: ASSET }, CONTENT, attestation({ application_id: "other" }))).toBeNull();
    expect(attestationRefusal({ assetId: ASSET, applicationId: APP }, CONTENT, attestation({ application_id: "other" }))).toBe(
      "attestation-mismatch",
    );
  });

  it.each(["ev1:x", "ev2:x", "2026-01-01T00:00:00.000Z"])("treats %s as an older evidence version", (v) => {
    expect(isOlderEvidenceVersion(v)).toBe(true);
  });

  it.each(["ev3:x", "ev4:x", ""])("does not treat %j as older", (v) => {
    expect(isOlderEvidenceVersion(v)).toBe(false);
  });
});
