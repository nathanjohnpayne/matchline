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

  it("registers the Claude 5.5 family for the #495 sweep", () => {
    expect(rateFor("claude-sonnet-5-5")).toMatchObject({
      inputUsdPer1k: 0.002,
      outputUsdPer1k: 0.01,
    });
    expect(rateFor("claude-opus-5-5")).toMatchObject({
      inputUsdPer1k: 0.004,
      outputUsdPer1k: 0.02,
    });
    expect(rateFor("claude-haiku-5-5")).toMatchObject({
      inputUsdPer1k: 0.0001,
      outputUsdPer1k: 0.0005,
    });
  });

  it("Opus/Sonnet 5.5 cache reads are 0.05x input; older models 0.1x", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      const r = rateFor(model);
      expect(r.cacheReadUsdPer1k! / r.inputUsdPer1k, model).toBeCloseTo(0.05, 9);
    }
    for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-haiku-5-5"]) {
      const r = rateFor(model);
      expect(r.cacheReadUsdPer1k! / r.inputUsdPer1k, model).toBeCloseTo(0.1, 9);
    }
  });

  it("only Haiku 5.5 carries a long-prompt card, and it is frozen", () => {
    const withLong = Object.entries(RATES)
      .filter(([, r]) => r.longPrompt !== undefined)
      .map(([m]) => m);
    expect(withLong).toEqual(["claude-haiku-5-5"]);
    const long = rateFor("claude-haiku-5-5").longPrompt!;
    expect(long.thresholdTokens).toBe(100_000);
    expect(Object.isFrozen(long)).toBe(true);
    expect(Object.isFrozen(long.rate)).toBe(true);
  });

  it("every Anthropic model has cache rates; embeddings have none", () => {
    for (const [model, r] of Object.entries(RATES)) {
      if (model.startsWith("claude-")) {
        expect(r.cacheWriteUsdPer1k, model).toBeGreaterThan(0);
        expect(r.cacheReadUsdPer1k, model).toBeGreaterThan(0);
      }
    }
    expect(rateFor(EMBEDDING_MODEL).cacheReadUsdPer1k).toBeUndefined();
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

  it("each ModelRate is deep-frozen — nested properties cannot be mutated", () => {
    const sonnet = RATES["claude-sonnet-4-6"];
    expect(Object.isFrozen(sonnet)).toBe(true);
    expect(() => {
      // @ts-expect-error — deliberately probing nested immutability
      sonnet.inputUsdPer1k = 999;
    }).toThrow(TypeError);
    // Post-mutation attempt: value must still be original.
    expect(RATES["claude-sonnet-4-6"].inputUsdPer1k).toBe(0.003);
  });
});
