import type { AssetRef } from "../../types/crm.ts";

/**
 * Pick the asset the Application Editor renders in the left pane.
 * PR 1 surfaces the resume only; cover-letter and outreach assets
 * are out of scope (Phase 2).
 *
 * Selection rule: the most recently created asset where
 *   `kind === "resume"`, `format === "json"`, and
 *   `generated_content` is populated.
 *
 * `format === "json"` is the gate: pre-#22 binary assets (pdf/docx
 * uploaded by the user before generation existed) won't carry
 * structured `generated_content`, and re-rendering them as bullets
 * isn't possible. The pipeline (#22 / #121) writes `format: "json"`
 * for every generated asset; legacy/manual binary assets are
 * filtered out cleanly here.
 *
 * Returns null when no eligible asset exists — the view renders
 * an empty-state surface in that case rather than a confusing
 * "loading" or "error" state.
 */
export function selectPrimaryResumeAsset(
  assets: readonly AssetRef[],
): AssetRef | null {
  const eligible = assets.filter(
    (a) =>
      a.kind === "resume" &&
      a.format === "json" &&
      a.generated_content !== undefined,
  );
  if (eligible.length === 0) return null;
  // Most recent wins. `created_at` is an ISO timestamp, so string
  // comparison is total-order-correct for the V1 generation paths.
  return [...eligible].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  )[0];
}
