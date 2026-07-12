// The chair-selection policy seam (RunDeps.selectChairs) — the adaptive-router
// hole an external conductor (Étude/VOI) plugs into. Contract under test:
//   * absent hook → the v0 topological-parallel routing, untouched
//   * a subset-returning policy serializes the batch: unselected chairs stay in
//     `remaining`, re-enter the next frontier, and every chair still completes
//   * the policy's return is validated strictly — empty or outside-the-frontier
//     throws RuntimeError (a buggy policy must fail loudly, never fall back)
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  RuntimeError,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type AgentInvoker,
  type ChairSelector,
} from "../src";
import type { Standard, Agent, Chair } from "../src";

const probe: DomainType = {
  slug: "axis-probe",
  extends: "Signal",
  domain: "etude",
  schema: { properties: { axis: { type: "string" }, value: { type: "number" } } },
  required_fields: ["axis", "value"],
};

function prober(slug: string): Agent {
  return { ...TEST_BEHAVIOR, slug, primitives: ["SENSE"], input_types: [], output_types: ["axis-probe"], domain: "etude" };
}

// One phase, three chairs, no inter-deps — the whole frontier is ready at once,
// so the selection policy is a real decision every iteration.
function scanStandard(): Standard {
  const chair = (role: string, agent_slug: string): Chair => ({
    role, agent_slug, depends_on: [], input_contract: [], output_contract: ["axis-probe"], required_skills: [],
  });
  return {
    slug: "axis-scan",
    domain: "etude",
    agents: [prober("prober-a"), prober("prober-b"), prober("prober-c")],
    phases: [{ name: "probe", chairs: [chair("a", "prober-a"), chair("b", "prober-b"), chair("c", "prober-c")] }],
  };
}

function setup() {
  const registry = createRegistry();
  registry.registerType(probe);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

// Deterministic invoker; records dispatch order via the batch boundary below.
const invoke: AgentInvoker = ({ agent }) => ({ axis: agent.slug, value: 0.5 });

// Observe dispatch batches through onProgress chair_start events.
function batchRecorder() {
  const starts: string[] = [];
  return {
    starts,
    onProgress: (ev: { type: string; role?: string }) => {
      if (ev.type === "chair_start" && ev.role) starts.push(ev.role);
    },
  };
}

describe("selectChairs policy seam", () => {
  it("absent hook: all ready chairs dispatch in one parallel batch (v0 behavior)", async () => {
    const { outputs, ledger } = setup();
    const rec = batchRecorder();
    const res = await runGig(scanStandard(), {}, { outputs, ledger, invoke, onProgress: rec.onProgress });
    expect(res.outputs).toHaveLength(3);
    // one topological level → all three started (order within the batch is dispatch order)
    expect(new Set(rec.starts)).toEqual(new Set(["a", "b", "c"]));
  });

  it("a one-chair policy serializes the batch in the policy's order and every chair completes", async () => {
    const { outputs, ledger } = setup();
    const rec = batchRecorder();
    const conductedOrder = ["b", "c", "a"];
    const frontiers: string[][] = [];
    const selectChairs: ChairSelector = ({ ready }) => {
      frontiers.push(ready.map((c) => c.role).sort());
      const next = conductedOrder.find((r) => ready.some((c) => c.role === r));
      return ready.filter((c) => c.role === next);
    };
    const res = await runGig(scanStandard(), {}, { outputs, ledger, invoke, onProgress: rec.onProgress, selectChairs });
    expect(rec.starts).toEqual(conductedOrder);          // conducted sequence, not a parallel batch
    expect(res.outputs).toHaveLength(3);                 // unselected chairs re-entered and completed
    // the frontier shrank as the conductor consumed it
    expect(frontiers).toEqual([["a", "b", "c"], ["a", "c"], ["a"]]);
    expect(res.status).toBe("complete");
  });

  it("the view carries produced records so a policy can observe prior outputs", async () => {
    const { outputs, ledger } = setup();
    const seen: number[] = [];
    const selectChairs: ChairSelector = ({ ready, produced }) => {
      seen.push(produced.length);
      return [ready[0]!];
    };
    await runGig(scanStandard(), {}, { outputs, ledger, invoke, selectChairs });
    expect(seen).toEqual([0, 1, 2]); // each iteration sees everything sealed so far
  });

  it("an empty return throws RuntimeError (no silent fallback)", async () => {
    const { outputs, ledger } = setup();
    const selectChairs: ChairSelector = () => [];
    await expect(runGig(scanStandard(), {}, { outputs, ledger, invoke, selectChairs }))
      .rejects.toThrow(RuntimeError);
    await expect(runGig(scanStandard(), {}, { outputs, ledger, invoke, selectChairs }))
      .rejects.toThrow(/selectChairs returned no chairs/);
  });

  it("a chair outside the ready frontier throws RuntimeError naming the stray role", async () => {
    const { outputs, ledger } = setup();
    const stray: Chair = { role: "ghost", agent_slug: "prober-a", depends_on: [], input_contract: [], output_contract: ["axis-probe"], required_skills: [] };
    const selectChairs: ChairSelector = () => [stray];
    await expect(runGig(scanStandard(), {}, { outputs, ledger, invoke, selectChairs }))
      .rejects.toThrow(/outside the ready frontier.*ghost/);
  });
});
