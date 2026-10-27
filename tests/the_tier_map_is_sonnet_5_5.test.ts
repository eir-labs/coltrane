// THE TIER MAP IS THE 5.5 FAMILY, AND PREMIUM IS SONNET — by Eugene's word, 27 Oct 2026:
// "SONNET FOR PREMIUM TOO."
//
// The map is the only place a tier resolves to a model (spec_honest_model_stamp): the spawn reads it
// through resolveModel and the runtime stamps the sealed output through the same function. So the
// ruling is pinned HERE, at the one source, and then followed to the spawn's own --model flag — a map
// that says Sonnet while the argv says something else would be the disconnected-wire defect.
//
// The untiered seat used to fall through to the operator's personal `claude` default when no
// COLTRANE_MODEL was set: a model nobody in the record chose. It now resolves to DEFAULT_CHAIR_MODEL.
// COLTRANE_MODEL still wins for an untiered seat, because an operator's explicit pin is a choice.
import { describe, it, expect } from "vitest";
import { testAgent } from "./_support/agents.js";
import {
  MODEL_TIER_MAP,
  DEFAULT_CHAIR_MODEL,
  resolveModel,
  makeClaudeInvoker,
  type Agent,
  type AgentInvocationContext,
} from "../src";

function spawnModel(agent: Agent, staticModel?: string): string | undefined {
  let captured: string[] = [];
  const invoker = makeClaudeInvoker({
    ...(staticModel !== undefined ? { model: staticModel } : {}),
    run: (_b, args) => { captured = args; return '{"ok":true}'; },
  });
  void invoker({ agent, phase: "p", inputs: [], gig_input: {} } as AgentInvocationContext);
  const i = captured.indexOf("--model");
  return i >= 0 ? captured[i + 1] : undefined;
}

function agentAt(model_tier?: "economy" | "standard" | "premium"): Agent {
  return testAgent({
    slug: "tier-probe",
    primitives: ["INTERPRET"],
    input_types: [],
    output_types: ["Interpretation"],
    domain: "demo",
    ...(model_tier ? { model_tier } : {}),
  } as Parameters<typeof testAgent>[0]);
}

describe("the tier map is the 5.5 family, and premium is Sonnet 5.5", () => {
  it("M1: the map is exactly economy haiku-5-5, standard sonnet-5-5, premium sonnet-5-5", () => {
    expect(MODEL_TIER_MAP).toEqual({
      economy: "claude-haiku-5-5",
      standard: "claude-sonnet-5-5",
      premium: "claude-sonnet-5-5",
    });
  });

  it("M2: an untiered seat's default is claude-sonnet-5-5", () => {
    expect(DEFAULT_CHAIR_MODEL).toBe("claude-sonnet-5-5");
  });

  it("M3: resolveModel answers claude-sonnet-5-5 for standard, premium and no tier", () => {
    expect(resolveModel("standard", undefined)).toBe("claude-sonnet-5-5");
    expect(resolveModel("premium", undefined)).toBe("claude-sonnet-5-5");
    expect(resolveModel(undefined, undefined)).toBe("claude-sonnet-5-5");
    expect(resolveModel("economy", undefined)).toBe("claude-haiku-5-5");
  });

  it("M4: an operator's COLTRANE_MODEL still seats an untiered agent, and never overrides a tier", () => {
    expect(resolveModel(undefined, "operator-pin")).toBe("operator-pin");
    expect(resolveModel("premium", "operator-pin")).toBe("claude-sonnet-5-5");
  });

  it("M5: the spawn's own --model carries the ruling (premium, standard, untiered)", () => {
    expect(spawnModel(agentAt("premium"))).toBe("claude-sonnet-5-5");
    expect(spawnModel(agentAt("standard"))).toBe("claude-sonnet-5-5");
    expect(spawnModel(agentAt())).toBe("claude-sonnet-5-5");
    expect(spawnModel(agentAt("economy"))).toBe("claude-haiku-5-5");
  });
});
