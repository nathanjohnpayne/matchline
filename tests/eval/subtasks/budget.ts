/**
 * Per-request spend bound for the subtask suites (#488).
 *
 * Before every live request the ledger prices that request's worst
 * case (estimated input plus the full `max_tokens` of output) and
 * refuses it if spent + worst case would cross `--max-usd`. Refusing
 * aborts the run-level controller FIRST: the validation modules retry
 * a transport error with backoff unless their signal is aborted, and
 * every instrumented call carries that controller's signal, so a
 * budget stop never turns into retries.
 */

import { priceFor } from "../../../functions/src/llm/cost.ts";

import { BudgetReachedError } from "../fitBrief/run.ts";
import { estimateTokens } from "../tokenSource.ts";

export { BudgetReachedError };

/** Margin for tokenizers that count more tokens than `estimateTokens` (5.5 family ≈ +30–35%). */
export const INPUT_ESTIMATE_FACTOR = 1.35;

export interface ReservableBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: unknown;
  readonly messages: unknown;
  readonly tools?: unknown;
}

export function worstCaseUsd(body: ReservableBody): number {
  const inputEst = Math.ceil(
    INPUT_ESTIMATE_FACTOR *
      estimateTokens(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })),
  );
  return priceFor(body.model, { inputTokens: inputEst, outputTokens: body.max_tokens });
}

export class BudgetLedger {
  private spent = 0;
  private readonly maxUsd: number | null;
  private readonly abort: AbortController;

  constructor(opts: { readonly maxUsd: number | null; readonly abort: AbortController }) {
    this.maxUsd = opts.maxUsd;
    this.abort = opts.abort;
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** Throws `BudgetReachedError` (after aborting the run) if this request could cross the bound. */
  reserve(body: ReservableBody): void {
    if (this.maxUsd === null) return;
    const worst = worstCaseUsd(body);
    if (this.spent + worst > this.maxUsd) {
      this.abort.abort(new BudgetReachedError());
      throw new BudgetReachedError();
    }
  }

  /** Add the metered cost of a live response. */
  settle(costUsd: number): void {
    this.spent += costUsd;
  }
}
