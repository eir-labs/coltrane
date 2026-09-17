// RED — the turn reserve pool works the same whether or not a dollar budget is set (contract O4/I5).
//
// THE COUPLING. The pool lives on BudgetState, and BudgetState is constructed ONLY when
// `deps.budget` is present (src/runtime.ts: `const budget = deps.budget ? {…} : null`). Every
// reserve draw is guarded by `if (budget && …)`. So a gig with `standard.reserve_pool` and chairs
// that declare `turn_reserve` draws NOTHING unless a money budget is also passed — which is why
// tests/gig_reserve_pool.test.ts and tests/gig_yielding_state.test.ts pass `opening: 1_000_000` they
// do not otherwise need, purely to bring the pool into existence.
//
// The contract decouples them: the pool is sourced from `standard.reserve_pool` / `chair.turn_reserve`
// and behaves identically with and without a dollar ceiling. This law runs ONE reserve scenario
// twice — once with no budget, once with `max_usd` — and asserts the draw ledger is identical.
//
// RED against today's src: the no-budget run records no draws and returns no budget_state, while the
// dollar-budget run draws 4 and leaves 6 — the two diverge, which is the coupling itself.
import { describe, it, expect } from "vitest";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type AgentStreamEvent,
  type BudgetInput,
  type DomainType,
  type Agent,
  type Standard,
} from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const hit: DomainType = {
  slug: "lineage-hit", extends: "Signal", domain: "eirtests",
  schema: { properties: { source: { type: "string" } } }, required_fields: ["source"],
};
const scout: Agent = { ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"], domain: "eirtests" };

interface DrawRecord { role?: string; granted: number; pool_remaining_after: number; denied?: boolean }

/** A single chair (turn_reserve 4) that hits its budget and draws whatever the runtime offers it from
 *  a `reserve_pool` of 10. The pool is a property of the STANDARD, never of a dollar budget. */
async function runScenario(budget: BudgetInput | undefined): Promise<{ offered: number | undefined; draws: DrawRecord[]; pool_remaining: unknown }> {
  let offered: number | undefined;
  const invoke: AgentInvoker = (c) => {
    offered = (c as unknown as Record<string, unknown>)["turn_reserve"] as number | undefined;
    if (offered !== undefined && offered > 0) {
      c.onEvent?.({ type: "budget_reserve_granted", raw: { agent: c.agent.slug, role: c.phase, reserve_turns: offered, sealed_before_grant: [] } } as AgentStreamEvent);
    }
    return { source: "hit-0" };
  };
  const standard = {
    slug: "sweep", domain: "eirtests", agents: [scout], reserve_pool: 10,
    phases: [{ name: "sense-0", chairs: [{ role: "sense-0", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["lineage-hit"], required_skills: [], turn_reserve: 4 }] }],
  } as unknown as Standard;
  const registry = createRegistry();
  registry.registerType(hit);
  const res = await runGig(standard, {}, {
    outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke,
    ...(budget ? { budget } : {}),
  });
  const bs = res.budget_state as unknown as Record<string, unknown> | undefined;
  return { offered, draws: (bs?.["draws"] as DrawRecord[] | undefined) ?? [], pool_remaining: bs?.["pool_remaining"] };
}

describe("I5 — the reserve pool draws and caps identically with and without a dollar budget", () => {
  it("the same reserve_pool scenario produces the same draw ledger, budget or no budget", async () => {
    const noBudget = await runScenario(undefined);
    const withDollars = await runScenario({ max_usd: 45 } as unknown as BudgetInput);

    // The dollar-budget run is the reference: chair drew 4 from a pool of 10, leaving 6.
    expect(withDollars.offered, "the reference (dollar-budget) run did not draw from the pool").toBe(4);

    // …and the NO-budget run must match it exactly. Today it draws nothing, because the pool only
    // exists when a money budget does.
    expect(noBudget.offered, "a reserve pool declared on the standard did nothing without a dollar budget — the pool is coupled to money").toBe(4);
    expect(noBudget.draws, "the no-budget run kept no draw ledger — the pool machinery is off without a dollar budget").toEqual(withDollars.draws);
    expect(noBudget.pool_remaining, "the pool did not draw down without a dollar budget").toBe(withDollars.pool_remaining);
  });
});
