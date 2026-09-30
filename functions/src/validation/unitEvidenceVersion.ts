/**
 * The version of a Unit **as validation evidence**: a fingerprint over
 * exactly the fields the traceability check shows the model
 * (`formatUnit` in `./traceability.ts`). The validator records it per
 * loaded Unit in `validated_unit_versions`, and the editor's export
 * gate recomputes it from the live Unit, so a verdict stops counting
 * the moment any evidence it was computed from differs.
 *
 * ## Why not `updated_at`
 *
 * The first version recorded each Unit's `updated_at`. That is only a
 * version if every write advances it, and one does not: the exported
 * `upsertExperienceUnit` in `src/services/experienceUnits.ts` writes
 * the caller's object verbatim, timestamp included, and
 * `firestore.rules` does not require the timestamp to change. Changed
 * evidence could therefore arrive under the validated timestamp and
 * leave export enabled for text the validator never read. Codex P1 on
 * PR #501; `src/routes/RoleDetail/evidenceKey.ts` hit the same
 * contract gap on PR #446. Hashing the content removes the dependence
 * on that contract instead of relying on it holding everywhere.
 *
 * ## The rule for changing this
 *
 * A field belongs here if and only if the validator reads it to reach
 * a verdict. Omitting one it reads lets an edit to that field keep a
 * stale verdict; adding one it ignores only forces a harmless re-run.
 * Approval is deliberately absent: the gate checks `user_approved`
 * directly, and the validator loads approved Units only.
 *
 * Dependency-free on purpose: the app imports this file across the
 * package boundary (as it does `../types/capability.ts`), so the
 * server and the editor compute the same value from one definition.
 */

/** The subset of `ExperienceUnit` the validator reads. */
export interface UnitEvidenceFields {
  readonly id: string;
  readonly raw_text: string;
  readonly normalized_summary: string;
  readonly metrics?: readonly {
    readonly claim: string;
    readonly value?: number;
    readonly unit?: string;
    readonly direction?: string;
  }[];
  readonly seniority_signals?: readonly string[];
  readonly scope_signals?: readonly string[];
}

/**
 * Bump when the field list or encoding changes, so a verdict recorded
 * under the old definition reads as changed rather than colliding.
 */
const VERSION_PREFIX = "ev1:";

const encoder = new TextEncoder();

/**
 * FNV-1a 64-bit over UTF-8 bytes, as 16 hex digits. Computed in four
 * 16-bit limbs rather than with BigInt: the export gate runs this for
 * every cited Unit on every editor render, and BigInt arithmetic per
 * byte costs milliseconds there. The prime is 2^40 + 0x1b3, so the
 * multiply is `h * 0x1b3` plus `h << 40` (the low two limbs shifted
 * up two limbs and 8 bits). The unit test pins this against a BigInt
 * reference.
 */
export function fnv1a64(text: string): string {
  // Offset basis 0xcbf29ce484222325, low limb first.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const byte of encoder.encode(text)) {
    h0 ^= byte;
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8);
    const t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = (t3 + (t2 >>> 16)) & 0xffff;
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
}

export function unitEvidenceVersion(unit: UnitEvidenceFields): string {
  // JSON, not delimiters: the encoding is lossless, so two different
  // field sets can only collide through the hash itself.
  const canonical = JSON.stringify([
    unit.id,
    unit.raw_text,
    unit.normalized_summary,
    (unit.metrics ?? []).map((m) => [
      m.claim,
      m.value ?? null,
      m.unit ?? null,
      m.direction ?? null,
    ]),
    unit.seniority_signals ?? [],
    unit.scope_signals ?? [],
  ]);
  return VERSION_PREFIX + fnv1a64(canonical);
}
