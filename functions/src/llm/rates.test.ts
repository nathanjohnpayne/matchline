import { describe, expect, it } from "vitest";

import { modelFor, type Stage } from "./config.js";
import { EMBEDDING_MODEL } from "./config.js";
import { RATES, rateFor } from "./rates.js";

describe("rates", () => {
  it("throws on unknown model rather than returning a silent zero", () => {
    expect(() => rateFor("claude-definitely-not-real")).toThrow(
      /No rate registered for model: claude-definitely-not-real/,
    );
  });

  it("covers every stage-configured model", () => {
    const stages: readonly Stage[] = [
      "extraction",
      "requirement_parsing",
      "rationale",
      "generation",
      "validation",
    ];
    for (const stage of stages) {
      const { model } = modelFor(stage);
      expect(RATES[model], `stage "${stage}" model "${model}" has no rate entry`).toBeDefined();
    }
  });

  it("covers the embedding model", () => {
    expect(RATES[EMBEDDING_MODEL]).toBeDefined();
  });

  it("returns positive input rates for all registered models", () => {
    for (const [model, rate] of Object.entries(RATES)) {
      expect(rate.inputUsdPer1k, `${model} inputUsdPer1k`).toBeGreaterThanOrEqual(0);
      expect(rate.outputUsdPer1k, `${model} outputUsdPer1k`).toBeGreaterThanOrEqual(0);
    }
  });

  it("embedding models have zero output rate (input-only pricing)", () => {
    expect(rateFor(EMBEDDING_MODEL).outputUsdPer1k).toBe(0);
  });

  it("rejects inherited Object.prototype keys (toString, constructor)", () => {
    // Without Object.hasOwn, `RATES["toString"]` would return a function
    // and pass the truthy check, silently masquerading as a model.
    expect(() => rateFor("toString")).toThrow(/No rate registered/);
    expect(() => rateFor("constructor")).toThrow(/No rate registered/);
    expect(() => rateFor("hasOwnProperty")).toThrow(/No rate registered/);
  });

  it("RATES is frozen — pricing table cannot be mutated after export", () => {
    expect(Object.isFrozen(RATES)).toBe(true);
    expect(() => {
      // @ts-expect-error — deliberately probing runtime immutability
      RATES["new-model"] = { inputUsdPer1k: 0, outputUsdPer1k: 0 };
    }).toThrow(TypeError);
  });
});
