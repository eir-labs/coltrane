// cost-budget enforcement, REWRITTEN to the budget-in-dollars contract (operator decision
// 2026-09-16). The original file (PR #99) pinned the append-unit gate: `opening`, `base_cost`, `k`,
// balance = opening - spent + credit, BudgetExhausted-when-append-cost-exceeds-balance. That gate is
// what the contract retires. Every law here is now a DOLLAR law, RED against today's src because the
// runtime enforces the append-unit proxy, not settled USD.
//
// Homes contract invariants:
//   I3 — a running batch is not interrupted by the ceiling; its chairs finish and settle even when
//        that crosses max_usd, then the NEXT batch does not start.
//   O3 — the append-unit gate is gone: payload size / base_cost / k no longer decide whether a chair
//        runs. A gig whose settled spend stays under max_usd completes regardless of payload size.
//
// (I1/I2 live in tests/spec_budget_is_dollars.test.ts; I4 in
// tests/spec_budget_exhausted_reports_dollars.test.ts; I8 in
// tests/spec_budget_payload_size_irrelevant.test.ts.)
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
  type BudgetInput,
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
const scoutA: Agent = { ...TEST_BEHAVIOR, slug: "scout-a", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
const scoutB: Agent = { ...TEST_BEHAVIOR, slug: "scout-b", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
const analyst: Agent = { ...TEST_BEHAVIOR, slug: "site-analyst", primitives: ["INTERPRET"], input_types: [], output_types: ["finding"], domain: "eirtests" };

function setup() {
  const registry = createRegistry();
  registry.registerType(pageModel);
  registry.registerType(finding);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

/** Every seated chair reports `usd` of settled spend via its result event; `seen` records which
 *  agents actually STARTED, so a batch that must not begin can be proven never to have. */
function spending(usd: number, seen: string[]): AgentInvoker {
  return (ctx) => {
    seen.push(ctx.agent.slug);
    ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
    if (ctx.agent.slug === "site-analyst") return { title: "interpretation", claims: ["c"] };
    return { url: "/p", source: "https://example.com/p" };
  };
}

const asDollars = (max_usd: number) => ({ max_usd } as unknown as BudgetInput);

describe("cost-budget enforcement is in dollars, against settled spend", () => {
  it("I3 — a running batch of two parallel chairs at $0.04 each finishes and seals, THEN the next batch does not start", async () => {
    // phase 1: two parallel chairs (no depends_on) → one ready batch. phase 2: one chair.
    const std: Standard = {
      slug: "readiness-scan", domain: "eirtests", agents: [scoutA, scoutB, analyst],
      phases: [
        { name: "sense", chairs: [
          { role: "sense-a", agent_slug: "scout-a", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] },
          { role: "sense-b", agent_slug: "scout-b", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] },
        ] },
        { name: "interpret", chairs: [
          { role: "interpret", agent_slug: "site-analyst", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] },
        ] },
      ],
    };
    const { outputs, ledger } = setup();
    const seen: string[] = [];
    let caught: unknown = null;
    let outCount = -1;
    try {
      const res = await runGig(std, {}, { outputs, ledger, invoke: spending(0.04, seen), budget: asDollars(0.05) });
      outCount = res.outputs.length;
    } catch (e) {
      caught = e;
    }
    // The batch that was already running is NOT interrupted: both parallel chairs ran and sealed.
    expect(seen.filter((s) => s === "scout-a" || s === "scout-b").length, "the running batch was interrupted mid-flight").toBe(2);
    expect(outputs.all().filter((o) => o.agent_slug === "scout-a" || o.agent_slug === "scout-b").length, "a chair in the running batch lost its sealed write").toBe(2);
    // …but the NEXT batch (phase 2), which begins after settled spend crossed $0.05, never starts.
    expect(seen.includes("site-analyst"), "the ceiling was crossed at $0.08 but the next batch still started").toBe(false);
    expect(caught, "a gig past its dollar ceiling ran to completion instead of stopping before the next batch").toBeInstanceOf(BudgetExhausted);
    expect(outCount, "the gig completed despite crossing its dollar ceiling").toBe(-1);
  });

  it("O3 — the append-unit gate is gone: a 40KB payload completes and its budget_state carries NO append-unit denomination", async () => {
    // base_cost + 0.1×40000 ≈ 4000 append-units would refuse this against ANY realistic dollar
    // ceiling under the old gate. Under the contract, only settled dollars ($0.01) gate — and the
    // snapshot the run returns must be a DOLLAR snapshot, not the append-unit ledger. Today the gate
    // is merely NaN-bypassed (so the gig happens to complete), and the snapshot still reports
    // `unit: "append-units"` with the retired `base_cost`/`k`/`opening` fields present — the exact
    // denomination the contract deletes. That is where this law is RED.
    const std: Standard = {
      slug: "one-chair", domain: "eirtests", agents: [scoutA],
      phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "scout-a", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] }],
    };
    const { outputs, ledger } = setup();
    const seen: string[] = [];
    const res = await runGig(std, { blob: "y".repeat(40_000) }, { outputs, ledger, invoke: spending(0.01, seen), budget: asDollars(1) });
    expect(res.outputs.length, "the chair did not run under a dollar ceiling its real spend never approached").toBe(1);
    const bs = res.budget_state as unknown as Record<string, unknown> | undefined;
    expect(bs?.["unit"], "the run reported an append-unit budget for a dollar ceiling").toBe("usd");
    expect(bs?.["base_cost"], "the retired append-unit knob base_cost still rides on the budget state").toBeUndefined();
    expect(bs?.["k"], "the retired append-unit knob k still rides on the budget state").toBeUndefined();
    expect(bs?.["opening"], "the retired append-unit field opening still rides on the budget state").toBeUndefined();
  });
});
