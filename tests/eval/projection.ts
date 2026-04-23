/**
 * Monthly spend projection guard. Pure helpers — the harness wires
 * them to a real `llm_calls` Firestore aggregation in Phase 1; for
 * Phase 0 these are tested against mocked usage inputs.
 *
 * Hard caps come from `memory/matchline_budget_ceilings.md`:
 *   Firebase: $25/mo, OpenAI: $25/mo, Anthropic: $25/mo.
 *   Combined LLM ceiling: $50/mo.
 *
 * The harness cannot run a full-corpus eval nightly — per the #47
 * comment: 30 flows/day at $0.30 each = ~$270/mo, 5.4× the LLM cap.
 * Default mode is "smoke" (small subset); "full" mode opt-in gated
 * by the cap check below.
 */

export interface MonthlyUsage {
  readonly anthropicUsd: number;
  readonly openaiUsd: number;
  readonly firebaseUsd: number;
}

export interface Caps extends MonthlyUsage {}

export interface CapCheck {
  readonly provider: "anthropic" | "openai" | "firebase";
  readonly cap: number;
  readonly currentUsd: number;
  readonly plannedAddUsd: number;
  readonly projectedUsd: number;
  readonly exceedsCap: boolean;
  readonly exceedsWarn: boolean;
}

/** Default caps sourced from memory/matchline_budget_ceilings.md. */
export const DEFAULT_CAPS: Caps = Object.freeze({
  anthropicUsd: 25,
  openaiUsd: 25,
  firebaseUsd: 25,
});

/**
 * Warn threshold (fraction of cap). Fails the harness gate at
 * `HARD_THRESHOLD_FRACTION` but warns earlier so operators see it
 * coming before the hard rejection.
 */
export const WARN_THRESHOLD_FRACTION = 0.8;
export const HARD_THRESHOLD_FRACTION = 0.95;

/**
 * Project current-month usage + planned add against the caps, return
 * a per-provider evaluation. Pure — pass in whatever `currentUsage`
 * the harness has fetched (or mocked).
 */
export function checkCaps(
  currentUsage: MonthlyUsage,
  plannedAdd: { anthropicUsd: number; openaiUsd: number; firebaseUsd: number },
  caps: Caps = DEFAULT_CAPS,
): readonly CapCheck[] {
  return [
    makeCheck("anthropic", caps.anthropicUsd, currentUsage.anthropicUsd, plannedAdd.anthropicUsd),
    makeCheck("openai", caps.openaiUsd, currentUsage.openaiUsd, plannedAdd.openaiUsd),
    makeCheck("firebase", caps.firebaseUsd, currentUsage.firebaseUsd, plannedAdd.firebaseUsd),
  ];
}

function makeCheck(
  provider: CapCheck["provider"],
  cap: number,
  currentUsd: number,
  plannedAddUsd: number,
): CapCheck {
  const projectedUsd = currentUsd + plannedAddUsd;
  return {
    provider,
    cap,
    currentUsd,
    plannedAddUsd,
    projectedUsd,
    exceedsCap: projectedUsd > cap * HARD_THRESHOLD_FRACTION,
    exceedsWarn: projectedUsd > cap * WARN_THRESHOLD_FRACTION,
  };
}

/**
 * True if any provider's projected spend exceeds the hard threshold.
 * The harness short-circuits on true.
 */
export function shouldBlock(checks: readonly CapCheck[]): boolean {
  return checks.some((c) => c.exceedsCap);
}
