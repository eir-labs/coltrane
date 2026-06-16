// #188 — the per-placement input-availability check in composeStandard reads the agent's GLOBAL
// input_types, not the chair's input_contract. So an agent reused across chairs (one consuming a
// lean subset early, one consuming more later) is rejected at the EARLY chair on a type only its
// LATER chair needs. Same global-vs-chair family already fixed for output sealing (#174), the
// input gate's gig-contract seeding (#177), and the cycle check (#181/#183) — this is the fourth:
// the input check must read the CHAIR's input_contract (the types it actually consumes), checked
// against upstream-produced ∪ standard.input_types. agent.input_types is a capability envelope.
import { describe, it, expect } from "vitest";
import { composeStandard, type PhaseDef, type Chair } from "../src/composition.js";
import { testAgent } from "./_support/agents.js";

const chair = (role: string, agent_slug: string, opts: Partial<Chair> = {}): Chair => ({
  role, agent_slug,
  depends_on: opts.depends_on ?? [],
  input_contract: opts.input_contract ?? [],
  output_contract: opts.output_contract ?? [],
  required_skills: [],
});

describe("#188 — per-placement input check is chair-scoped, not agent-global", () => {
  it("an agent reused across two chairs composes; the early chair isn't blocked by a later chair's type", () => {
    // planner consumes `spec` early (blueprint) and `spec`+`draft` later (revise). Global input_types
    // is the union ["spec","draft"]; the blueprint chair only consumes `spec`.
    const speccer = testAgent({ slug: "speccer", primitives: ["INTERPRET"], input_types: [], output_types: ["spec"] });
    const planner = testAgent({ slug: "planner", primitives: ["INTERPRET", "PLAN"], input_types: ["spec", "draft"], output_types: ["plan"] });
    const maker = testAgent({ slug: "maker", primitives: ["INTERPRET"], input_types: ["plan"], output_types: ["draft"] });
    expect(() =>
      composeStandard({
        slug: "demo", domain: "demo", agents: [speccer, planner, maker],
        phases: [
          { name: "interpret", chairs: [chair("interpret", "speccer", { output_contract: ["spec"] })] } as PhaseDef,
          { name: "blueprint", chairs: [chair("blueprint", "planner", { depends_on: ["interpret"], input_contract: ["spec"], output_contract: ["plan"] })] } as PhaseDef,
          { name: "make", chairs: [chair("make", "maker", { depends_on: ["blueprint"], input_contract: ["plan"], output_contract: ["draft"] })] } as PhaseDef,
          { name: "revise", chairs: [chair("revise", "planner", { depends_on: ["interpret", "make"], input_contract: ["spec", "draft"], output_contract: ["plan"] })] } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("an agent's global input_types entry that no chair consumes does not block the standard", () => {
    // reviewer can consume `match` in other standards, but this one never produces or consumes it.
    const root = testAgent({ slug: "root", primitives: ["INTERPRET"], input_types: [], output_types: ["spec"] });
    const reviewer = testAgent({ slug: "reviewer", primitives: ["INTERPRET"], input_types: ["spec", "match"], output_types: ["review"] });
    expect(() =>
      composeStandard({
        slug: "no-match", domain: "demo", agents: [root, reviewer],
        phases: [
          { name: "a", chairs: [chair("a", "root", { output_contract: ["spec"] })] } as PhaseDef,
          { name: "b", chairs: [chair("b", "reviewer", { depends_on: ["a"], input_contract: ["spec"], output_contract: ["review"] })] } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("regression: a chair consuming a type produced by NO upstream chair still fails", () => {
    const root = testAgent({ slug: "r2", primitives: ["INTERPRET"], input_types: [], output_types: ["spec"] });
    const consumer = testAgent({ slug: "c2", primitives: ["INTERPRET"], input_types: ["spec", "ghost"], output_types: ["out"] });
    expect(() =>
      composeStandard({
        slug: "bad", domain: "demo", agents: [root, consumer],
        phases: [
          { name: "a", chairs: [chair("a", "r2", { output_contract: ["spec"] })] } as PhaseDef,
          { name: "b", chairs: [chair("b", "c2", { depends_on: ["a"], input_contract: ["spec", "ghost"], output_contract: ["out"] })] } as PhaseDef,
        ],
      }),
    ).toThrow(/ghost/);
  });
});
