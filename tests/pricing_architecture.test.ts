import { describe, it, expect } from "vitest";
import { DEPTH_MULTIPLIER, MODEL_MULTIPLIER, computeCredits } from "../src";

describe("depth multiplier", () => {
  it("matches the spec profile", () => {
    expect(DEPTH_MULTIPLIER).toEqual({ skim: 0.5, quick: 0.75, standard: 1.0, deep: 2.0 });
  });
});

describe("model multiplier", () => {
  it("matches the spec profile", () => {
    expect(MODEL_MULTIPLIER).toEqual({ economy: 0.5, standard: 1.0, premium: 2.0 });
  });
});

describe("credit formula", () => {
  const base = { base_cost: 10, depth: "standard", model_tier: "standard", agents: 4, external_tool_calls: 0 } as const;

  it("multiplies base by depth and model, then adds per-agent and tool costs", () => {
    expect(computeCredits(base)).toBeCloseTo(12, 10);
  });

  it("adds 0.5 per agent", () => {
    expect(computeCredits({ ...base, agents: 6 })).toBeCloseTo(13, 10);
  });

  it("adds 0.1 per external tool call", () => {
    expect(computeCredits({ ...base, external_tool_calls: 10 })).toBeCloseTo(13, 10);
  });

  it("increases with depth", () => {
    expect(computeCredits({ ...base, depth: "deep" })).toBeGreaterThan(computeCredits(base));
  });

  it("increases with model tier", () => {
    expect(computeCredits({ ...base, model_tier: "premium" })).toBeGreaterThan(computeCredits(base));
  });
});
