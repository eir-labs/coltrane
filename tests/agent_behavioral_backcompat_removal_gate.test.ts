// DEPRECATION GATE — intentionally RED. Do not "fix" it by weakening the assertion.
//
// This test fails on purpose and is SUPPOSED to keep failing until the very last step of
// the behavioral-representation work: after identity/method are wired end to end (ingest
// -> persist -> load -> render, see agent_behavioral_representation.test.ts) AND that
// replacement is proven green, the transitional BACK-COMPAT must be removed — namely the
// affordance that lets an agent exist with no identity/method (the optional fields on
// AgentDef/Agent that keep today's lean agents loading during the migration).
//
// This gate goes GREEN only when that back-compat is gone:
//   - identity and method become REQUIRED to define an agent (defineAgent rejects a lean one)
//   - every existing agent definition has been migrated to carry them
//
// WHEN THIS TURNS GREEN, also delete the transitional back-compat test
// "omits the behavioral layers cleanly when an agent declares none (back-compat)" in
// tests/agent_behavioral_representation.test.ts — it asserts the affordance this gate
// exists to remove, and the two cannot both be green.
import { describe, it, expect } from "vitest";
import { defineAgent } from "../src";

describe("BACK-COMPAT REMOVAL GATE (expected RED until cleanup)", () => {
  it("rejects an agent defined with no identity and no method — behavioral fields are mandatory", () => {
    expect(() =>
      defineAgent({
        slug: "lean-agent",
        primitives: ["INTERPRET"],
        input_types: [],
        output_types: ["Interpretation"],
        // no identity, no method — the transitional back-compat must be gone for this to throw
      }),
    ).toThrow(/identity|method|behavioral/i);
  });
});
