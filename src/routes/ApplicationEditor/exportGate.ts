import type { ExperienceUnit } from "../../types/capability.ts";
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
 *   - has changed since the validator loaded it: its `updated_at`
 *     differs from the version recorded in the asset's
 *     `validated_unit_versions`. Comparing versions, not times, catches
 *     an edit made WHILE validation was running (the verdict's
 *     `validated_at` is stamped after the evidence was read) and is
 *     immune to client/server clock skew. Assets validated before
 *     that field existed fall back to `updated_at > validated_at`.
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
       * False/absent when the user must act first (resolve flags,
       * restore or re-approve cited Units).
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

function parseTime(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Why a `passed` asset's grounding is no longer current, or `null` if
 * it still is. Precedence: missing > not approved > edited, so the
 * reason names the most severe problem.
 */
function citedEvidenceProblem(
  asset: AssetRef,
  unitsById: ReadonlyMap<string, ExperienceUnit>,
): { readonly reason: string; readonly canRevalidate: boolean } | null {
  const versions = asset.validated_unit_versions;
  const validatedAt = parseTime(asset.validated_at);
  let missing = 0;
  let unapproved = 0;
  let edited = 0;
  for (const id of citedUnitIds(asset)) {
    const unit = unitsById.get(id);
    if (unit === undefined) {
      missing += 1;
    } else if (unit.user_approved !== true) {
      unapproved += 1;
    } else if (versions !== undefined) {
      // A cited Unit the validator did not load (absent key) was not
      // evidence for this verdict either.
      if (versions[id] !== unit.updated_at) edited += 1;
    } else {
      // Legacy asset: best effort on timestamps. Without
      // `validated_at` there is nothing to compare; the existence and
      // approval checks above still apply.
      const updatedAt = parseTime(unit.updated_at);
      if (validatedAt !== undefined && updatedAt !== undefined && updatedAt > validatedAt) {
        edited += 1;
      }
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

export function exportGateState(
  asset: AssetRef | null,
  unitsById?: ReadonlyMap<string, ExperienceUnit>,
): ExportGateState {
  if (asset === null) {
    return {
      enabled: false,
      disabledReason: "No generated resume to export yet.",
    };
  }
  switch (asset.validation_status) {
    case "passed": {
      const problem =
        unitsById === undefined ? null : citedEvidenceProblem(asset, unitsById);
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
      };
    }
  }
}
