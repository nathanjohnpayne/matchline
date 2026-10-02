import type { ExperienceUnit } from "../../types/capability.ts";
import type { AssetRef, ValidationFlag } from "../../types/crm.ts";
import { unitEvidenceVersion } from "../../../functions/src/validation/unitEvidenceVersion.ts";
import {
  assetContentVersion,
  type ValidationAttestation,
} from "../../../functions/src/validation/attestation.ts";

/**
 * Decide whether the Export button is enabled, and the tooltip text
 * to show when it's disabled. Pure: takes the resolved primary
 * resume asset and returns the gate state.
 *
 * Issue #24's invariant: "Export is blocked. Until all validation
 * flags are resolved, the Export button is disabled with a tooltip
 * explaining why. This is the enforcement point for zero-fabrication
 * — not a warning, a gate."
 *
 * `validation_status === "passed"` is the only enabling state. The
 * other three states all mean "export is unsafe":
 *
 *   - `"pending"`: validation hasn't run yet (the asset was just
 *     generated). The user clicked Export before the validator
 *     finished — surface that.
 *   - `"failed"`: at least one untraceable / specificity flag is
 *     unresolved. Surface the count so the user knows what to fix.
 *   - `"stale"`: the asset content changed since the last validation
 *     run (PR 3's edit flow flips here). User must re-validate.
 *
 * `null` asset means there's no generated resume yet — gate is
 * disabled with the empty-asset message.
 *
 * **`passed` must be server-attested (#502).** The asset's status
 * lives in a client-writable list, so on its own it cannot prove a
 * validator passed this content. The gate also requires the server's
 * attestation for the asset's current content (`AttestationLookup`,
 * `functions/src/validation/attestation.ts`). Without one, a `passed`
 * asset reads as unconfirmed and offers a re-run; assets validated
 * before attestations existed need that one re-run.
 *
 * **`passed` is re-checked against the Units it cites.** A `passed`
 * verdict is a statement about the evidence as it stood when the
 * validator ran. Nothing invalidates it when that evidence changes
 * afterwards: rejecting, flagging or un-approving a cited Unit, or
 * editing its text, leaves `validation_status: "passed"` in place, and
 * the gate used to export claims grounded on evidence the user has
 * since withdrawn — the zero-fabrication invariant this gate enforces.
 * So when `unitsById` is supplied, a `passed` asset stays blocked if
 * any Unit cited by its `source_unit_ids`:
 *
 *   - no longer exists,
 *   - is not currently approved (`user_approved !== true`), or
 *   - has changed since the validator loaded it: its
 *     `unitEvidenceVersion` (a fingerprint of the fields the validator
 *     reads) differs from the one recorded in the attestation's
 *     `validated_unit_versions`. Comparing content, not times, catches
 *     an edit made WHILE validation was running (the verdict's
 *     `validated_at` is stamped after the evidence was read), a write
 *     that kept `updated_at`, and is immune to client/server clock
 *     skew.
 *
 * Re-checking here rather than flipping stored assets to `stale` on
 * every Unit write keeps this a pure function of what the editor has
 * already loaded: no fan-out query across Applications, no extra
 * writes on the Unit Review hot path, and no window in which a Unit
 * write has landed but the fan-out has not. Callers that pass no
 * `unitsById` get the status-only behavior.
 */

export type ExportGateState =
  | { readonly enabled: true; readonly disabledReason: null }
  | {
      readonly enabled: false;
      readonly disabledReason: string;
      /**
       * True when re-running validation on the current content is the
       * fix (never validated, edited since, or cited evidence changed
       * since the last run). The editor then offers an explicit
       * "Re-run validation" action next to the disabled Export.
       * Also true for a failed run: its flags may have been resolved by
       * repairing the cited Units, which no edit re-validates. Export
       * stays disabled either way until a run passes. False/absent only
       * when a cited Unit is missing or unapproved, where re-running
       * cannot help until the user restores or re-approves it.
       */
      readonly canRevalidate?: boolean;
    };

/** Count of unresolved (i.e. non-traced) flags. */
function unresolvedFlagCount(flags: readonly ValidationFlag[]): number {
  return flags.filter(
    (f) => f.status === "untraceable" || f.status === "specificity",
  ).length;
}

/** Every Unit id cited by any item of the asset's content. */
export function citedUnitIds(asset: AssetRef): ReadonlySet<string> {
  const content = asset.generated_content;
  const ids = new Set<string>();
  if (content === undefined) return ids;
  const items = [
    content.summary,
    ...content.bullets,
    ...content.skills,
    ...(content.education ?? []),
  ];
  for (const item of items) {
    for (const id of item.source_unit_ids) ids.add(id);
  }
  return ids;
}

/**
 * Why a `passed` asset's grounding is no longer current, or `null` if
 * it still is. Precedence: missing > not approved > edited, so the
 * reason names the most severe problem.
 */
function citedEvidenceProblem(
  asset: AssetRef,
  versions: Readonly<Record<string, string>>,
  unitsById: ReadonlyMap<string, ExperienceUnit>,
): { readonly reason: string; readonly canRevalidate: boolean } | null {
  let missing = 0;
  let unapproved = 0;
  let edited = 0;
  for (const id of citedUnitIds(asset)) {
    const unit = unitsById.get(id);
    if (unit === undefined) {
      missing += 1;
    } else if (unit.user_approved !== true) {
      unapproved += 1;
    } else if (versions[id] !== unitEvidenceVersion(unit)) {
      // A cited Unit the validator did not load (absent key) was not
      // evidence for this verdict either.
      edited += 1;
    }
  }
  const units = (n: number): string => (n === 1 ? "1 Unit" : `${n} Units`);
  const verb = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  if (missing > 0) {
    return {
      reason:
        `This resume cites ${units(missing)} that no longer ${verb(missing, "exists", "exist")}. ` +
        "Edit or remove the bullets that cite them, then re-validate.",
      canRevalidate: false,
    };
  }
  if (unapproved > 0) {
    return {
      reason:
        `This resume cites ${units(unapproved)} that ${verb(unapproved, "is", "are")} no longer approved. ` +
        "Re-approve them, or edit or remove the bullets that cite them.",
      canRevalidate: false,
    };
  }
  if (edited > 0) {
    return {
      reason:
        `${units(edited)} this resume cites ${verb(edited, "has", "have")} changed since the last ` +
        "validation run read them. Re-run validation before exporting.",
      canRevalidate: true,
    };
  }
  return null;
}

/**
 * The server attestation for the asset's current content, as the
 * editor has loaded it (#502): `undefined` while it is still being
 * read, `null` when the server holds no verdict for this content.
 */
export type AttestationLookup = ValidationAttestation | null | undefined;

/**
 * The asset's `passed` is trusted only when the server attested the
 * asset's CURRENT content as passed. The asset-level status sits in a
 * client-writable list, so it can say `passed` for content no
 * validator ever saw; the attestation cannot (#502).
 */
function attestedPassed(
  asset: AssetRef,
  attestation: ValidationAttestation,
): boolean {
  return (
    attestation.asset_id === asset.id &&
    attestation.status === "passed" &&
    asset.generated_content !== undefined &&
    attestation.content_version === assetContentVersion(asset.generated_content)
  );
}

export function exportGateState(
  asset: AssetRef | null,
  unitsById?: ReadonlyMap<string, ExperienceUnit>,
  attestation?: AttestationLookup,
): ExportGateState {
  if (asset === null) {
    return {
      enabled: false,
      disabledReason: "No generated resume to export yet.",
    };
  }
  switch (asset.validation_status) {
    case "passed": {
      if (attestation === undefined) {
        return {
          enabled: false,
          disabledReason: "Checking this resume's validation result…",
        };
      }
      if (attestation === null || !attestedPassed(asset, attestation)) {
        return {
          enabled: false,
          disabledReason:
            "This resume's validation result couldn't be confirmed. Re-run validation before exporting.",
          canRevalidate: true,
        };
      }
      const problem =
        unitsById === undefined
          ? null
          : citedEvidenceProblem(asset, attestation.validated_unit_versions, unitsById);
      return problem === null
        ? { enabled: true, disabledReason: null }
        : {
            enabled: false,
            disabledReason: problem.reason,
            canRevalidate: problem.canRevalidate,
          };
    }
    case "pending":
      return {
        enabled: false,
        disabledReason: "Validation hasn't run on this resume yet.",
        canRevalidate: true,
      };
    case "stale":
      return {
        enabled: false,
        disabledReason:
          "Resume edited since the last validation run. Re-run validation before exporting.",
        canRevalidate: true,
      };
    case "failed": {
      const n = unresolvedFlagCount(asset.validation_flags ?? []);
      // Plural agreement matters here per the same CodeRabbit Minor
      // that surfaced on PR #181's right-pane copy.
      const noun = n === 1 ? "flag" : "flags";
      return {
        enabled: false,
        disabledReason: `Resolve ${n} validation ${noun} before exporting.`,
        // Flags can be resolved outside the resume (approving or editing
        // the cited Units), which the edit flow never re-validates, so a
        // retry must stay available here. Export stays blocked until a
        // run actually passes (#501 review).
        canRevalidate: true,
      };
    }
  }
}
