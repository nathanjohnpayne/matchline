import type { ValidationFlag } from "../../types/crm.ts";

/**
 * Group an asset's validation flags by `bullet_id`, dropping the
 * "traced" status (those passed validation and don't need a badge).
 *
 * Each `GeneratedItem` (summary, bullet, skill, education) carries
 * a stable id; the validation orchestrator emits flags keyed on
 * that id via `bullet_id` (the field name dates from when only
 * bullets had ids — see the GeneratedItem comment in
 * `src/types/crm.ts`). The view groups badges per item, so the
 * lookup needs to be `Map<itemId, ValidationFlag[]>`.
 *
 * Why a Map: the view does a per-item lookup inside a render loop
 * (`flagsByBullet.get(item.id)`), and Map's O(1) get is the
 * cheapest option that doesn't litter the call sites with array
 * filters.
 *
 * `ValidationFlag.claim_id` is intentionally NOT a grouping key
 * here — V1 emits one claim per item in practice (the claim
 * extractor returns the single bullet text). Multi-claim bullets
 * would need a per-claim sub-grouping; defer until that's a real
 * shape.
 */
export function flagsByBullet(
  flags: readonly ValidationFlag[] | undefined,
): ReadonlyMap<string, readonly ValidationFlag[]> {
  const out = new Map<string, ValidationFlag[]>();
  if (flags === undefined) return out;
  for (const f of flags) {
    if (f.status === "traced") continue;
    const list = out.get(f.bullet_id);
    if (list === undefined) {
      out.set(f.bullet_id, [f]);
    } else {
      list.push(f);
    }
  }
  return out;
}
