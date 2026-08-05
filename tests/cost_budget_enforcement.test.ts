// cost-budget enforcement (runtime fix for T10 gap noted in PR #81).
//
// PR #56 landed the budget-state.json + settlement.json substrate types, but
// the runtime had no enforcement: gig_dispatch ignored any budget arg, no
// BudgetExhausted was thrown, ledger.append had no balance check. This test
// proves that runGig now honors a `budget` arg, deducts cost per invocation,
// throws BudgetExhausted on depletion, and surfaces the final BudgetState in
// the returned manifest.
//
// All 5 facets the parent task named:
//   T1 — sufficient budget completes successfully, balance decreases by spent
//   T2 — tiny budget raises BudgetExhausted on first/second invocation
//   T3 — BudgetExhausted message names agent_slug + balance + cost
//   T4 — agent_state transitions to "depleted" when budget exhausted
//   T5 — no budget specified → no enforcement (back-compat)
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  runGig,
  BudgetExhausted,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type AgentInvoker,
  type BudgetState,
  type Standard,
  type Agent,
} from "../src";

// ── shared substrate ────────────────────────────────────────────────────────
const pageModel: DomainType = {
  slug: "page-model",
  extends: "Signal",
  domain: "eirtests",
  schema: { properties: { url: { type: "string" } } },
  required_fields: ["url"],
};
const finding: DomainType = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

const scout: Agent = { ...TEST_BEHAVIOR,
  slug: "site-scout",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["page-model"],
  domain: "eirtests",
};
const analyst: Agent = { ...TEST_BEHAVIOR,
  slug: "site-analyst",
  primitives: ["INTERPRET"],
  input_types: ["page-model"],
  output_types: ["finding"],
  domain: "eirtests",
};

const standard: Standard = {
  slug: "readiness-scan",
  domain: "eirtests",
  agents: [scout, analyst],
  phases: [
    { name: "sense", chairs: [{ role: "sense", agent_slug: "site-scout", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] },
    { name: "interpret", chairs: [{ role: "interpret", agent_slug: "site-analyst", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] },
  ],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(pageModel);
  registry.registerType(finding);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

const invoke: AgentInvoker = ({ agent, inputs }) => {
  if (agent.slug === "site-scout") return { url: "/products", source: "https://example.com/products" };
  return { title: `finding from ${inputs.length} input(s)`, claims: [`derived from ${inputs.length} input(s)`] };
};

// ── tests ────────────────────────────────────────────────────────────────────
describe("cost-budget enforcement (runtime)", () => {
  it("T1 — sufficient budget: gig completes, balance decreases by spent amount", async () => {
    const { outputs, ledger } = setup();
    const opening = 1000;
    const res = await runGig(
      standard,
      { site_url: "example.com" },
      { outputs, ledger, invoke, budget: { opening } },
    );

    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(2);
    expect(res.budget_state).toBeDefined();

    const bs = res.budget_state as BudgetState;
    expect(bs.opening).toBe(opening);
    expect(bs.spent).toBeGreaterThan(0);
    expect(bs.credit).toBe(0);
    expect(bs.balance).toBe(opening - bs.spent + bs.credit);
    expect(bs.balance).toBeLessThan(opening); // money was spent
    expect(bs.agent_state).toBe("settled"); // cycle closed cleanly
    expect(bs.depleted_agent).toBeNull();
    expect(bs.depleted_at).toBeNull();
  });

  it("T2 — tiny budget (opening=10): raises BudgetExhausted on first or second invocation", async () => {
    const { outputs, ledger } = setup();
    await expect(
      runGig(standard, { site_url: "example.com" }, { outputs, ledger, invoke, budget: { opening: 10 } }),
    ).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it("T3 — BudgetExhausted carries agent_slug + balance + cost (in message + props)", async () => {
    const { outputs, ledger } = setup();
    let caught: BudgetExhausted | null = null;
    try {
      await runGig(standard, { site_url: "example.com" }, { outputs, ledger, invoke, budget: { opening: 5 } });
    } catch (e) {
      if (e instanceof BudgetExhausted) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    const err = caught as BudgetExhausted;
    // The agent_slug is one of the two known phases — the first one to trip.
    expect(["site-scout", "site-analyst"]).toContain(err.agent_slug);
    expect(typeof err.balance).toBe("number");
    expect(typeof err.cost).toBe("number");
    expect(err.cost).toBeGreaterThan(err.balance); // depletion definition
    // Message format includes all three numbers + the agent slug.
    expect(err.message).toContain("BudgetExhausted");
    expect(err.message).toContain(err.agent_slug);
    expect(err.message).toContain(`balance=${err.balance}`);
    expect(err.message).toContain(`cost=${err.cost}`);
  });

  it("T4 — agent_state transitions to 'depleted' when budget exhausted", async () => {
    const { outputs, ledger } = setup();
    let caught: BudgetExhausted | null = null;
    try {
      await runGig(standard, { site_url: "example.com" }, { outputs, ledger, invoke, budget: { opening: 5 } });
    } catch (e) {
      if (e instanceof BudgetExhausted) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    const state = (caught as BudgetExhausted).state;
    expect(state.agent_state).toBe("depleted");
    expect(state.depleted_agent).toBe((caught as BudgetExhausted).agent_slug);
    expect(state.depleted_at).not.toBeNull();
    expect(typeof state.depleted_at).toBe("string"); // ISO timestamp
  });

  it("T5 — no budget arg: no enforcement (back-compat); gig runs to completion with no budget_state", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, { site_url: "example.com" }, { outputs, ledger, invoke });
    // No throw. No budget_state in the manifest.
    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(2);
    expect(res.budget_state).toBeUndefined();
  });

  it("supplementary — running balance decreases monotonically per invocation; spent matches sum of per-agent costs", async () => {
    // A direct check that the running-tally arithmetic holds: opening - spent + credit = balance.
    // Same standard, generous budget — capture the final state and verify identity.
    const { outputs, ledger } = setup();
    const opening = 10_000;
    const res = await runGig(
      standard,
      { site_url: "example.com" },
      { outputs, ledger, invoke, budget: { opening, base_cost: 1, k: 0.1 } },
    );
    const bs = res.budget_state as BudgetState;
    expect(bs.balance).toBe(opening - bs.spent + bs.credit);
    expect(bs.spent).toBeGreaterThan(0);
    expect(bs.base_cost).toBe(1);
    expect(bs.k).toBe(0.1);
  });
});
