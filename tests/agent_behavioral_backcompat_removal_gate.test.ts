// ENFORCEMENT GUARD — behavioral fields are mandatory.
//
// This began as a deprecation gate (RED on purpose) while identity/method/constraints/
// disposition were optional. Now that the migration is done — the fields are required on
// AgentDef/Agent and every agent definition carries them — this guard is GREEN and stays
// green: it asserts the requirement can't silently regress back to optional. defineAgent
// must reject an agent with no behavioral representation rather than run it hollow.
import { describe, it, expect } from "vitest";
import { defineAgent, type AgentDef } from "../src";

describe("behavioral fields are mandatory (no optional escape hatch)", () => {
  it("rejects an agent defined with no identity/method/disposition", () => {
    // cast past the compile-time guard to prove the RUNTIME validation also rejects it
    expect(() =>
      defineAgent({
        slug: "lean-agent",
        primitives: ["INTERPRET"],
        input_types: [],
        output_types: ["Interpretation"],
      } as unknown as AgentDef),
    ).toThrow(/identity|method|behavioral/i);
  });
});
