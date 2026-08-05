// #236 — settled spend is discarded on every failed gig.
//
// `usage` accumulates as chairs run, but it is written ONLY on the success path. The async
// failure path (src/server.ts) sets status/finished_at/error and never `state.usage`. Async is
// the default. So a gig that burns real dollars across four chairs and dies on the fifth
// reports ZERO dollars, everywhere — and per the consuming project's findings, failed runs are
// routine. Failed runs are exactly the ones whose cost matters most.
//
// The no-ledger-row-for-a-crashed-gig invariant (recorder_durability_mid_crash.spec.ts) is
// deliberate and stays: an un-sealed gig gets no row. This is about the LIVE state that
// gig_monitor reads, and about the partial usage riding on the thrown error.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, runGig, BudgetExhausted,
  type AgentInvoker, type DomainType, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const read: DomainType = { slug: "read", extends: "Interpretation", domain: "demo", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] };

// p1 reports $0.42 of settled spend and succeeds; p2 dies.
const standard = (): Standard => ({
  slug: "burns-then-dies", domain: "demo",
  agents: [
    testAgent({ slug: "spender", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "doomed", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["read"], domain: "demo" }),
  ],
  phases: [
    { name: "p1", chairs: [{ role: "r0", agent_slug: "spender", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] } as Chair] },
    { name: "p2", chairs: [{ role: "r1", agent_slug: "doomed", depends_on: ["r0"], input_contract: ["note"], output_contract: ["read"], required_skills: [] } as Chair] },
  ],
});

const burnThenDie: AgentInvoker = (ctx) => {
  if (ctx.agent.slug === "spender") {
    ctx.onEvent?.({ type: "result", raw: {
      type: "result", total_cost_usd: 0.42, usage: { input_tokens: 9000, output_tokens: 1500 },
      modelUsage: { "claude-opus-4-8": { inputTokens: 9000, outputTokens: 1500, costUSD: 0.42 } },
    } });
    return { t: "expensive" };
  }
  throw new Error("the scout hung and the phase died");
};

function deps(invoke: AgentInvoker, std: Standard): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(read);
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(),
  };
}

async function pollDone(d: ServerDeps, gid: string, ms = 4000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await dispatchTool("gig_monitor", { gig_id: gid }, d);
    const data = r.data as Record<string, unknown>;
    if (data["status"] !== "running") return data;
    if (Date.now() - t0 > ms) throw new Error(`gig ${gid} never left running: ${JSON.stringify(data)}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe("#236 — a failed gig still reports what it actually spent", () => {
  it("gig_monitor on a FAILED async gig reports the settled spend of the chairs that ran", async () => {
    const d = deps(burnThenDie, standard());
    const r = await dispatchTool("gig_dispatch", { standard_slug: "burns-then-dies", input: {} }, d);
    const gid = (r.data as { gig_id: string }).gig_id;
    const done = await pollDone(d, gid);

    expect(done["status"]).toBe("failed");
    expect(done["error"]).toMatch(/scout hung/);

    // THE DEFECT: the .catch sets status/finished_at/error and never state.usage, so $0.42 of
    // real, captured, settled spend is dropped on the floor. The outputs from the completed
    // chair DO persist — the artifact survives while the record of what it cost does not.
    const usage = done["usage"] as Record<string, unknown> | undefined;
    expect(usage, "a failed gig must still surface the spend it captured").toBeDefined();
    expect(usage!["total_cost_usd"]).toBeCloseTo(0.42, 6);
    expect(usage!["input_tokens"]).toBe(9000);

    // the deliberate invariant is untouched: an un-sealed gig writes no ledger row
    expect(d.ledger.query({}).length, "no ledger row for a crashed gig — that stays true").toBe(0);
  });

  it("the thrown error carries the partial usage, so a synchronous caller sees it too", async () => {
    const registry = createRegistry();
    registry.registerType(note);
    registry.registerType(read);
    let err: unknown;
    try {
      await runGig(standard(), {}, { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke: burnThenDie });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    const usage = (err as Record<string, unknown>)["usage"] as Record<string, unknown> | undefined;
    expect(usage, "partial settled spend must ride on the error").toBeDefined();
    expect(usage!["total_cost_usd"]).toBeCloseTo(0.42, 6);
  });

  it("a BudgetExhausted abort also carries the spend that was already settled", async () => {
    const registry = createRegistry();
    registry.registerType(note);
    registry.registerType(read);
    const std = standard();
    const spendOnly: AgentInvoker = (ctx) => {
      ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: 0.11, usage: { input_tokens: 10, output_tokens: 2 } } });
      return ctx.agent.slug === "spender" ? { t: "x" } : { summary: "y" };
    };
    let caught: BudgetExhausted | null = null;
    try {
      // opening=15, base_cost=10, k=0 → p1 settles at 10, p2 needs 10 against 5 → exhausted
      await runGig(std, {}, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke: spendOnly,
        budget: { opening: 15, base_cost: 10, k: 0 },
      });
    } catch (e) { if (e instanceof BudgetExhausted) caught = e; else throw e; }

    expect(caught).not.toBeNull();
    const usage = (caught as unknown as Record<string, unknown>)["usage"] as Record<string, unknown> | undefined;
    expect(usage, "BudgetExhausted must report the dollars already spent").toBeDefined();
    expect(usage!["total_cost_usd"]).toBeCloseTo(0.11, 6);
  });

  // ── the third thing a failed async gig loses ──────────────────────────────────────────────
  // #236 names three: no ledger row (deliberate, stays), no live-state usage, AND no
  // `budget_state`. The runtime attaches the budget snapshot to whatever it throws, but the
  // async dispatcher never read it back — so an operator whose gig died mid-run could not see
  // how much of the budget it had consumed, on the DEFAULT dispatch path. The synchronous
  // caller could (server.ts:428/438); the async one could not, which is backwards.
  it("gig_monitor on a FAILED async gig reports the budget it had already consumed", async () => {
    const d = deps(burnThenDie, standard());
    const r = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "burns-then-dies", input: {}, budget: { opening: 1000, base_cost: 10, k: 0 } },
      d,
    );
    const gid = (r.data as { gig_id: string }).gig_id;
    const done = await pollDone(d, gid);

    expect(done["status"]).toBe("failed");
    const bs = done["budget_state"] as Record<string, unknown> | undefined;
    expect(bs, "a failed gig must surface how much budget it burned").toBeDefined();
    // p1 succeeded and settled 10; p2's invoker threw, so its reservation was released (#232).
    expect(bs!["spent"], "only the chair that actually ran is charged").toBe(10);
    expect(bs!["balance"]).toBe(990);
    // and the real dollars ride alongside the synthetic units, correctly denominated (#233)
    expect(bs!["unit"]).toBe("append-units");
    expect(bs!["settled_usd"], "the REAL spend of the chairs that ran").toBeCloseTo(0.42, 6);
  });

  it("a SUCCESSFUL async gig surfaces its budget_state too (the same gap, success side)", async () => {
    const d = deps(
      (ctx) => (ctx.agent.slug === "spender" ? { t: "ok" } : { summary: "ok" }),
      standard(),
    );
    const r = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "burns-then-dies", input: {}, budget: { opening: 1000, base_cost: 10, k: 0 } },
      d,
    );
    const done = await pollDone(d, (r.data as { gig_id: string }).gig_id);
    expect(done["status"]).toBe("complete");
    const bs = done["budget_state"] as Record<string, unknown> | undefined;
    expect(bs, "budget_state was dropped on the async path regardless of outcome").toBeDefined();
    expect(bs!["spent"], "both chairs ran and settled").toBe(20);
    expect(bs!["agent_state"], "a completed cycle is settled").toBe("settled");
  });
});
