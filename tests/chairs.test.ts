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
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  defineAgent,
  composeStandard,
  CompositionError,
  runGig,
  RuntimeError,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type Chair,
  type PhaseDef,
  type DomainType,
  type AgentInvoker,
} from "../src";

function agent(
  slug: string,
  opts: Partial<{
    skill_slugs: string[];
    input_types: string[];
    output_types: string[];
  }> = {},
) {
  return defineAgent({ ...TEST_BEHAVIOR,
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
  // Shared fixtures: register the two domain types every runtime test uses
  // (Signal-flavored "Signal" and Interpretation-flavored "Interpretation").
  // The test-stub mechanism is the same AgentInvoker injection point that
  // tests/runtime.test.ts uses — no claude_invoker, no subprocess, just a
  // deterministic function from (chair, inputs) → output data.
  const signalType: DomainType = {
    slug: "Signal",
    extends: "Signal",
    domain: "test",
    schema: { properties: { value: { type: "string" } } },
    required_fields: [],
  };
  const interpType: DomainType = {
    slug: "Interpretation",
    extends: "Interpretation",
    domain: "test",
    schema: { properties: { value: { type: "string" } } },
    required_fields: [],
  };
  const planType: DomainType = {
    slug: "Plan",
    extends: "Plan",
    domain: "test",
    schema: { properties: { value: { type: "string" } } },
    required_fields: [],
  };

  function setup() {
    const registry = createRegistry();
    registry.registerType(signalType);
    registry.registerType(interpType);
    registry.registerType(planType);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    return { registry, outputs, ledger };
  }

  // Deterministic stub invoker: echoes a marker derived from the agent slug
  // and the count of inputs received. Per-test specializations layer over this.
  const stubInvoke: AgentInvoker = ({ agent, inputs }) => ({
    value: `${agent.slug}(${inputs.length})`,
  });

  it("single-chair phase runs identically to today's single-agent phase (regression)", async () => {
    // A single-chair phase composed via the new schema must produce the same
    // shape of result as the legacy {name, agent} runtime: one output, status
    // complete, ledger entry recorded. Tests the no-parallelism path.
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const std = composeStandard({
      slug: "regression",
      domain: "test",
      agents: [a],
      phases: [{ name: "p1", chairs: [chair("solo", "a")] } as PhaseDef],
    });
    const { outputs, ledger } = setup();
    const res = await runGig(std, {}, { outputs, ledger, invoke: stubInvoke });
    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(1);
    expect(res.outputs[0]!.agent_slug).toBe("a");
    expect(ledger.count()).toBe(1);
  });

  it("multi-chair phase dispatches all parallel-eligible chairs concurrently", async () => {
    // Three chairs in the same phase with NO inter-dependencies must run in
    // parallel via Promise.all(Settled). We observe concurrency by recording
    // the in-flight count via a shared counter incremented on enter and
    // decremented on exit; the peak count must equal the chair count.
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const std = composeStandard({
      slug: "parallel",
      domain: "test",
      agents: [a],
      phases: [
        {
          name: "fan-out",
          chairs: [chair("r1", "a"), chair("r2", "a"), chair("r3", "a")],
        } as PhaseDef,
      ],
    });
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    let allEnteredResolve: () => void;
    const allEntered = new Promise<void>((r) => { allEnteredResolve = r; });
    const trackingInvoke: AgentInvoker = async ({ agent }) => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      if (inFlight >= 3) allEnteredResolve!();
      // Each chair parks until all three have entered, proving the runtime
      // dispatched them concurrently (no serial wait-for-prev-to-finish).
      await allEntered;
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { value: agent.slug };
    };
    const { outputs, ledger } = setup();
    const gig = runGig(std, {}, { outputs, ledger, invoke: trackingInvoke });
    await allEntered;
    expect(peak).toBe(3);
    for (const r of release) r();
    const res = await gig;
    expect(res.outputs.length).toBe(3);
  });

  it("depends_on respected: chair starts only after every upstream chair completes", async () => {
    // Chair B depends_on A. B's invocation must observe A's output as input.
    // We assert ordering by checking B saw exactly 1 input (A's output) and
    // that input is A's recorded value.
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const b = agent("b", { input_types: ["Interpretation"], output_types: ["Plan"] });
    const std = composeStandard({
      slug: "ordered",
      domain: "test",
      agents: [a, b],
      phases: [
        {
          name: "p1",
          chairs: [
            chair("A", "a", { output_contract: ["Interpretation"] }),
            chair("B", "b", {
              depends_on: ["A"],
              input_contract: ["Interpretation"],
              output_contract: ["Plan"],
            }),
          ],
        } as PhaseDef,
      ],
    });
    const aFinishedAt: { t: number | null } = { t: null };
    const bStartedAt: { t: number | null } = { t: null };
    let seq = 0;
    const orderedInvoke: AgentInvoker = async ({ agent, inputs }) => {
      if (agent.slug === "a") {
        await new Promise((r) => setTimeout(r, 5));
        aFinishedAt.t = ++seq;
        return { value: "from-a" };
      }
      bStartedAt.t = ++seq;
      // B must see A's output as input
      expect(inputs.length).toBe(1);
      expect(inputs[0]!.data["value"]).toBe("from-a");
      return { value: "from-b" };
    };
    const { outputs, ledger } = setup();
    await runGig(std, {}, { outputs, ledger, invoke: orderedInvoke });
    expect(aFinishedAt.t).not.toBeNull();
    expect(bStartedAt.t).not.toBeNull();
    expect(bStartedAt.t!).toBeGreaterThan(aFinishedAt.t!);
  });

  it("cross-phase depends_on works (chair in phase N depends on chair in phase 0..N-1)", async () => {
    // upstream in phase p1, downstream in phase p2 depends_on it. The runtime
    // must carry producedByRole across phases so the downstream chair resolves.
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const b = agent("b", { input_types: ["Interpretation"], output_types: ["Plan"] });
    const std = composeStandard({
      slug: "cross-phase",
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
    });
    const sawInputs: number[] = [];
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      if (agent.slug === "b") sawInputs.push(inputs.length);
      return { value: agent.slug };
    };
    const { outputs, ledger } = setup();
    const res = await runGig(std, {}, { outputs, ledger, invoke });
    expect(res.outputs.length).toBe(2);
    expect(sawInputs).toEqual([1]); // b saw exactly 1 input (a's output)
  });

  it("phase aborts if any chair fails and names the failing chair", async () => {
    // Two parallel chairs r1, r2. One throws; the gig must reject with a
    // RuntimeError whose message names the failing chair role.
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const std = composeStandard({
      slug: "abort",
      domain: "test",
      agents: [a],
      phases: [
        {
          name: "p1",
          chairs: [chair("r1", "a"), chair("r2", "a")],
        } as PhaseDef,
      ],
    });
    // Counter-discriminating invoker: second dispatched chair throws. Promise.
    // allSettled collects the failure; the runtime aggregates into one error.
    function makeInvoke(): AgentInvoker {
      let calls = 0;
      return ({ agent }) => {
        calls++;
        if (calls === 2) throw new Error("boom-from-chair");
        return { value: agent.slug };
      };
    }
    const { outputs, ledger } = setup();
    const err = await runGig(std, {}, { outputs, ledger, invoke: makeInvoke() }).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeError);
    expect(String(err.message)).toMatch(/r1|r2/);
    expect(String(err.message)).toMatch(/boom-from-chair/);
  });

  it("input_contract present in upstream outputs before invocation, else error", async () => {
    // Chair B declares input_contract: ["Plan"] but its sole depends_on
    // upstream A produces "Interpretation". The runtime must reject pre-invoke
    // (compose itself rejects this; here we bypass via a hand-rolled Standard
    // literal that the runtime should still defend against).
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    const b = agent("b", { input_types: ["Interpretation"], output_types: ["Plan"] });
    // Hand-rolled (composeStandard would catch this). Cast through unknown
    // because we're bypassing composeStandard's validation here.
    const std = {
      slug: "bad-input",
      domain: "test",
      agents: [a, b],
      phases: [
        {
          name: "p1",
          chairs: [
            chair("A", "a", { output_contract: ["Interpretation"] }),
            chair("B", "b", {
              depends_on: ["A"],
              input_contract: ["NeverProducedType"],
              output_contract: ["Plan"],
            }),
          ],
        },
      ],
    } as const;
    const { outputs, ledger } = setup();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runGig(std as any, {}, { outputs, ledger, invoke: stubInvoke }),
    ).rejects.toThrow(/input_contract|NeverProducedType/);
  });

  it("output_contract produced after invocation, else error", async () => {
    // Chair declares output_contract: ["Plan"] but the bound agent only
    // produces ["Interpretation"]. The runtime must reject post-invoke (or
    // synchronously if the agent's output_types don't cover output_contract).
    const a = agent("a", { input_types: [], output_types: ["Interpretation"] });
    // Hand-rolled Standard literal that bypasses composeStandard's same gate.
    const std = {
      slug: "bad-output",
      domain: "test",
      agents: [a],
      phases: [
        {
          name: "p1",
          chairs: [
            chair("solo", "a", { output_contract: ["Plan"] }),
          ],
        },
      ],
    } as const;
    const { outputs, ledger } = setup();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runGig(std as any, {}, { outputs, ledger, invoke: stubInvoke }),
    ).rejects.toThrow(/output_contract|Plan/);
  });

  // fan-in cardinality — N upstream chairs all produce same type, 1 downstream consumes all N

  // Shared fan-in fixture: 3 upstream chairs (u1, u2, u3) each binding agent
  // `up` (produces Interpretation), and 1 downstream chair `sink` binding
  // agent `down` (consumes Interpretation, produces Plan) with
  // depends_on=[u1,u2,u3]. Built per-test so each gets a fresh standard.
  function fanInStandard(downInputContract: string[] = ["Interpretation"]) {
    const up = agent("up", { input_types: [], output_types: ["Interpretation"] });
    const down = agent("down", {
      input_types: ["Interpretation"],
      output_types: ["Plan"],
    });
    return composeStandard({
      slug: "fan-in",
      domain: "test",
      agents: [up, down],
      phases: [
        {
          name: "p1",
          chairs: [
            chair("u1", "up", { output_contract: ["Interpretation"] }),
            chair("u2", "up", { output_contract: ["Interpretation"] }),
            chair("u3", "up", { output_contract: ["Interpretation"] }),
            chair("sink", "down", {
              depends_on: ["u1", "u2", "u3"],
              input_contract: downInputContract,
              output_contract: ["Plan"],
            }),
          ],
        } as PhaseDef,
      ],
    });
  }

  it("fan-in completeness: a chair with depends_on of N upstream chairs starts only after ALL N produce their output_contract", async () => {
    // sink depends_on [u1,u2,u3]. We park 2 of 3 upstreams behind release
    // gates and let the 3rd complete fast. sink must NOT begin until the
    // last upstream resolves.
    const std = fanInStandard();
    let upEntered = 0;
    let upCompleted = 0;
    let sinkStarted = false;
    let releaseLater: (() => void) | null = null;
    const lateGate = new Promise<void>((r) => { releaseLater = r; });
    const invoke: AgentInvoker = async ({ agent }) => {
      if (agent.slug === "up") {
        const myIdx = upEntered++;
        // First two complete promptly; the third parks until externally released.
        if (myIdx === 2) await lateGate;
        upCompleted++;
        return { value: `up-${myIdx}` };
      }
      sinkStarted = true;
      return { value: "sink" };
    };
    const { outputs, ledger } = setup();
    const gig = runGig(std, {}, { outputs, ledger, invoke });
    // Let the two fast upstreams finish; sink must still be blocked.
    await new Promise((r) => setTimeout(r, 30));
    expect(sinkStarted).toBe(false);
    expect(upCompleted).toBe(2);
    // Release the last upstream; sink must now run.
    releaseLater!();
    const res = await gig;
    expect(upCompleted).toBe(3);
    expect(sinkStarted).toBe(true);
    expect(res.outputs.length).toBe(4);
  });

  it("fan-in: if any 1 of N upstream chairs fails, the downstream chair does not run and the phase aborts naming the failing upstream", async () => {
    const std = fanInStandard();
    let sinkRan = false;
    let upCalls = 0;
    const invoke: AgentInvoker = ({ agent }) => {
      if (agent.slug === "up") {
        upCalls++;
        // u2 throws (deterministic across the parallel batch).
        if (upCalls === 2) throw new Error("upstream-explode");
        return { value: `up-${upCalls}` };
      }
      sinkRan = true;
      return { value: "sink" };
    };
    const { outputs, ledger } = setup();
    const err = await runGig(std, {}, { outputs, ledger, invoke }).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeError);
    expect(String(err.message)).toMatch(/u1|u2|u3/);
    expect(String(err.message)).toMatch(/upstream-explode/);
    expect(sinkRan).toBe(false);
  });

  it("fan-in: downstream chair receives outputs from all N upstream chairs in its input scope (not just the first to complete)", async () => {
    const std = fanInStandard();
    let sinkInputCount = -1;
    const seenValues: string[] = [];
    let upCalls = 0;
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      if (agent.slug === "up") {
        upCalls++;
        return { value: `up-${upCalls}` };
      }
      sinkInputCount = inputs.length;
      for (const i of inputs) seenValues.push(i.data["value"] as string);
      return { value: "sink" };
    };
    const { outputs, ledger } = setup();
    await runGig(std, {}, { outputs, ledger, invoke });
    expect(sinkInputCount).toBe(3);
    expect(new Set(seenValues)).toEqual(new Set(["up-1", "up-2", "up-3"]));
  });

  it("fan-in: ordering of N parallel upstream chairs is not observable downstream (commutative; consumer treats them as a set)", async () => {
    // Run twice: once with upstream sleep durations 30/10/20 (so completion
    // order is u2, u3, u1); once with 5/25/15 (so order is u1, u3, u2).
    // The downstream chair must see the SAME ordered tuple of (from_role,
    // value) both times — declared depends_on order, not completion order.
    async function runWithSleeps(sleeps: [number, number, number]) {
      const std = fanInStandard();
      let upCalls = 0;
      let sinkSeen: Array<{ from_role: string | undefined; value: unknown }> = [];
      const invoke: AgentInvoker = async ({ agent, inputs }) => {
        if (agent.slug === "up") {
          const myIdx = upCalls++;
          await new Promise((r) => setTimeout(r, sleeps[myIdx]!));
          return { value: `value-${myIdx}` };
        }
        sinkSeen = inputs.map((i) => ({
          from_role: i.from_role,
          value: i.data["value"],
        }));
        return { value: "sink" };
      };
      const { outputs, ledger } = setup();
      await runGig(std, {}, { outputs, ledger, invoke });
      return sinkSeen;
    }
    const runA = await runWithSleeps([30, 10, 20]);
    const runB = await runWithSleeps([5, 25, 15]);
    // Both runs must yield the SAME declared order: u1 first, u2 second, u3 third.
    expect(runA.map((s) => s.from_role)).toEqual(["u1", "u2", "u3"]);
    expect(runB.map((s) => s.from_role)).toEqual(["u1", "u2", "u3"]);
  });

  it("fan-in: each upstream chair's output is distinguishable downstream by source role (consumer can address them individually)", async () => {
    // sink must be able to filter its inputs by from_role to pick out
    // specifically u2's output, even though u1/u2/u3 all bind the same agent.
    const std = fanInStandard();
    let upCalls = 0;
    let foundU2Value: unknown = undefined;
    let byRole: Record<string, unknown> = {};
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      if (agent.slug === "up") {
        upCalls++;
        return { value: `from-up-call-${upCalls}` };
      }
      // Per-role addressability: index inputs by from_role.
      for (const i of inputs) {
        if (i.from_role) byRole[i.from_role] = i.data["value"];
      }
      foundU2Value = byRole["u2"];
      return { value: "sink" };
    };
    const { outputs, ledger } = setup();
    await runGig(std, {}, { outputs, ledger, invoke });
    // Each upstream output must carry its from_role tag.
    expect(Object.keys(byRole).sort()).toEqual(["u1", "u2", "u3"]);
    // And the values must be distinct (not collapsed) — N parallel upstreams
    // binding the same agent must each have addressable identity downstream.
    const distinct = new Set(Object.values(byRole));
    expect(distinct.size).toBe(3);
    expect(foundU2Value).toBeDefined();
  });

  it("fan-in: partial completion is never visible — the downstream chair never sees fewer than N upstream outputs", async () => {
    // Sample sink's inputs.length every time it would conceivably run. The
    // runtime contract: sink is invoked exactly once, with exactly N inputs.
    // It is never invoked with 0, 1, or 2 inputs as a partial-progress snapshot.
    const std = fanInStandard();
    const sinkInvocations: number[] = [];
    let upCalls = 0;
    const invoke: AgentInvoker = async ({ agent, inputs }) => {
      if (agent.slug === "up") {
        upCalls++;
        // Stagger so partial visibility would be a real bug if it existed.
        await new Promise((r) => setTimeout(r, upCalls * 5));
        return { value: `up-${upCalls}` };
      }
      sinkInvocations.push(inputs.length);
      return { value: "sink" };
    };
    const { outputs, ledger } = setup();
    await runGig(std, {}, { outputs, ledger, invoke });
    expect(sinkInvocations).toEqual([3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration — loader-reject assertion (1 test).
//
// (removed) tests #1/#2/#4 — codemod is not a public OSS feature; migration was hand-applied.
// ─────────────────────────────────────────────────────────────────────────────

describe("chairs — migration (loader reject)", () => {
  it("loader rejects any standard JSON containing legacy phase.agent", () => {
    // Construct a standard JSON literal with the legacy shape and assert
    // composeStandard rejects it with a clear error naming the legacy field.
    const a = agent("a");
    const legacyStandard = {
      slug: "legacy-shape",
      domain: "test",
      agents: [a],
      phases: [{ name: "p1", agent: "a" }],
    };
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      composeStandard(legacyStandard as any),
    ).toThrow(/legacy|phase\.agent|not supported|chairs.*required/i);
  });
});
