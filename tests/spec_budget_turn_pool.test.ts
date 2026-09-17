// RED — a turn pool opens from RunDeps.turn_pool with NO money budget (contract O6 + I9).
//
// THE DECISION (operator 2026-09-16, amendment 2026-09-17). A turn pool needs no money budget. Its
// opening comes from RunDeps.turn_pool when set, else Standard.reserve_pool, else 0 (O6). BudgetInput.pool
// is retired. GigResult.budget_state is present whenever a dollar ceiling OR a turn pool is in play: its
// pool fields (pool_remaining, draws) are filled regardless of money, and its dollar fields (max_usd,
// spent_usd, unit 'usd') only when a ceiling is set.
//
// I9 makes the override executable: Standard.reserve_pool 10, RunDeps.turn_pool 3, one chair drawing 4 →
// granted 3, pool_remaining 0, and NO budget passed at all.
//
// RED against today's src: RunDeps has no `turn_pool` field, the pool opens from `deps.budget?.pool ??
// standard.reserve_pool ?? 0` (src/runtime.ts:1397), and BudgetState is constructed ONLY when
// `deps.budget` is present (`const budget = deps.budget ? {…} : null`, src/runtime.ts:1398). So a turn
// pool with no money budget produces NO budget_state — pool_remaining and draws are absent, and turn_pool
// never overrides reserve_pool.
import { describe, it, expect } from "vitest";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type AgentStreamEvent,
  type DomainType,
  type Agent,
  type Standard,
  type RunDeps,
} from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const hit: DomainType = {
  slug: "lineage-hit", extends: "Signal", domain: "eirtests",
  schema: { properties: { source: { type: "string" } } }, required_fields: ["source"],
};
const scout: Agent = { ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"], domain: "eirtests" };

/**
 * Run a single-chair gig whose chair declares `reserve` turns, hits its budget and draws whatever the
 * runtime offers it. The pool is passed via RunDeps.turn_pool (O6) — NEVER a money budget — with an
 * optional Standard.reserve_pool default and an optional max_usd ceiling. Returns what the invoker was
 * OFFERED (ctx.turn_reserve) and the gig's budget_state.
 */
async function runTurnPoolGig(opts: {
  turn_pool?: number | undefined;
  reserve_pool?: number | undefined;
  reserve: number;
  max_usd?: number | undefined;
}): Promise<{ offered: number | undefined; budget_state: Record<string, unknown> | undefined }> {
  let offered: number | undefined;
  const invoke: AgentInvoker = (c) => {
    offered = (c as unknown as Record<string, unknown>)["turn_reserve"] as number | undefined;
    // The chair hit its declared turn budget and reaches for the pool. If the runtime offered it
    // turns (min(own reserve, pool_remaining)), that is a GRANT the runtime records as a draw.
    if (offered !== undefined && offered > 0) {
      c.onEvent?.({ type: "budget_reserve_granted", raw: { agent: c.agent.slug, role: c.phase, reserve_turns: offered, sealed_before_grant: [] } } as AgentStreamEvent);
    }
    return { source: "hit" };
  };
  const standard = {
    slug: "sweep", domain: "eirtests", agents: [scout],
    ...(opts.reserve_pool !== undefined ? { reserve_pool: opts.reserve_pool } : {}),
    phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["lineage-hit"], required_skills: [], turn_reserve: opts.reserve }] }],
  } as unknown as Standard;
  const registry = createRegistry();
  registry.registerType(hit);
  // The pool rides on RunDeps.turn_pool; max_usd (when set) is the only money budget. Cast because
  // RunDeps does not name turn_pool until the enforcement lands — RED today.
  const deps = {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke,
    ...(opts.turn_pool !== undefined ? { turn_pool: opts.turn_pool } : {}),
    ...(opts.max_usd !== undefined ? { budget: { max_usd: opts.max_usd } } : {}),
  } as unknown as RunDeps;
  const res = await runGig(standard, {}, deps);
  return { offered, budget_state: res.budget_state as unknown as Record<string, unknown> | undefined };
}

describe("O6/I9 — a turn pool opens from RunDeps.turn_pool with no money budget", () => {
  it("I9 — RunDeps.turn_pool opens the pool and OVERRIDES standard.reserve_pool, no budget passed", async () => {
    // standard.reserve_pool = 10; RunDeps.turn_pool = 3 overrides it; one chair (turn_reserve 4) draws.
    // Expect: offered = min(own reserve 4, turn_pool 3) = 3, granted 3, pool_remaining 0. No budget.
    const { offered, budget_state } = await runTurnPoolGig({ turn_pool: 3, reserve_pool: 10, reserve: 4 });

    expect(offered, "the chair was offered min(own reserve 4, turn_pool 3) = 3; turn_pool must override reserve_pool 10").toBe(3);
    expect(budget_state, "a turn pool in play must yield a budget_state even with no money budget (O6)").toBeDefined();
    expect(budget_state?.["pool_remaining"], "the pool opened at turn_pool=3 and the draw of 3 emptied it").toBe(0);
    const draws = (budget_state?.["draws"] as Array<Record<string, unknown>> | undefined) ?? [];
    expect(draws.length, "the single draw must be recorded on the snapshot").toBe(1);
    expect(draws[0]?.["granted"], "the recorded draw granted 3 turns").toBe(3);
  });

  it("O6 — a turn pool ALONE fills the pool fields and OMITS the dollar fields (no ceiling set)", async () => {
    // turn_pool 5, chair reserve 2, no max_usd: pool_remaining/draws are present; the dollar ceiling
    // field max_usd is absent because no ceiling is set. RED today: no budget_state at all without a
    // money budget, so the pool fields are absent entirely.
    const { offered, budget_state } = await runTurnPoolGig({ turn_pool: 5, reserve: 2 });

    expect(offered, "the chair was offered min(reserve 2, pool 5) = 2").toBe(2);
    expect(budget_state, "a turn pool alone must produce a budget_state (O6)").toBeDefined();
    expect(budget_state?.["pool_remaining"], "pool fields are filled regardless of money: 5 opened, 2 drawn, 3 left").toBe(3);
    expect(budget_state?.["max_usd"], "no ceiling was set, so the dollar ceiling field must be absent").toBeUndefined();
  });
});
