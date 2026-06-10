// RED-first contract tests — depth / tuning reaches the prompt (full regression map).
//
// Old runtime rendered a Depth line in the Context layer (skim/quick/standard/deep) and
// used depth as a tuning knob. The new buildPrompt renders no depth at all, and the
// merged agent's depth_profile (absorbed from AgentProfile) has no reader. These pin the
// agent's depth/tuning back into the rendered prompt.
import { describe, it, expect } from "vitest";
import { buildPrompt } from "../src";
import type { Agent, AgentInvocationContext } from "../src";

const base = (over: Partial<Agent>): Agent => ({
  slug: "a", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "d", ...over,
});
const ctx = (agent: Agent): AgentInvocationContext => ({ agent, phase: "p", inputs: [], gig_input: {} });

describe("an agent's depth_profile is surfaced as tuning in the prompt", () => {
  it("renders the depth tier when the agent declares one", () => {
    const p = buildPrompt(ctx(base({ depth_profile: "deep" })));
    expect(p).toMatch(/depth/i);
    expect(p).toContain("deep");
  });

  it("different depths render differently (the knob is read, not ignored)", () => {
    const skim = buildPrompt(ctx(base({ depth_profile: "skim" })));
    const deep = buildPrompt(ctx(base({ depth_profile: "deep" })));
    expect(skim).not.toBe(deep);
    expect(skim).toContain("skim");
  });
});
