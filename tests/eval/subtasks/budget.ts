/**
 * Per-request spend bound for the subtask suites (#488).
 *
 * Before every live request the ledger prices that request's worst
 * case (estimated input plus the full `max_tokens` of output) and
 * refuses it if spent + the worst cases still in flight + this worst
 * case would cross `--max-usd`. This ledger, not the dry-run plan, is
 * the stop: the plan's claim and item counts are heuristics. Refusing
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

/**
 * One live request's hold on the budget, from `reserve` until it is
 * settled (a response arrived) or released (no response, no spend).
 */
export class Reservation {
  private open = true;

  constructor(readonly worstUsd: number) {}

  /** Close the reservation; true only the first time. */
  close(): boolean {
    const was = this.open;
    this.open = false;
    return was;
  }
}

export class BudgetLedger {
  private spent = 0;
  private reserved = 0;
  private readonly maxUsd: number | null;
  private readonly abort: AbortController;

  constructor(opts: { readonly maxUsd: number | null; readonly abort: AbortController }) {
    this.maxUsd = opts.maxUsd;
    this.abort = opts.abort;
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** Worst cases of the requests still in flight. */
  get reservedUsd(): number {
    return this.reserved;
  }

  /**
   * Hold this request's worst case against the bound. Requests in flight
   * count: up to `VALIDATION_CONCURRENCY` run at once, so checking only
   * settled spend would let every one of them pass against the same
   * stale total. Throws `BudgetReachedError` (after aborting the run) if
   * spent + reserved + this worst case would cross the bound.
   */
  reserve(body: ReservableBody): Reservation {
    if (this.maxUsd === null) return new Reservation(0);
    const worst = worstCaseUsd(body);
    if (this.spent + this.reserved + worst > this.maxUsd) {
      this.abort.abort(new BudgetReachedError());
      throw new BudgetReachedError();
    }
    this.reserved += worst;
    return new Reservation(worst);
  }

  /**
   * A response arrived: drop the hold and add the metered cost. A null
   * cost (a response no rate could price) counts at the reservation's
   * worst case, never $0, so unpriceable responses still consume
   * `--max-usd`.
   */
  settle(r: Reservation, costUsd: number | null): void {
    this.release(r);
    this.spent += costUsd ?? r.worstUsd;
  }

  /** No response (transport error, abort): drop the hold with no spend. Idempotent. */
  release(r: Reservation): void {
    if (r.close()) this.reserved = Math.max(0, this.reserved - r.worstUsd);
  }
}
