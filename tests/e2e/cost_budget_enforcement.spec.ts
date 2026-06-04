// e2e — T10: cost-budget enforcement (v3.3 cost-discipline standard).
//
// Standard (cajal substrate v1 + miles v3.3):
//   - Per-agent, per-cycle budget. balance = opening - spent + credit.
//   - Internal activity only spends. Balance increases ONLY via external
//     settlement credit.
//   - When balance < cost-of-next-append: agent YIELDS. Further append
//     attempts MUST raise BudgetExhausted (or equivalent runtime block).
//   - estimateCost gate (Constraint 5, src/coltrane_profile.ts) returns
//     {ok:false, violation:"budget_exceeded"} when estimated > budget —
//     but that's an advisory pre-flight, not the runtime enforcement.
//
// Honest scope: the substrate has the *domain type* for budget-state
// (origin/cajal/cost-budget-substrate-v1) and the *standard docs*
// (origin/tonight/miles/v3.3-cost-discipline-standard), but main has
// NO runtime enforcement on the gig executor or the ledger append.
// This spec asserts the gap and flips RED when the enforcement lands.
//
// Shape:
//   1. Pre-flight gate WORKS (estimateCost violation) — green today.
//   2. Runtime enforcement on gig_dispatch — RED today (no budget arg
//      accepted; no BudgetExhausted thrown after depletion). The
//      assertion documents the broken behavior to flip when fixed.
//   3. Ledger append after balance depletion — RED today (ledger has
//      no per-agent balance check). Documents the gap.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import {
  dispatchTool,
  bootstrapServerDeps,
  estimateCost,
  type ServerDeps,
} from "../../src/index.js";

describe("T10 — cost-budget enforcement (v3.3 cost-discipline)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);
  }, 60_000);
  afterAll(() => env?.cleanup());

  // -------------------------------------------------------------------------
  // Part 1 — Pre-flight cost gate (Constraint 5). Should be green.
  // -------------------------------------------------------------------------
  it("estimateCost gate: estimated > budget → violation:budget_exceeded", () => {
    const over = estimateCost({ estimated: 12.5, budget: 5.0 });
    expect(over.ok).toBe(false);
    expect(over.violation).toBe("budget_exceeded");

    const under = estimateCost({ estimated: 1.0, budget: 5.0 });
    expect(under.ok).toBe(true);

    const missing = estimateCost({ estimated: null, budget: 5.0 });
    expect(missing.ok).toBe(false);
    expect(missing.violation).toBe("no_estimate");
  });

  // -------------------------------------------------------------------------
  // Part 2 — Runtime enforcement on gig_dispatch. v3.3 says: when
  // balance < cost-of-next-append, the runtime should YIELD and raise
  // BudgetExhausted. Today, gig_dispatch does NOT accept a budget
  // argument or enforce depletion — it just returns ok:true.
  // -------------------------------------------------------------------------
  it("RED-honest: gig_dispatch does NOT enforce per-agent budget depletion (T10 gap)", async () => {
    // Cajal substrate exposes budget-state domain type. Miles' standard
    // says the runtime must honor it. Dispatch with an explicit budget
    // arg that is "already depleted" — runtime should refuse.
    const res = await dispatchTool(
      "gig_dispatch",
      {
        standard_slug: "summarize",
        input: { source: "test source" },
        // v3.3-shaped knobs that v3.3 says the runtime MUST honor:
        budget: { opening: 0.0, spent: 0.0, credit: 0.0, balance: 0.0 },
        cycle_id: "t10-test-cycle",
        agent_id: "summarizer",
      },
      deps,
    );

    // Today's behavior: dispatch either returns not_implemented (no invoke
    // wired in bootstrapServerDeps) OR ignores budget entirely. Neither is
    // BudgetExhausted. Document both gaps:
    const r = res as {
      ok?: boolean;
      not_implemented?: boolean;
      error?: string;
      data?: Record<string, unknown>;
    };
    const errStr = (r.error ?? "").toLowerCase();
    const isBudgetEnforced =
      errStr.includes("budget") ||
      errStr.includes("exhausted") ||
      errStr.includes("depleted");

    // GAP ASSERTION — flip RED when runtime adds enforcement:
    expect(isBudgetEnforced).toBe(false);

    // Sanity: the only error we get today is "needs standards + invoke
    // wired" OR ok:true with a gig_id. Either way, NOT BudgetExhausted.
    const knownNonBudgetOutcome =
      r.not_implemented === true ||
      errStr.includes("needs standards") ||
      errStr.includes("unknown standard") ||
      r.ok === true;
    expect(knownNonBudgetOutcome).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Part 3 — Ledger append after balance depletion. v3.3 says the ledger
  // is "append-only AND budget-aware": entries that would overspend
  // should be REJECTED, not silently accepted.
  // -------------------------------------------------------------------------
  it("RED-honest: ledger.append accepts entries with NO budget check (T10 gap)", () => {
    // Today the ledger has no awareness of per-agent balance — it accepts
    // any structurally-valid entry. v3.3 says appends past depletion
    // should throw BudgetExhausted. Capture the gap.
    const before = deps.ledger.count();
    let threw: Error | null = null;
    try {
      deps.ledger.append({
        gig_id: "t10-depletion-test",
        standard_slug: "summarize",
        genome_hash: "n/a",
        run_fingerprint: "n/a",
        output_hashes: [],
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    } catch (e) {
      threw = e as Error;
    }
    const after = deps.ledger.count();

    // GAP ASSERTION: today no throw, append succeeds. Flip when ledger
    // grows balance-awareness (a BudgetExhaustedError class wired in).
    expect(threw).toBeNull();
    expect(after).toBe(before + 1);

    // The ledger doesn't EXPOSE a per-agent balance API today either —
    // another fingerprint of the gap. Documented as a typed assertion
    // so it flips RED when a balance query lands.
    const ledgerAsAny = deps.ledger as unknown as Record<string, unknown>;
    expect(typeof ledgerAsAny["budgetBalance"]).toBe("undefined");
    expect(typeof ledgerAsAny["assertSpendAllowed"]).toBe("undefined");
  });

  // -------------------------------------------------------------------------
  // Part 4 — BudgetExhausted error class does not exist yet. When the
  // runtime is built, an exported BudgetExhausted (or BudgetError) class
  // is expected per v3.3. Today it isn't exported from src/index.ts.
  // -------------------------------------------------------------------------
  it("RED-honest: BudgetExhausted error class is not exported (T10 gap)", async () => {
    const idx = (await import("../../src/index.js")) as Record<string, unknown>;
    // Documented absence — flips RED when the class lands.
    expect(idx["BudgetExhausted"]).toBeUndefined();
    expect(idx["BudgetExhaustedError"]).toBeUndefined();
    // For completeness, no runBudgetedGig either:
    expect(idx["runBudgetedGig"]).toBeUndefined();
  });
});
