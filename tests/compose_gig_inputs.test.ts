// #177 — composeStandard's agent-level primitive-graph gates must accept faithful agents
// whose inputs arrive from OUTSIDE the standard (gig-level / cross-standard inputs), and
// standalone-CREATE agents whose reasoner is supplied by such an input. The fix: a standard
// declares its gig contract via standard-level `input_types`; those count as "available
// upstream" for the input gate, and a consumed standard-input counts as the CREATE gate's
// upstream reasoner. The chair contracts remain the authoritative per-role dataflow.
import { describe, it, expect } from "vitest";
import { composeStandard, type PhaseDef, type Chair } from "../src/composition.js";
import { testAgent } from "./_support/agents.js";

const chair = (role: string, agent_slug: string, output_contract: string[] = []): Chair => ({
  role, agent_slug, depends_on: [], input_contract: [], output_contract, required_skills: [],
});

describe("composeStandard — gig/standard inputs satisfy the agent-level gates (#177)", () => {
  it("input gate: a downstream input declared as a standard-level (gig) input composes", () => {
    const root = testAgent({ slug: "root", primitives: ["SENSE"], input_types: [], output_types: ["sig"] });
    // consumer legitimately consumes `gig-thing` (produced in another standard, arriving as gig input)
    const consumer = testAgent({ slug: "consumer", primitives: ["INTERPRET"], input_types: ["sig", "gig-thing"], output_types: ["interp"] });
    expect(() =>
      composeStandard({
        slug: "s-input", domain: "demo", agents: [root, consumer],
        input_types: ["gig-thing"],
        phases: [
          { name: "sense", chairs: [chair("root", "root", ["sig"])] } as PhaseDef,
          { name: "interpret", chairs: [chair("c", "consumer", ["interp"])] } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("CREATE gate: a standalone-CREATE agent fed by a standard (gig) input composes", () => {
    const maker = testAgent({ slug: "maker", primitives: ["CREATE"], input_types: ["gig-spec"], output_types: ["artifact-x"] });
    expect(() =>
      composeStandard({
        slug: "s-create", domain: "demo", agents: [maker],
        input_types: ["gig-spec"],
        phases: [{ name: "make", chairs: [chair("make", "maker", ["artifact-x"])] } as PhaseDef],
      }),
    ).not.toThrow();
  });

  it("no regression: an input neither produced upstream nor a declared standard input still fails", () => {
    const root = testAgent({ slug: "root2", primitives: ["SENSE"], input_types: [], output_types: ["sig"] });
    const consumer = testAgent({ slug: "consumer2", primitives: ["INTERPRET"], input_types: ["sig", "from-nowhere"], output_types: ["interp"] });
    expect(() =>
      composeStandard({
        slug: "s-bad", domain: "demo", agents: [root, consumer],
        input_types: [],
        phases: [
          { name: "sense", chairs: [chair("root", "root2", ["sig"])] } as PhaseDef,
          { name: "interpret", chairs: [chair("c", "consumer2", ["interp"])] } as PhaseDef,
        ],
      }),
    ).toThrow(/from-nowhere not produced upstream/);
  });

  it("no regression: standalone CREATE with no upstream reasoner and no gig input still fails", () => {
    const maker = testAgent({ slug: "maker2", primitives: ["CREATE"], input_types: [], output_types: ["artifact-y"] });
    expect(() =>
      composeStandard({
        slug: "s-create-bad", domain: "demo", agents: [maker],
        input_types: [],
        phases: [{ name: "make", chairs: [chair("make", "maker2", ["artifact-y"])] } as PhaseDef],
      }),
    ).toThrow(/starts with CREATE but no upstream/);
  });
});
