// #181 — the agent-level producer/consumer cycle check (composition.ts) reasons over
// agent-GLOBAL input_types/output_types, not the chair dataflow. A multi-skill agent seated in
// several chairs — one producing type T, a later one consuming T via depends_on — collapses to a
// single node and gets flagged as a self-cycle, even though the CHAIRS are strictly acyclic. This
// is the same global-vs-chair mismatch already fixed for output sealing (#174) and the input gate
// (#177); the cycle check is the third gate. The role DAG (depends_on) is the authoritative
// dataflow and is already validated acyclic separately — the type-level check must defer to it.
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

describe("#181 — the cycle check is chair-scoped, not agent-global", () => {
  it("a multi-skill reviewer producing T in one chair and consuming T in a later chair composes", () => {
    // one agent, three chairs: compliance → rubric (depends_on compliance, reads its report) →
    // verdict. Role-scoped this is a clean acyclic line; agent-global it reads as reviewer→reviewer.
    const reviewer = testAgent({
      slug: "grant-reviewer",
      primitives: ["SENSE", "JUDGE", "VERIFY"],
      input_types: ["compliance-report", "rubric-score"],
      output_types: ["compliance-report", "rubric-score", "grant-verdict"],
    });
    expect(() =>
      composeStandard({
        slug: "grant-review-v1", domain: "demo", agents: [reviewer],
        phases: [
          { name: "compliance", chairs: [chair("compliance", "grant-reviewer", { output_contract: ["compliance-report"] })] } as PhaseDef,
          { name: "rubric", chairs: [chair("rubric", "grant-reviewer", { depends_on: ["compliance"], input_contract: ["compliance-report"], output_contract: ["rubric-score"] })] } as PhaseDef,
          { name: "verdict", chairs: [chair("verdict", "grant-reviewer", { depends_on: ["rubric"], input_contract: ["rubric-score"], output_contract: ["grant-verdict"] })] } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("still rejects a genuine loop — a chair graph with mutual depends_on", () => {
    // a → b and b → a is a real cycle; the chair DAG must still reject it (it always did).
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
