// RED-first contract tests — restore tier→model resolution (full regression map).
//
// Old runtime mapped AgentProfile.model_tier (economy/standard/premium) to a concrete
// model via MODEL_TIER_MAP (haiku/sonnet/opus). The new invoker (makeClaudeInvoker)
// applies a single static opts.model to EVERY agent and ignores model_tier — which also
// dead-ends the learner's tier-downgrade proposals (it tunes a knob nothing reads).
//
// These pin the observable contract without hardcoding model IDs (the exact map is an
// implementation choice): an agent's model_tier must drive the spawned --model, so two
// agents on different tiers spawn on different models even under the same invoker default.
import { describe, it, expect } from "vitest";
import { makeClaudeInvoker } from "../src/claude_invoker.js";
import type { Agent, AgentInvocationContext } from "../src";

function spawnArgs(agent: Agent, invokerModel?: string): string[] {
  let captured: string[] = [];
  const invoker = makeClaudeInvoker({
    model: invokerModel,
    run: (_bin, args) => {
      captured = args;
      return '{"ok":true}';
    },
  });
  const ctx: AgentInvocationContext = { agent, phase: "p", inputs: [], gig_input: {} };
  void invoker(ctx);
  return captured;
}
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (over: Partial<Agent>): Agent => ({
  slug: "a", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "d", ...over,
});

describe("agent model_tier resolves to a concrete spawn model", () => {
  it("an agent's model_tier drives the spawned --model", () => {
    const args = spawnArgs(base({ model_tier: "premium" }));
    expect(flag(args, "--model"), "no --model resolved from model_tier").toBeTruthy();
  });

  it("different tiers spawn on different models (premium != economy), even under one invoker default", () => {
    const premium = flag(spawnArgs(base({ model_tier: "premium" }), "default-model"), "--model");
    const economy = flag(spawnArgs(base({ model_tier: "economy" }), "default-model"), "--model");
    expect(premium).not.toBe(economy);
  });

  it("model_tier takes precedence over the invoker's static default model", () => {
    const args = spawnArgs(base({ model_tier: "economy" }), "static-default");
    expect(flag(args, "--model")).not.toBe("static-default");
  });
});
