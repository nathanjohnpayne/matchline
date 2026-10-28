import { describe, expect, it } from "vitest";

import { priceFor } from "../../../functions/src/llm/cost.ts";
import { estimateTokens } from "../tokenSource.ts";

import { BudgetLedger, BudgetReachedError, INPUT_ESTIMATE_FACTOR, worstCaseUsd } from "./budget.ts";

const BODY = { model: "claude-sonnet-4-6", max_tokens: 1024, system: "s".repeat(400), messages: [{ role: "user", content: "m".repeat(4000) }] };

describe("worstCaseUsd", () => {
  it("prices the estimated input and the full output cap", () => {
    const input = Math.ceil(INPUT_ESTIMATE_FACTOR * estimateTokens(JSON.stringify({ system: BODY.system, messages: BODY.messages })));
    expect(worstCaseUsd(BODY)).toBeCloseTo(priceFor("claude-sonnet-4-6", { inputTokens: input, outputTokens: 1024 }), 10);
    expect(worstCaseUsd({ ...BODY, max_tokens: 2048 })).toBeGreaterThan(worstCaseUsd(BODY));
  });
});

describe("BudgetLedger", () => {
  it("allows requests while spent + worst case stays within the bound", () => {
    const abort = new AbortController();
    const worst = worstCaseUsd(BODY);
    const ledger = new BudgetLedger({ maxUsd: worst * 2, abort });
    ledger.settle(ledger.reserve(BODY), worst);
    ledger.reserve(BODY);
    expect(ledger.spentUsd).toBeCloseTo(worst, 10);
    expect(ledger.reservedUsd).toBeCloseTo(worst, 10);
    expect(abort.signal.aborted).toBe(false);
  });

  it("aborts the run, then throws a 402 BudgetReachedError, once a request could cross it", () => {
    const abort = new AbortController();
    const worst = worstCaseUsd(BODY);
    const ledger = new BudgetLedger({ maxUsd: worst * 1.5, abort });
    ledger.settle(ledger.reserve(BODY), worst);
    let thrown: unknown;
    try {
      ledger.reserve(BODY);
    } catch (err) {
      thrown = err;
      expect(abort.signal.aborted).toBe(true);
    }
    expect(thrown).toBeInstanceOf(BudgetReachedError);
    expect((thrown as BudgetReachedError).status).toBe(402);
  });

  it("never throws without a bound", () => {
    const ledger = new BudgetLedger({ maxUsd: null, abort: new AbortController() });
    ledger.settle(ledger.reserve(BODY), 1_000);
    expect(() => ledger.reserve(BODY)).not.toThrow();
  });

  it("counts requests still in flight: two reserves never settled trip the bound", () => {
    const abort = new AbortController();
    const worst = worstCaseUsd(BODY);
    const ledger = new BudgetLedger({ maxUsd: worst * 2.5, abort });
    ledger.reserve(BODY);
    ledger.reserve(BODY);
    expect(ledger.spentUsd).toBe(0);
    expect(() => ledger.reserve(BODY)).toThrow(BudgetReachedError);
    expect(abort.signal.aborted).toBe(true);
  });

  it("refuses the later of six concurrent reserves before any of them settles", () => {
    const worst = worstCaseUsd(BODY);
    const ledger = new BudgetLedger({ maxUsd: worst * 4, abort: new AbortController() });
    const outcomes = Array.from({ length: 6 }, () => {
      try {
        ledger.reserve(BODY);
        return "reserved";
      } catch (err) {
        return err instanceof BudgetReachedError ? "refused" : "other";
      }
    });
    expect(outcomes).toEqual(["reserved", "reserved", "reserved", "reserved", "refused", "refused"]);
    expect(ledger.reservedUsd).toBeCloseTo(worst * 4, 10);
  });

  it("releases a reservation with no spend, once, so a failed request frees its hold", () => {
    const worst = worstCaseUsd(BODY);
    const ledger = new BudgetLedger({ maxUsd: worst * 1.5, abort: new AbortController() });
    const r = ledger.reserve(BODY);
    ledger.release(r);
    ledger.release(r);
    expect(ledger.reservedUsd).toBe(0);
    expect(ledger.spentUsd).toBe(0);
    ledger.settle(ledger.reserve(BODY), worst / 2);
    expect(ledger.reservedUsd).toBe(0);
    expect(ledger.spentUsd).toBeCloseTo(worst / 2, 10);
  });
});
