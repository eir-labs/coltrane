// Chairs in Coltrane OSS — TDD contract tests.
//
// Today's PhaseDef is `{ name, agent }`. This feature changes it to
// `{ name, chairs: Chair[] }` where chairs is REQUIRED (length ≥ 1) and
// each chair carries (role, agent_slug, depends_on, input_contract,
// output_contract, required_skills). agent_slug at PhaseDef level is removed.
//
// These tests are RED-honest. Each test names the behavior the implementation
// must satisfy; nothing here implements the change. Tests flip GREEN
// incrementally as the schema / composition / runtime / migration commits land.

import { describe, it, expect } from "vitest";
import {
  defineAgent,
  composeStandard,
  CompositionError,
  type Chair,
  type PhaseDef,
} from "../src";

function agent(
  slug: string,
  opts: Partial<{
    skill_slugs: string[];
    input_types: string[];
    output_types: string[];
  }> = {},
) {
  return defineAgent({
    slug,
    primitives: ["INTERPRET"],
    input_types: opts.input_types ?? ["Signal"],
    output_types: opts.output_types ?? ["Interpretation"],
    skill_slugs: opts.skill_slugs ?? [],
  });
}

function chair(
  role: string,
  agent_slug: string,
  opts: Partial<Chair> = {},
): Chair {
  return {
    role,
    agent_slug,
    depends_on: opts.depends_on ?? [],
    input_contract: opts.input_contract ?? [],
    output_contract: opts.output_contract ?? ["Interpretation"],
    required_skills: opts.required_skills ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema (compose-time validation) — 12 tests
// ─────────────────────────────────────────────────────────────────────────────

describe("chairs — schema (compose-time)", () => {
  it("accepts a single-chair phase", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [{ name: "p1", chairs: [chair("solo", "a")] } as PhaseDef],
      }),
    ).not.toThrow();
  });

  it("accepts a multi-chair phase", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "fan-out",
            chairs: [chair("r1", "a"), chair("r2", "a"), chair("r3", "a")],
          } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("accepts cross-phase depends_on", () => {
    const a = agent("a", { output_types: ["Interpretation"] });
    const b = agent("b", { input_types: ["Interpretation"], output_types: ["Plan"] });
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a, b],
        phases: [
          {
            name: "p1",
            chairs: [chair("upstream", "a", { output_contract: ["Interpretation"] })],
          } as PhaseDef,
          {
            name: "p2",
            chairs: [
              chair("downstream", "b", {
                depends_on: ["upstream"],
                input_contract: ["Interpretation"],
                output_contract: ["Plan"],
              }),
            ],
          } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("rejects empty chairs array", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [{ name: "p1", chairs: [] } as PhaseDef],
      }),
    ).toThrow(CompositionError);
  });

  it("rejects duplicate role within a phase", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          { name: "p1", chairs: [chair("dup", "a"), chair("dup", "a")] } as PhaseDef,
        ],
      }),
    ).toThrow(/duplicate role/i);
  });

  it("rejects duplicate role across phases of same standard", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          { name: "p1", chairs: [chair("same", "a")] } as PhaseDef,
          { name: "p2", chairs: [chair("same", "a")] } as PhaseDef,
        ],
      }),
    ).toThrow(/duplicate role/i);
  });

  it("rejects cycle in depends_on", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [
              chair("A", "a", { depends_on: ["B"] }),
              chair("B", "a", { depends_on: ["A"] }),
            ],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/cycle/i);
  });

  it("rejects self-referencing depends_on", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [chair("A", "a", { depends_on: ["A"] })],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/cycle|self/i);
  });

  it("rejects forward reference (depends_on points to a role in a later phase)", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [chair("upstream", "a", { depends_on: ["downstream"] })],
          } as PhaseDef,
          { name: "p2", chairs: [chair("downstream", "a")] } as PhaseDef,
        ],
      }),
    ).toThrow(/forward|undeclared|unknown role/i);
  });

  it("rejects unknown role in depends_on", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [chair("A", "a", { depends_on: ["nonexistent"] })],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/unknown role|undeclared/i);
  });

  it("rejects chair with agent_slug not in standard's agents list", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [{ name: "p1", chairs: [chair("A", "nope")] } as PhaseDef],
      }),
    ).toThrow(/unknown agent|not in standard/i);
  });

  it("rejects chair requiring a skill the agent doesn't declare", () => {
    const a = agent("a", { skill_slugs: ["sk1"] });
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [chair("A", "a", { required_skills: ["sk2"] })],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/skill|not declared/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Type contracts (input_contract / output_contract) — 3 tests
// ─────────────────────────────────────────────────────────────────────────────

describe("chairs — type contracts", () => {
  it("rejects chair whose input_contract is not satisfied by upstream chairs", () => {
    const a = agent("a", { output_types: ["Interpretation"] });
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [
              chair("solo", "a", {
                input_contract: ["NeverProducedType"],
                output_contract: ["Interpretation"],
              }),
            ],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/input_contract|not satisfied|not produced/i);
  });

  it("accepts chair whose input_contract is satisfied by an upstream chair", () => {
    const a = agent("a", { output_types: ["Interpretation"] });
    const b = agent("b", { input_types: ["Interpretation"], output_types: ["Plan"] });
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a, b],
        phases: [
          {
            name: "p1",
            chairs: [
              chair("first", "a", { output_contract: ["Interpretation"] }),
              chair("second", "b", {
                depends_on: ["first"],
                input_contract: ["Interpretation"],
                output_contract: ["Plan"],
              }),
            ],
          } as PhaseDef,
        ],
      }),
    ).not.toThrow();
  });

  it("rejects chair with empty output_contract", () => {
    const a = agent("a");
    expect(() =>
      composeStandard({
        slug: "s",
        domain: "test",
        agents: [a],
        phases: [
          {
            name: "p1",
            chairs: [chair("solo", "a", { output_contract: [] })],
          } as PhaseDef,
        ],
      }),
    ).toThrow(/output_contract|empty/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime dispatch — 7 tests, RED until runtime change lands
// ─────────────────────────────────────────────────────────────────────────────

describe("chairs — runtime dispatch", () => {
  it.todo(
    "single-chair phase runs identically to today's single-agent phase (regression)",
  );
  it.todo("multi-chair phase dispatches all parallel-eligible chairs concurrently");
  it.todo(
    "depends_on respected: chair starts only after every upstream chair completes",
  );
  it.todo("cross-phase depends_on works (chair in phase N depends on chair in phase 0..N-1)");
  it.todo("phase aborts if any chair fails and names the failing chair");
  it.todo("input_contract present in upstream outputs before invocation, else error");
  it.todo("output_contract produced after invocation, else error");

  // fan-in cardinality — N upstream chairs all produce same type, 1 downstream consumes all N
  it.todo(
    "fan-in completeness: a chair with depends_on of N upstream chairs starts only after ALL N produce their output_contract",
  );
  it.todo(
    "fan-in: if any 1 of N upstream chairs fails, the downstream chair does not run and the phase aborts naming the failing upstream",
  );
  it.todo(
    "fan-in: downstream chair receives outputs from all N upstream chairs in its input scope (not just the first to complete)",
  );
  it.todo(
    "fan-in: ordering of N parallel upstream chairs is not observable downstream (commutative; consumer treats them as a set)",
  );
  it.todo(
    "fan-in: each upstream chair's output is distinguishable downstream by source role (consumer can address them individually)",
  );
  it.todo(
    "fan-in: partial completion is never visible — the downstream chair never sees fewer than N upstream outputs",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration — 4 tests, RED until codemod runs
// ─────────────────────────────────────────────────────────────────────────────

describe("chairs — migration", () => {
  it.todo("codemod converts existing phase.agent='X' to single-chair phase");
  it.todo("codemod fails loudly on unconvertable standards");
  it.todo(
    "loader rejects any standard JSON containing legacy phase.agent after migration",
  );
  it.todo(
    "full vitest suite still passes after codemod across all existing standards",
  );
});
