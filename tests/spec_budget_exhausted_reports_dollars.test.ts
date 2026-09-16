// RED — a budget stop states what happened IN DOLLARS (contract I4 + obligation O5).
//
// Today's stop is denominated in append-units: `BudgetExhausted` carries `balance`/`cost` and a
// message "needs cost=2385.6 but balance=45 (opening=45, spent=0, credit=0)" — no dollar figure, no
// unit, no '$'. gig_dispatch's `budget_exhausted` reply forwards those same append-unit fields
// (agent_slug/balance/cost/budget_state). The contract requires the settled dollars spent, the dollar
// ceiling, and the unit 'usd' — in BOTH the error and the reply.
//
// RED for two reasons at once against today's src: (1) a dollar overspend does not even throw
// (the append gate never trips on a `max_usd` input), so there is no stop to inspect; and (2) the
// stop's own shape, when it does fire, has no `spent_usd`/`max_usd`/`unit:"usd"`.
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  BudgetExhausted,
  type AgentInvoker,
  type BudgetInput,
  type Standard,
} from "../src/index.js";
import { dispatchTool } from "../src/server.js";
import { budgetDeps, spendStandard, spendingInvoker } from "./_support/budget_dispatch.js";
import { spentNote } from "./_support/budget_dispatch.js";
import { testAgent } from "./_support/agents.js";

const worker = testAgent({ slug: "worker", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" });

function chairs(n: number): Standard {
  return {
    slug: "spend", domain: "demo", agents: [worker],
    phases: Array.from({ length: n }, (_, i) => ({
      name: `p${i}`,
      chairs: [{ role: `w${i}`, agent_slug: "worker", depends_on: i === 0 ? [] : [`w${i - 1}`], input_contract: [], output_contract: ["spent-note"], required_skills: [] }],
    })),
  } as Standard;
}

function spending(usd: number): AgentInvoker {
  return (ctx) => {
    ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
    return { t: "done", source: "fixture://demo/spent" };
  };
}

describe("I4 — BudgetExhausted carries spent_usd, max_usd and unit 'usd', and says so in dollars", () => {
  it("a $0.09 overspend against a $0.05 ceiling throws a dollar-denominated stop", async () => {
    const registry = createRegistry();
    registry.registerType(spentNote);
    let caught: unknown = null;
    try {
      await runGig(chairs(3), {}, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(),
        invoke: spending(0.03), budget: { max_usd: 0.05 } as unknown as BudgetInput,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "a dollar overspend did not stop the gig at all — there was no BudgetExhausted to inspect").toBeInstanceOf(BudgetExhausted);
    const err = caught as Record<string, unknown>;
    expect(err["unit"], "the stop is not denominated in dollars").toBe("usd");
    expect(err["max_usd"], "the stop does not carry the dollar ceiling it enforced").toBe(0.05);
    expect(err["spent_usd"], "the stop does not carry the settled dollars spent").toBeCloseTo(0.06, 5);
    const message = String((caught as Error)?.message ?? "");
    expect(message, "the stop's message names no dollar amount").toContain("$");
    expect(message.toLowerCase(), "the stop's message never says 'usd'").toContain("usd");
    expect(message, "the stop still speaks append-units ('balance='/'cost=')").not.toMatch(/balance=|cost=\d/);
  });
});

describe("O5 — the gig_dispatch budget_exhausted reply carries spent_usd, max_usd and unit 'usd'", () => {
  it("a dispatch stopped at its dollar ceiling replies in dollars", async () => {
    const seen: string[] = [];
    const deps = budgetDeps(spendStandard(3), spendingInvoker(0.03, seen));
    const r = (await dispatchTool(
      "gig_dispatch",
      { standard_slug: "spend", input: {}, wait: true, budget: { max_usd: 0.02 } },
      deps,
    )) as { ok: boolean; data?: Record<string, unknown>; error?: string };

    expect(r.ok, "a dispatch that overspent its dollar ceiling replied ok — the ceiling was never enforced").toBe(false);
    const data = r.data ?? {};
    expect(data["budget_exhausted"], "the reply does not flag a budget stop").toBe(true);
    expect(data["unit"], "the budget_exhausted reply is not denominated in dollars").toBe("usd");
    expect(data["max_usd"], "the reply does not carry the dollar ceiling").toBe(0.02);
    expect(data["spent_usd"], "the reply does not carry the settled dollars spent").toBeCloseTo(0.03, 5);
    expect(String(r.error ?? ""), "the reply's error names no dollar amount").toContain("$");
  });
});
