import type { AssetRef, ValidationFlag } from "../../types/crm.ts";

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
 */

export type ExportGateState =
  | { readonly enabled: true; readonly disabledReason: null }
  | { readonly enabled: false; readonly disabledReason: string };

/** Count of unresolved (i.e. non-traced) flags. */
function unresolvedFlagCount(flags: readonly ValidationFlag[]): number {
  return flags.filter(
    (f) => f.status === "untraceable" || f.status === "specificity",
  ).length;
}

export function exportGateState(asset: AssetRef | null): ExportGateState {
  if (asset === null) {
    return {
      enabled: false,
      disabledReason: "No generated resume to export yet.",
    };
  }
  switch (asset.validation_status) {
    case "passed":
      return { enabled: true, disabledReason: null };
    case "pending":
      return {
        enabled: false,
        disabledReason: "Validation hasn't run on this resume yet.",
      };
    case "stale":
      return {
        enabled: false,
        disabledReason:
          "Resume edited since the last validation run. Re-run validation before exporting.",
      };
    case "failed": {
      const n = unresolvedFlagCount(asset.validation_flags ?? []);
      // Plural agreement matters here per the same CodeRabbit Minor
      // that surfaced on PR #181's right-pane copy.
      const noun = n === 1 ? "flag" : "flags";
      return {
        enabled: false,
        disabledReason: `Resolve ${n} validation ${noun} before exporting.`,
      };
    }
  }
}
