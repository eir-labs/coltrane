import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { defineAgent, composeStandard } from "../src";

describe("agent composition: illegal progressions", () => {
  it("rejects in-agent CREATE after SENSE without intermediate INTERPRET or PLAN", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "a", primitives: ["SENSE", "CREATE"] }),
    ).toThrow();
  });

  it("accepts standalone VERIFY (cross-phase target check happens at composeStandard)", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "a", primitives: ["VERIFY"] }),
    ).not.toThrow();
  });

  it("accepts CREATE after INTERPRET", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "a", primitives: ["INTERPRET", "CREATE"] }),
    ).not.toThrow();
  });

  it("accepts CREATE after PLAN", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "a", primitives: ["PLAN", "CREATE"] }),
    ).not.toThrow();
  });

  it("accepts VERIFY with an upstream target", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "a", primitives: ["JUDGE", "VERIFY"] }),
    ).not.toThrow();
  });
});

describe("standard composition: cross-phase §3", () => {
  it("rejects a standard whose first CREATE phase has no upstream INTERPRET or PLAN", () => {
    const sensor = defineAgent({ ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"] });
    const creator = defineAgent({ ...TEST_BEHAVIOR, slug: "creator", primitives: ["CREATE"], input_types: ["raw-note"], output_types: ["artifact"] });
    expect(() =>
      composeStandard({
        slug: "no-reasoning",
        domain: "eirtests",
        agents: [sensor, creator],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
          { name: "make", chairs: [{ role: "make", agent_slug: "creator", depends_on: [], input_contract: [], output_contract: ["artifact"], required_skills: [] }] },
        ],
      }),
    ).toThrow();
  });

  it("accepts a standard where an upstream phase supplies PLAN before a CREATE phase", () => {
    const planner = defineAgent({ ...TEST_BEHAVIOR, slug: "planner", primitives: ["PLAN"], output_types: ["plan-doc"] });
    const creator = defineAgent({ ...TEST_BEHAVIOR, slug: "creator", primitives: ["CREATE"], input_types: ["plan-doc"], output_types: ["artifact"] });
    expect(() =>
      composeStandard({
        slug: "with-plan",
        domain: "eirtests",
        agents: [planner, creator],
        phases: [
          { name: "plan", chairs: [{ role: "plan", agent_slug: "planner", depends_on: [], input_contract: [], output_contract: ["plan-doc"], required_skills: [] }] },
          { name: "make", chairs: [{ role: "make", agent_slug: "creator", depends_on: [], input_contract: [], output_contract: ["artifact"], required_skills: [] }] },
        ],
      }),
    ).not.toThrow();
  });
});

describe("standard composition: cycles", () => {
  it("rejects circular type dependencies", () => {
    // A circular dependency is expressed through the CHAIR dataflow (depends_on), which is the
    // authoritative graph — not the agents' global I/O envelopes (#181/#183). chair a depends_on
    // b and b depends_on a: a genuine loop the role DAG rejects (here as a forward reference,
    // since each points at a later phase). Agent-global I/O alone no longer conjures a cycle.
    const a = defineAgent({ ...TEST_BEHAVIOR,
      slug: "a",
      primitives: ["INTERPRET"],
      input_types: ["x"],
      output_types: ["y"],
    });
    const b = defineAgent({ ...TEST_BEHAVIOR,
      slug: "b",
      primitives: ["INTERPRET"],
      input_types: ["y"],
      output_types: ["x"],
    });
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "eirtests",
        agents: [a, b],
        phases: [
          { name: "a", chairs: [{ role: "a", agent_slug: "a", depends_on: ["b"], input_contract: ["x"], output_contract: ["y"], required_skills: [] }] },
          { name: "b", chairs: [{ role: "b", agent_slug: "b", depends_on: ["a"], input_contract: ["y"], output_contract: ["x"], required_skills: [] }] },
        ],
      }),
    ).toThrow(/cycle|forward reference/i);
  });
});

describe("standard compositions named in the spec", () => {
  it("Analyst composes SENSE + INTERPRET + JUDGE", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR,
        slug: "analyst",
        primitives: ["SENSE", "INTERPRET", "JUDGE"],
      }),
    ).not.toThrow();
  });

  it("Reviewer composes JUDGE + VERIFY", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "reviewer", primitives: ["JUDGE", "VERIFY"] }),
    ).not.toThrow();
  });

  it("Builder composes PLAN + CREATE + VERIFY", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR,
        slug: "builder",
        primitives: ["PLAN", "CREATE", "VERIFY"],
      }),
    ).not.toThrow();
  });

  it("Explorer composes SENSE + INTERPRET + PLAN", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR,
        slug: "explorer",
        primitives: ["SENSE", "INTERPRET", "PLAN"],
      }),
    ).not.toThrow();
  });

  it("Reporter composes INTERPRET + CREATE", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR, slug: "reporter", primitives: ["INTERPRET", "CREATE"] }),
    ).not.toThrow();
  });

  it("Full-Chain composes all six primitives", () => {
    expect(() =>
      defineAgent({ ...TEST_BEHAVIOR,
        slug: "full",
        primitives: ["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"],
      }),
    ).not.toThrow();
  });
});
