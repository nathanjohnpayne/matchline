import { afterEach, describe, expect, it } from "vitest";

import {
  clearEffortOverrides,
  effortFor,
  getEffortOverrides,
  modelFor,
  setEffortOverrides,
  STAGES,
} from "./config.js";
import {
  LONG_REQUEST_TIMEOUT_MS,
  MODEL_PROFILES,
  profileFor,
  toolCallRequest,
} from "./modelProfile.js";
import { RATES } from "./rates.js";

afterEach(() => {
  clearEffortOverrides();
});

describe("toolCallRequest", () => {
  it("leaves the current pins' requests exactly as they were", () => {
    for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
      expect(
        toolCallRequest({ model, toolName: "record_x", baseMaxTokens: 16_384 }),
        model,
      ).toEqual({
        max_tokens: 16_384,
        tool_choice: { type: "tool", name: "record_x" },
        systemSuffix: "",
      });
    }
  });

  it("asks Sonnet 5.5 for the tool through tool_choice auto plus an instruction", () => {
    const req = toolCallRequest({
      model: "claude-sonnet-5-5",
      toolName: "record_x",
      baseMaxTokens: 16_384,
    });
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.systemSuffix).toContain("`record_x`");
    expect(req.systemSuffix).toMatch(/exactly once/);
  });

  it("asks Opus 5.5 the same way", () => {
    expect(
      toolCallRequest({ model: "claude-opus-5-5", toolName: "t", baseMaxTokens: 1000 }).tool_choice,
    ).toEqual({ type: "auto" });
  });

  it("asks Fable 5.1 for the tool through tool_choice auto, defaulting to high effort", () => {
    const req = toolCallRequest({ model: "claude-fable-5-1", toolName: "t", baseMaxTokens: 1000 });
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.output_config).toEqual({ effort: "high" });
    expect(req.effort).toBe("high");
    expect(req.max_tokens).toBe(2000);
  });

  it("keeps a forced tool choice for Haiku 5.5, which accepts one", () => {
    const req = toolCallRequest({ model: "claude-haiku-5-5", toolName: "t", baseMaxTokens: 1000 });
    expect(req.tool_choice).toEqual({ type: "tool", name: "t" });
    expect(req.systemSuffix).toBe("");
  });

  it("always sends the 5.5 effort explicitly, using each model's default", () => {
    const sent = (model: string) =>
      toolCallRequest({ model, toolName: "t", baseMaxTokens: 1000 }).output_config;
    expect(sent("claude-sonnet-5-5")).toEqual({ effort: "high" });
    expect(sent("claude-opus-5-5")).toEqual({ effort: "medium" });
    expect(sent("claude-haiku-5-5")).toEqual({ effort: "medium" });
  });

  it("sends an explicit effort when one is asked for", () => {
    const req = toolCallRequest({
      model: "claude-sonnet-5-5",
      toolName: "t",
      baseMaxTokens: 1000,
      effort: "low",
    });
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.effort).toBe("low");
  });

  it("refuses an effort for a model that takes none, rather than dropping it", () => {
    expect(() =>
      toolCallRequest({
        model: "claude-sonnet-4-6",
        toolName: "t",
        baseMaxTokens: 1000,
        effort: "low",
      }),
    ).toThrow(/does not accept an effort setting/);
  });

  it("doubles the 5.5 output budget and passes a timeout once the SDK would refuse", () => {
    const req = toolCallRequest({
      model: "claude-sonnet-5-5",
      toolName: "t",
      baseMaxTokens: 16_384,
    });
    expect(req.max_tokens).toBe(32_768);
    expect(req.requestOptions).toEqual({ timeout: LONG_REQUEST_TIMEOUT_MS });
  });

  it("passes no timeout when the budget stays under the SDK's non-streaming limit", () => {
    const req = toolCallRequest({ model: "claude-haiku-5-5", toolName: "t", baseMaxTokens: 4096 });
    expect(req.max_tokens).toBe(8192);
    expect(req.requestOptions).toBeUndefined();
  });

  it("throws for a model with no profile", () => {
    expect(() => profileFor("claude-unregistered")).toThrow(/No request profile registered/);
    expect(() => profileFor("toString")).toThrow(/No request profile registered/);
  });
});

describe("profile coverage", () => {
  it("every configured stage model has a profile", () => {
    for (const stage of STAGES) {
      const { provider, model } = modelFor(stage);
      if (provider === "anthropic") expect(MODEL_PROFILES[model], `${stage}: ${model}`).toBeDefined();
    }
  });

  it("every profiled model has a rate and every Claude rate has a profile", () => {
    for (const model of Object.keys(MODEL_PROFILES)) expect(RATES[model], model).toBeDefined();
    for (const model of Object.keys(RATES).filter((m) => m.startsWith("claude-"))) {
      expect(MODEL_PROFILES[model], model).toBeDefined();
    }
  });
});

describe("effort overrides", () => {
  it("default to none", () => {
    expect(effortFor("extraction")).toBeUndefined();
  });

  it("replace rather than merge", () => {
    setEffortOverrides({ extraction: "low" });
    setEffortOverrides({ requirement_parsing: "high" });
    expect(getEffortOverrides()).toEqual({ requirement_parsing: "high" });
    expect(effortFor("extraction")).toBeUndefined();
  });

  it("clear", () => {
    setEffortOverrides({ extraction: "low" });
    clearEffortOverrides();
    expect(effortFor("extraction")).toBeUndefined();
  });
});
