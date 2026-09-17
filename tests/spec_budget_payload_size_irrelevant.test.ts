// RED — payload size has no effect on budget enforcement (contract I8, a universal property).
//
// The append-unit gate priced a chair at base_cost + 0.1 × payload bytes, so payload size was the
// DOMINANT term in whether a chair ran. The contract makes it irrelevant: only settled dollars gate,
// and the reported spend is in dollars, invariant to how large the payload is. Pinned as a
// fast-check PROPERTY over payload lengths rather than one example — "for ANY payload size" is a
// universal claim, and one hand-picked size could pass by luck.
//
// RED against today's src: the returned budget_state still reports `unit: "append-units"` and a
// `spent` that GROWS with the payload (0.1 per byte) — the exact size-dependence the contract
// deletes. `settled_usd` is fixed at the real spend, but nothing surfaces it as the dollar `spent_usd`
// the property reads.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvoker,
  type BudgetInput,
  type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";
import { spentNote } from "./_support/budget_dispatch.js";

const worker = testAgent({ slug: "worker", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" });

const oneChair: Standard = {
  slug: "spend", domain: "demo", agents: [worker],
  phases: [{ name: "p0", chairs: [{ role: "w0", agent_slug: "worker", depends_on: [], input_contract: [], output_contract: ["spent-note"], required_skills: [] }] }],
};

const spend = (usd: number): AgentInvoker => (ctx) => {
  ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
  return { t: "done", source: "fixture://demo/spent" };
};

describe("I8 — payload size does not affect budget enforcement", () => {
  it("for ANY payload length, a $0.02 gig under a $45 ceiling completes and reports a size-invariant dollar spend", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 50_000 }), async (payloadLen) => {
        const registry = createRegistry();
        registry.registerType(spentNote);
        const res = await runGig(oneChair, { blob: "z".repeat(payloadLen) }, {
          outputs: createOutputStore(registry), ledger: new MemoryLedger(),
          invoke: spend(0.02), budget: { max_usd: 45 } as unknown as BudgetInput,
        });
        // completion is independent of payload size…
        expect(res.outputs.length, `a ${payloadLen}-byte payload changed whether the chair ran`).toBe(1);
        // …and so is the DOLLAR spend the run reports: fixed at $0.02, in 'usd', for every size.
        const bs = res.budget_state as unknown as Record<string, unknown>;
        expect(bs["unit"], "the budget is still denominated in append-units, which scale with payload size").toBe("usd");
        expect(bs["spent_usd"], `the reported dollar spend moved with the ${payloadLen}-byte payload`).toBeCloseTo(0.02, 5);
      }),
      { numRuns: 25 },
    );
  });
});
