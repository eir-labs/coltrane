// #183 — residual after #182. #182 added pipelineOrdered(T), a chair-scoped EXONERATION, but the
// cycle-check TRIGGER is still agent-global: `produces` is built from agent.output_types and the
// loop walks agent.input_types. So a type an agent globally produces AND consumes — but which NO
// chair in this standard realizes — still reaches the check, and pipelineOrdered returns false
// (zero chair-producers) rather than "not this standard's dataflow". The trigger must be
// chair-scoped too: a type is only a candidate cycle if a chair in THIS standard both produces
// and consumes it.
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

describe("#183 — the cycle-check trigger is chair-scoped, not agent-global", () => {
  it("a type in the agent's global I/O but realized by NO chair does not trip the cycle check", () => {
    // grant-reviewer's capability envelope can read+write compliance-report, but in grant-revision
    // its chairs only do rubric-score → submission-verdict. compliance-report is in no chair here.
    const reviewer = testAgent({
      slug: "grant-reviewer",
      primitives: ["INTERPRET", "JUDGE", "VERIFY"],
      input_types: ["compliance-report", "rubric-score"],
      output_types: ["compliance-report", "rubric-score", "submission-verdict"],
    });
    expect(() =>
      composeStandard({
        slug: "grant-revision-v1", domain: "demo", agents: [reviewer],
        phases: [
          { name: "score", chairs: [chair("score", "grant-reviewer", { output_contract: ["rubric-score"] })] } as PhaseDef,
          { name: "verdict", chairs: [chair("verdict", "grant-reviewer", { depends_on: ["score"], input_contract: ["rubric-score"], output_contract: ["submission-verdict"] })] } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("still rejects a genuine loop — a chair graph with mutual depends_on", () => {
    const dual = testAgent({ slug: "looper", primitives: ["INTERPRET"], input_types: ["x", "y"], output_types: ["x", "y"] });
    expect(() =>
      composeStandard({
        slug: "loopy", domain: "demo", agents: [dual],
        phases: [
          { name: "p1", chairs: [chair("a", "looper", { depends_on: ["b"], input_contract: ["y"], output_contract: ["x"] })] } as PhaseDef,
          { name: "p2", chairs: [chair("b", "looper", { depends_on: ["a"], input_contract: ["x"], output_contract: ["y"] })] } as PhaseDef,
        ],
      }),
    ).toThrow(/cycle|forward reference/i);
  });
});
