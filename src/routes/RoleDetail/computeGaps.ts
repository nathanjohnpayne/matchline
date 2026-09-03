/**
 * Pure helper: compute the unmet must-have Requirements
 * for a Role (#21 / sub-issue #130).
 *
 * "Unmet must-have" = a Requirement where:
 *   - `must_have: true`, AND
 *   - no `UnitMatch` for the Requirement is ALL THREE of
 *     - non-rejected (`user_rejected: false`), AND
 *     - has `final_score >= GAP_THRESHOLD` (default 0.4
 *       per parent #21 spec), AND
 *     - carries structural evidence
 *       (`structural_evidence !== false`)
 *
 * **A score alone is not evidence.** The scoring components
 * fall back to no-constraint defaults when a Requirement
 * doesn't constrain an axis — 0.5 on skill / tool / domain,
 * 1.0 on seniority and scope. That's deliberate (an
 * unconstrained axis must not read as a candidate
 * deficiency), but a Requirement that constrains NOTHING
 * evaluable stacks those defaults into ~0.425 of unearned
 * `rule_score`, and a recent Unit then clears 0.4 on
 * semantics alone. The credential-shaped Requirement
 * `jd.v1.md` emits with empty `keywords` / `tools` /
 * `domains` is the canonical case: "BS in Computer Science
 * required" would show as covered by whichever Unit happened
 * to embed closest, which is precisely the dishonesty this
 * view exists to prevent.
 *
 * Such matches are NOT hidden — `specs/matchline.md`'s
 * non-goals are explicit that low-quality matches still
 * appear in the Gaps view. They render and rank normally on
 * the Matches tab; they just can't silently satisfy a hard
 * requirement.
 *
 * **Legacy rows and the third state (#441).** Matches written
 * before `structural_evidence` existed were scored under a rule
 * that paid the same neutrals (both-empty Jaccard stored 0.5;
 * unconstrained seniority and scope stored 1.0), so a legacy row
 * can carry the identical unearned credit. #435 let them count
 * as satisfying anyway, so that deploying the gate could not
 * make an already-matched Role sprout gaps overnight — a
 * deliberate stopgap, not a claim that such rows are sound.
 *
 * `deriveMatchEvidence` (#441) is what retires the stopgap. It
 * resolves each legacy row from its ID-linked Unit/Requirement
 * pair, read-only, and hands the verdicts in through `evidence`.
 * Three outcomes, not two:
 *
 *   - `evidenced`     → can cover a must-have.
 *   - `unevidenced`   → cannot, exactly like a stored `false`.
 *   - `unverifiable`  → we could not check. Reported as a gap of
 *     its own kind rather than silently passing or silently
 *     failing, because "there is no match for this" and "there
 *     is a match we could not verify" are different things to
 *     tell someone about to write an application.
 *
 * **Absent `evidence`, the permissive rule stands.** The map is
 * optional and a match missing from it falls back to the old
 * reading. That is the required degradation: a derivation that
 * fails must never tighten into inventing gaps, so a failed or
 * still-in-flight call leaves the view exactly as it was in
 * #435. The caller surfaces the failure; it does not change the
 * verdicts.
 *
 * **Rejected matches do NOT count as satisfying.**
 * cursor CHANGES_REQUESTED round 1 on PR #133 caught the
 * gap: a user-rejected high-score match was still
 * satisfying `computeGaps`'s threshold check, so a
 * Requirement looked "covered" even after the user
 * explicitly rejected the only match that covered it.
 * The matching pipeline's carry-forward shape (cursor
 * #133 r2; `replaceMatchesForRole` preserves
 * `user_rejected` across rerun) makes the rejection
 * durable; this filter ensures the gaps view honors it.
 *
 * Why a 0.4 threshold:
 *   - The matching pipeline (#100) calibrated the score
 *     scale so that 0.4 sits at the boundary between
 *     "tangentially related" and "actually answers this
 *     Requirement." Below that, the rationale strings get
 *     hand-wavy.
 *   - The threshold is overridable so the Phase 3 eval
 *     harness (#25) can tune against real fixtures.
 *
 * Non-must-have Requirements are NEVER in the gaps output —
 * the user already accepted that those don't have to be
 * grounded. The point of the Gaps view is honesty: "here
 * are the things you'd need to address before this
 * Application is defensible."
 *
 * Output ordering: input order is preserved.
 */

import type {
  JobRequirementUnit,
  UnitMatch,
} from "../../types/capability.ts";
// Type-only, and therefore erased before bundling: nothing from
// the deployed functions package reaches the client. Declaring a
// second copy of this union in the app is the drift #443 exists
// to stop, so the callable's response shape has exactly one
// author. `types/evidence.ts` is a leaf with no imports —
// importing the *logic* module instead would drag `node:fs` in
// through the ontology loader, which the app has no types for.
import type {
  EvidenceVerdict,
  MatchEvidence,
  UnverifiableReason,
} from "../../../functions/src/types/evidence.ts";

export const GAP_THRESHOLD = 0.4;

/**
 * Why a Requirement appears in the Gaps list.
 *
 * `unmet` is the original meaning: nothing qualifies. `unverifiable`
 * is #441's addition: something might qualify, but the evidence
 * derivation could not reach a verdict on it — an orphaned
 * Requirement id, a deleted Unit, or a Unit the matching pipeline
 * currently declines to score. The user's next action differs
 * between the two, so the view must not merge them.
 */
export type GapStatus = "unmet" | "unverifiable";

export interface Gap {
  readonly requirement: JobRequirementUnit;
  readonly status: GapStatus;
  /**
   * Why the covering matches could not be verified. Distinct
   * reasons, in first-seen order; empty unless `status` is
   * `unverifiable`.
   *
   * Carried through rather than discarded because the remedies
   * differ and some of them are not the user's to apply. A
   * Requirement-side embedding failure is not a reason to go and
   * look at an Experience Unit, and telling someone it is sends
   * them to fix something that was never broken. Codex P2 on PR
   * #446.
   */
  readonly reasons: readonly UnverifiableReason[];
}

/**
 * Resolve one match to the verdict this function should act on.
 *
 * **The persisted field wins.** The map is a snapshot taken at
 * derivation time and can only ever go stale; the document is
 * live. Two ways that bites, both found on PR #446:
 *
 *   - An explicit rematch persists `structural_evidence: false`
 *     on a row the snapshot recorded as `evidenced`, and the
 *     stale snapshot keeps a must-have looking covered.
 *   - `legacyEvidenceKey` tracks only rows that LACK the field,
 *     so a current row whose stored value changes in place —
 *     via the `upsertMatch` escape hatch or a migration — never
 *     re-triggers the derivation at all. The map would win
 *     indefinitely, until the route remounted.
 *
 * The map originally came first on the reasoning that it already
 * folds in stored values, so there would be one source rather
 * than two. True at the instant it is built, and irrelevant
 * afterwards: folding a value in is not the same as tracking it.
 *
 * Order, therefore: the live field, then the derived snapshot for
 * a row that has no field, then the #435 permissive reading for a
 * legacy row we have no verdict for.
 */
function verdictFor(
  match: UnitMatch,
  evidence: ReadonlyMap<string, MatchEvidence> | undefined,
): EvidenceVerdict {
  if (match.structural_evidence === true) return "evidenced";
  if (match.structural_evidence === false) return "unevidenced";
  // `undefined` is the legacy tier: derive if we can, otherwise
  // the permissive pass.
  return evidence?.get(match.id)?.verdict ?? "evidenced";
}

/**
 * Everything the Gaps panel needs, which is more than a list of
 * Requirements.
 *
 * `strandedMatches` counts non-rejected matches that would have
 * cleared the threshold but point at a Requirement id that no
 * longer exists. Those cannot appear in `gaps`: this function
 * iterates the CURRENT Requirements, and a stranded match's
 * Requirement is by definition not among them, so it was
 * silently dropped — making the `requirement_missing` reason
 * unreachable in exactly the scenario it was written for. Codex
 * P2 on PR #446.
 *
 * **Determined structurally, from the ids in hand.** The first
 * version keyed off the derived `requirement_missing` verdict,
 * which only ever covers legacy rows: a post-#435 match carries
 * `structural_evidence`, so `verdictFor` short-circuits before
 * any verdict is consulted, and a Role whose matches are all
 * post-#435 produces an empty `evidenceKey` and never calls the
 * derivation at all. Stranding needed no round trip in the first
 * place — whether an id is in the current set is answerable
 * here. Codex P2 on PR #446, the round after.
 *
 * It is deliberately a Role-level number rather than an entry in
 * `gaps`. The stranding is not a property of any surviving
 * Requirement — a JD re-parse replaced the old set wholesale
 * (#442) — so attributing it to one would be inventing a
 * relationship that does not exist.
 *
 * Thresholded like `doubted`, and for the same reason: a match
 * that was never going to cover anything changes nothing the user
 * must act on before generating.
 */
export interface GapReport {
  readonly gaps: readonly Gap[];
  readonly strandedMatches: number;
}

export function computeGaps(
  requirements: readonly JobRequirementUnit[],
  matches: readonly UnitMatch[],
  evidence?: ReadonlyMap<string, MatchEvidence>,
  threshold: number = GAP_THRESHOLD,
): GapReport {
  // Best final_score among non-rejected matches that can cover
  // the Requirement, and separately whether any non-rejected
  // match clears the threshold but could not be verified.
  // Rejected matches count for neither — same semantics as the
  // matching pipeline's filter at #82.
  const bestCovering = new Map<string, number>();
  const doubted = new Map<string, UnverifiableReason[]>();
  const currentRequirementIds = new Set(requirements.map((r) => r.id));
  let strandedMatches = 0;
  for (const m of matches) {
    if (m.user_rejected) continue;
    // Stranding is checked BEFORE the verdict, because it is a
    // fact about ids rather than about evidence, and because the
    // verdict path cannot see it: a stored `structural_evidence`
    // short-circuits `verdictFor`, and a Role with no legacy rows
    // never asks the server for a verdict at all.
    if (!currentRequirementIds.has(m.job_requirement_unit_id)) {
      if (m.final_score >= threshold) strandedMatches += 1;
      continue;
    }
    const verdict = verdictFor(m, evidence);
    if (verdict === "unevidenced") continue;
    if (verdict === "unverifiable") {
      // Only a match that would otherwise have covered the
      // Requirement casts doubt. One scoring 0.1 was never going
      // to satisfy it, so being unable to verify it changes
      // nothing the user needs to know.
      if (m.final_score >= threshold) {
        // `requirement_missing` cannot arrive here — the id check
        // above already handled every match whose Requirement is
        // gone — so any reason reaching this point is about the
        // Unit or the embedding pair.
        const reason = evidence?.get(m.id)?.reason;
        const reasons =
          doubted.get(m.job_requirement_unit_id) ??
          doubted.set(m.job_requirement_unit_id, []).get(m.job_requirement_unit_id)!;
        if (reason !== undefined && !reasons.includes(reason)) {
          reasons.push(reason);
        }
      }
      continue;
    }
    const prev = bestCovering.get(m.job_requirement_unit_id);
    if (prev === undefined || m.final_score > prev) {
      bestCovering.set(m.job_requirement_unit_id, m.final_score);
    }
  }

  const gaps: Gap[] = [];
  for (const req of requirements) {
    if (!req.must_have) continue;
    const best = bestCovering.get(req.id);
    if (best !== undefined && best >= threshold) continue;
    const reasons = doubted.get(req.id);
    gaps.push({
      requirement: req,
      status: reasons === undefined ? "unmet" : "unverifiable",
      reasons: reasons ?? [],
    });
  }
  return { gaps, strandedMatches };
}
