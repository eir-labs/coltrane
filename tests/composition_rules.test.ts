import { describe, it, expect } from "vitest";
import { defineAgent, composeStandard } from "../src";

describe("agent composition: illegal progressions", () => {
  it("rejects in-agent CREATE after SENSE without intermediate INTERPRET or PLAN", () => {
    expect(() =>
      defineAgent({ slug: "a", primitives: ["SENSE", "CREATE"] }),
    ).toThrow();
  });

  it("accepts standalone VERIFY (cross-phase target check happens at composeStandard)", () => {
    expect(() =>
      defineAgent({ slug: "a", primitives: ["VERIFY"] }),
    ).not.toThrow();
  });

  it("accepts CREATE after INTERPRET", () => {
    expect(() =>
      defineAgent({ slug: "a", primitives: ["INTERPRET", "CREATE"] }),
    ).not.toThrow();
  });

  it("accepts CREATE after PLAN", () => {
    expect(() =>
      defineAgent({ slug: "a", primitives: ["PLAN", "CREATE"] }),
    ).not.toThrow();
  });

  it("accepts VERIFY with an upstream target", () => {
    expect(() =>
      defineAgent({ slug: "a", primitives: ["JUDGE", "VERIFY"] }),
    ).not.toThrow();
  });
});

describe("standard composition: cross-phase §3", () => {
  it("rejects a standard whose first CREATE phase has no upstream INTERPRET or PLAN", () => {
    const sensor = defineAgent({ slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"] });
    const creator = defineAgent({ slug: "creator", primitives: ["CREATE"], input_types: ["raw-note"], output_types: ["artifact"] });
    expect(() =>
      composeStandard({
        slug: "no-reasoning",
        domain: "eirtests",
        agents: [sensor, creator],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "make", agent: "creator" },
        ],
      }),
    ).toThrow();
  });

  it("accepts a standard where an upstream phase supplies PLAN before a CREATE phase", () => {
    const planner = defineAgent({ slug: "planner", primitives: ["PLAN"], output_types: ["plan-doc"] });
    const creator = defineAgent({ slug: "creator", primitives: ["CREATE"], input_types: ["plan-doc"], output_types: ["artifact"] });
    expect(() =>
      composeStandard({
        slug: "with-plan",
        domain: "eirtests",
        agents: [planner, creator],
        phases: [
          { name: "plan", agent: "planner" },
          { name: "make", agent: "creator" },
        ],
      }),
    ).not.toThrow();
  });
});

describe("standard composition: cycles", () => {
  it("rejects circular type dependencies", () => {
    const a = defineAgent({
      slug: "a",
      primitives: ["INTERPRET"],
      input_types: ["x"],
      output_types: ["y"],
    });
    const b = defineAgent({
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
          { name: "a", agent: "a" },
          { name: "b", agent: "b" },
        ],
      }),
    ).toThrow();
  });
});

describe("standard compositions named in the spec", () => {
  it("Analyst composes SENSE + INTERPRET + JUDGE", () => {
    expect(() =>
      defineAgent({
        slug: "analyst",
        primitives: ["SENSE", "INTERPRET", "JUDGE"],
      }),
    ).not.toThrow();
  });

  it("Reviewer composes JUDGE + VERIFY", () => {
    expect(() =>
      defineAgent({ slug: "reviewer", primitives: ["JUDGE", "VERIFY"] }),
    ).not.toThrow();
  });

  it("Builder composes PLAN + CREATE + VERIFY", () => {
    expect(() =>
      defineAgent({
        slug: "builder",
        primitives: ["PLAN", "CREATE", "VERIFY"],
      }),
    ).not.toThrow();
  });

  it("Explorer composes SENSE + INTERPRET + PLAN", () => {
    expect(() =>
      defineAgent({
        slug: "explorer",
        primitives: ["SENSE", "INTERPRET", "PLAN"],
      }),
    ).not.toThrow();
  });

  it("Reporter composes INTERPRET + CREATE", () => {
    expect(() =>
      defineAgent({ slug: "reporter", primitives: ["INTERPRET", "CREATE"] }),
    ).not.toThrow();
  });

  it("Full-Chain composes all six primitives", () => {
    expect(() =>
      defineAgent({
        slug: "full",
        primitives: ["SENSE", "INTERPRET", "JUDGE", "PLAN", "CREATE", "VERIFY"],
      }),
    ).not.toThrow();
  });
});
