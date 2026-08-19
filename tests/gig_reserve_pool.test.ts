// RED-first — Item 2, the GIG-LEVEL OVERFLOW POOL: a per-gig quantity of reserve turns that a
// budget-exhausted chair draws from, with two governor constraints made into algebra rather than
// prose — a chair may NEVER draw more than its OWN declared turn_reserve even when the pool is
// larger (theft is impossible), and the pool CAN empty so a later chair finds nothing (starvation is
// reachable and must be VISIBLE, never silent).
//
// The pool lives on the dispatch payload (RunDeps.budget.pool — the primary source) with an optional
// standard-level default (Standard.reserve_pool); dispatch overrides the default (F5). The runtime
// caps each seated chair's offered reserve to `min(chair.turn_reserve, pool_remaining)` and threads
// THAT as ctx.turn_reserve into the invoker (the existing reserve-grant machinery consumes it). When
// the invoker actually grants (its budget_reserve_granted event fires), the runtime decrements the
// pool and appends an attributable draw record to the gig's budget snapshot. None of this exists
// yet: today ctx.turn_reserve is never set from a pool, no pool is tracked, and no draw is recorded —
// so every assertion below fails on BEHAVIOUR (an absent value / an un-decremented pool), not on a
// missing symbol.
//
// Covers contract INV8, INV9, INV10, INV11, INV12, INV13, INV18, INV19 and F2, F3, F5, F6, F7.
// The conservation laws (INV8-INV12) are pinned as fast-check properties over generated pools and
// chair-reserve vectors — the governor's two constraints are laws that must hold for EVERY ordering,
// not a hand-picked example the contract could satisfy by luck.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  makeClaudeInvoker,
  ChildExitError,
  defineAgent,
  type AgentInvoker,
  type AgentStreamEvent,
  type AgentInvocationContext,
  type DomainType,
  type Agent,
  type Standard,
  type GigProgressEvent,
} from "../src";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const hit: DomainType = {
  slug: "lineage-hit", extends: "Signal", domain: "eirtests",
  schema: { properties: { source: { type: "string" } } }, required_fields: ["source"],
};
const scout: Agent = {
  ...TEST_BEHAVIOR, slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"],
  domain: "eirtests",
};

/** A draw record the runtime is expected to append to the gig budget snapshot for post-run reading. */
interface DrawRecord {
  role?: string;
  granted: number;
  pool_remaining_after: number;
  denied?: boolean;
}

/**
 * Run a gig whose chairs each declare a turn_reserve and each HIT their budget and try to draw.
 * One chair per phase → strictly sequential, so the pool draw-down has a defined order. The stub
 * invoker plays the part of the real claude_invoker: it reads the reserve the runtime OFFERED it
 * (ctx.turn_reserve, already capped to min(own reserve, pool_remaining)) and fires the same
 * budget_reserve_granted event the real invoker fires — or a denial when the pool left it nothing.
 */
const runPoolGig = async (opts: {
  reserves: number[];
  pool?: number | undefined;
  standardDefaultPool?: number | undefined;
}): Promise<{ offered: Array<number | undefined>; budget_state: Record<string, unknown> | undefined }> => {
  const offered: Array<number | undefined> = [];
  const invoke: AgentInvoker = (c) => {
    const idx = Number((c.phase.match(/\d+$/) ?? ["0"])[0]);
    const declared = opts.reserves[idx]!;
    const off = (c as unknown as Record<string, unknown>)["turn_reserve"] as number | undefined;
    offered[idx] = off;
    // The chair hit its declared turn_budget and reaches for its reserve. If the runtime offered it
    // turns, that is a GRANT; if it declared a reserve but the pool is dry, that is a DENIED draw —
    // a starvation the record must show, not swallow.
    if (declared > 0) {
      if (off !== undefined && off > 0) {
        c.onEvent?.({ type: "budget_reserve_granted", raw: { agent: c.agent.slug, role: c.phase, reserve_turns: off, sealed_before_grant: [] } } as AgentStreamEvent);
      } else {
        c.onEvent?.({ type: "budget_reserve_denied", raw: { agent: c.agent.slug, role: c.phase, requested: declared, pool_remaining: 0 } } as AgentStreamEvent);
      }
    }
    return { source: `hit-${idx}` };
  };

  const phases = opts.reserves.map((r, i) => ({
    name: `sense-${i}`,
    chairs: [{
      role: `sense-${i}`, agent_slug: "scout", depends_on: [], input_contract: [],
      output_contract: ["lineage-hit"], required_skills: [], turn_reserve: r,
    }],
  }));
  const standard = {
    slug: "sweep", domain: "eirtests", agents: [scout],
    phases,
    ...(opts.standardDefaultPool !== undefined ? { reserve_pool: opts.standardDefaultPool } : {}),
  } as unknown as Standard;

  const registry = createRegistry();
  registry.registerType(hit);
  const res = await runGig(standard, {}, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke,
    // Big append-unit opening so the ORTHOGONAL append-unit gate never trips; `pool` is the new
    // dispatch-level reserve pool (Item 2), carried on the same dispatch budget input.
    budget: { opening: 1_000_000, ...(opts.pool !== undefined ? { pool: opts.pool } : {}) } as unknown as import("../src").BudgetInput,
  });
  return { offered, budget_state: res.budget_state as unknown as Record<string, unknown> | undefined };
};

const drawsOf = (bs: Record<string, unknown> | undefined): DrawRecord[] =>
  (bs?.["draws"] as DrawRecord[] | undefined) ?? [];

describe("the gig reserve pool obeys the governor's two constraints as laws", () => {
  it("INV8/INV9/INV10/INV11/INV12 — min-law, no-theft, conservation, monotonicity, visible starvation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 24 }), // pool opening
        fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 1, maxLength: 4 }), // per-chair declared reserves
        async (pool, reserves) => {
          const { offered, budget_state } = await runPoolGig({ reserves, pool });

          // Recompute the reference draw-down the runtime is obliged to produce.
          let remaining = pool;
          const expectedOffered: number[] = [];
          const grantedSeq: number[] = [];
          let starvedSomewhere = false;
          for (const r of reserves) {
            const off = Math.min(r, remaining); // INV8 — effective_draw = min(own reserve, pool_remaining)
            expectedOffered.push(off);
            if (r > 0 && off > 0) { grantedSeq.push(off); remaining -= off; }
            if (r > 0 && off === 0) starvedSomewhere = true; // INV12 — declared a reserve, pool gave nothing
          }

          // INV8 + INV9 (no-theft): each chair that DECLARED a reserve is offered exactly
          // min(own reserve, pool-at-its-turn) — never more than its own declared reserve even when
          // the pool is larger. A chair declaring no reserve (r===0) does not draw and is not asserted.
          reserves.forEach((r, i) => {
            if (r === 0) return;
            expect(offered[i], `chair ${i} was offered a reserve the runtime never computed from the pool`).toBe(expectedOffered[i]);
            expect((offered[i] ?? 0) <= r, `chair ${i} drew more than its own declared reserve — theft`).toBe(true);
          });

          const draws = drawsOf(budget_state);
          const grants = draws.filter((d) => !d.denied);
          // INV10 — conservation: the pool never lends more than it opened with, and never goes negative.
          const totalGranted = grants.reduce((s, d) => s + d.granted, 0);
          expect(totalGranted <= pool, "the pool lent more turns than it held — conservation broken").toBe(true);
          expect((budget_state?.["pool_remaining"] as number) >= 0, "pool_remaining went negative").toBe(true);
          expect(budget_state?.["pool_remaining"], "pool_remaining did not settle to opening minus the granted draws").toBe(remaining);

          // INV11 — monotonicity: pool_remaining_after is non-increasing across the granted draws.
          let prev = pool;
          for (const d of grants) {
            expect(d.pool_remaining_after <= prev, "a draw INCREASED pool_remaining — the pool only draws down in v0").toBe(true);
            prev = d.pool_remaining_after;
          }

          // INV12 — starvation is reachable AND recorded: if any chair wanted a reserve the empty pool
          // could not give, there is a visible denied-draw record, not a silent no-op.
          if (starvedSomewhere) {
            expect(draws.some((d) => d.denied), "a chair was starved by an empty pool and NOTHING recorded it").toBe(true);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("INV13/F6 — every draw is attributable: {role, granted, pool_remaining_after} on the snapshot", async () => {
    const { budget_state } = await runPoolGig({ reserves: [4, 3], pool: 10 });
    const draws = drawsOf(budget_state);
    expect(draws.length, "two chairs drew from the pool but no attributable draw records were kept").toBe(2);
    for (const d of draws) {
      expect(typeof d.role, "a draw with no drawing-chair identity is not attributable").toBe("string");
      expect(typeof d.granted, "a draw with no granted turn count is not attributable").toBe("number");
      expect(typeof d.pool_remaining_after, "a draw that does not say what the pool had left after it is not attributable").toBe("number");
    }
  });

  it("F5 — the dispatch pool OVERRIDES the standard's default pool, deterministically (no max/sum)", async () => {
    // standard default 10, dispatch 3 → the dispatch value wins: the first chair (reserve 5) is capped
    // to 3 by the smaller dispatch pool, and the pool empties.
    const { offered, budget_state } = await runPoolGig({ reserves: [5], pool: 3, standardDefaultPool: 10 });
    expect(offered[0], "the dispatch pool did not win over the standard default — resolution is ambiguous").toBe(3);
    expect(budget_state?.["pool_remaining"], "the effective pool was not the dispatch value of 3").toBe(0);
  });

  it("F3 — a later chair after the pool is dry draws nothing and is recorded as starved", async () => {
    // pool 4: chair0 (reserve 4) drains it, chair1 (reserve 4) finds nothing.
    const { offered, budget_state } = await runPoolGig({ reserves: [4, 4], pool: 4 });
    expect(offered[0], "the first chair should have drawn its whole reserve from the pool").toBe(4);
    expect(offered[1], "the second chair drew from a pool that was already empty — the pool lent what it did not hold").toBe(0);
    const draws = drawsOf(budget_state);
    expect(draws.some((d) => d.denied), "the starved second chair produced no visible denied-draw record").toBe(true);
  });

  it("INV18 — a reserve draw is ORTHOGONAL to the append-unit budget: it moves the pool, not spent", async () => {
    // Two identical gigs; one draws from a pool, one has no pool. The append-unit accounting
    // (spent/balance) must be identical — a turn draw is not an append-unit spend.
    const withPool = await runPoolGig({ reserves: [3], pool: 5 });
    const noPool = await runPoolGig({ reserves: [3] });
    expect(withPool.budget_state?.["spent"], "a turn-reserve draw changed the append-unit spend — the two ledgers are conflated").toBe(noPool.budget_state?.["spent"]);
    expect(withPool.budget_state?.["balance"], "a turn-reserve draw changed the append-unit balance — the two ledgers are conflated").toBe(noPool.budget_state?.["balance"]);
    expect(withPool.budget_state?.["pool_remaining"], "the draw did not decrement the pool it was supposed to move").toBe(2);
  });
});

// ── INV19 / F7 — the empty-pool boundary preserves sealed writes AND makes the starvation visible ──
// This is the INVOKER seam (parallel to, and NOT modifying, chair_budget_stop_keeps_sealed_writes.ts):
// a chair stopped at its budget with an empty pool (ctx.turn_reserve resolves to 0) keeps every output
// already sealed past the write boundary — unchanged — but must now ALSO emit a visible denial so the
// starvation is not silent. Today the invoker reads only opts.turn_reserve and emits nothing when it
// grants nothing, so the denial half is RED while the keep-writes half is the green guard.
const write = (id: string, source: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "mcp__coltrane__output_write", input: { domain_type: "lineage-hit", data: { source } } }] },
  });
const budgetStop = (...w: string[]): string =>
  [...w, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })].join("\n");

const scoutAgent = () =>
  defineAgent({
    slug: "budget-scout", primitives: ["SENSE"], input_types: [], output_types: ["lineage-hit"],
    identity: "a scout whose reserve is the gig pool's to give", method: "sweep and seal each hit",
    constraints: ["seal before the budget runs out"], behavioral_primitives: ["explorer", "analyst"],
    allowed_tools: ["WebSearch"], max_tool_calls: 20,
  });

describe("a chair stopped at its budget with an EMPTY pool keeps its writes and shows the starvation", () => {
  it("keeps the sealed write (green guard) AND emits a visible denied-draw (RED)", async () => {
    const events: AgentStreamEvent[] = [];
    const run = () => { throw new ChildExitError("claude exited 1: ", budgetStop(write("w1", "Grossi et al."))); };
    // ctx.turn_reserve === 0: the gig pool had nothing left for this chair. opts.turn_reserve unset.
    const ctx = ({
      agent: scoutAgent(), phase: "identify", gig_id: "g1", inputs: [], gig_input: {},
      output_types: ["lineage-hit"], turn_reserve: 0,
      onEvent: (ev: AgentStreamEvent) => events.push(ev),
    }) as unknown as AgentInvocationContext;

    const out = (await makeClaudeInvoker({ model: "claude-sonnet-4-6", sealVia: "output_write", run })(ctx)) as Record<string, Array<Record<string, unknown>>>;

    // keep-sealed-writes still holds on the empty-pool path (must not regress the pinned behaviour).
    // The seal path now keeps a LIST of accepted writes per type; the single sealed write is its
    // sole element.
    expect(out["lineage-hit"]![0]!["source"], "a budget-stopped chair lost its sealed write on the empty-pool path").toBe("Grossi et al.");
    // starvation is now VISIBLE: a chair that hit its budget and the pool could not extend it says so.
    expect(
      events.some((e) => /denied|starv|no_reserve|no-grant/i.test(e.type) || (e.raw as Record<string, unknown> | undefined)?.["pool_remaining"] === 0),
      "the chair hit its budget with an empty pool and NOTHING said so — starvation was silent",
    ).toBe(true);
  });
});

// Referenced so the GigProgressEvent import is load-bearing for readers wiring the observable.
export type _PoolProgress = GigProgressEvent;
