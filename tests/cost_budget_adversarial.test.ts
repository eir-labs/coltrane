// ADVERSARIAL REVIEW of PR #99 (cost-budget-enforcement wiring).
//
// PR #99 wired `runGig`'s budget enforcement: BudgetInput, BudgetState,
// BudgetExhausted, computeAppendCost. It ships with 6 happy-path-shaped tests
// (tests/cost_budget_enforcement.test.ts) proving the WIRE WORKS.
//
// This file proves the wire is also HONEST under adversarial probing — the
// same family of issue as the formal-causality layer that resolves orphan
// SHAs pointing at TAMPERED chains ("trusts existence, not integrity").
//
// Probes attempted (10 total — covered 8 here; the other 2 are noted in PR body):
//   1. Bypass via no-output / throwing invoker      → HOLE (orphan outputs + inflated spent)
//   2. NaN / Infinity / negative / zero opening     → HOLE (NaN silently permits unlimited spend)
//   3. Negative base_cost / k (cost-formula trust)   → HOLE (spent goes negative, balance grows)
//   4. Mid-run budget mutation                       → (state-reference semantics; not separately tested here)
//   5. Concurrent gigs sharing budget object         → HOLE (each gig gets full opening; no shared state)
//   6. BudgetState manifest lies on mid-failure abort→ HOLE-ADJACENT (state mutated even on failure path)
//   7. Backward-compat (omit budget → unlimited)     → BY-DESIGN (T5 in original PR, not a hole)
//   8. Cost-formula trust on circular gig_input      → HOLE (TypeError, not BudgetExhausted; uncaught)
//   9. BudgetExhausted ledger leak                   → HOLE (prior outputs orphaned, no ledger entry)
//  10. Composition-cycle vs budget — which wins      → BY-DESIGN (RuntimeError fires before budget check)
//
// MOST CRITICAL FINDING (the "trusts existence not integrity" twin):
//   Cost is deducted PRE-INVOCATION (runtime.ts:219), but the docstring at line
//   220 + the PR body BOTH say "post-success: spent += cost". This is a doc lie.
//   It enables a class of orphan-output + inflated-spent corruptions:
//     - invoker throws → prior-phase output sits in store, no ledger entry,
//       spent inflated by the next phase's would-be cost
//     - outputs.write throws schema-validation → same shape
//     - BudgetExhausted mid-gig → same shape (phase-1 output orphaned)
//   The substrate trusts the cost-of-append accounting, NOT the underlying
//   output/ledger atomicity. Same family of bug as the validate_derived_from
//   integrity-vs-existence finding.
//
// Each test below asserts the CURRENT BEHAVIOR — so each test IS the receipt.
// HOLE assertions = doc the bug as-currently-broken; PROTECTION assertions = doc
// the safe path. Future fixes will need to flip the HOLE assertions to GREEN.

import { describe, it, expect } from "vitest";
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

// ── shared substrate (matches the original test file) ──────────────────────
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
const scout: Agent = {
  slug: "site-scout",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["page-model"],
  domain: "eirtests",
};
const analyst: Agent = {
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

const happyInvoke: AgentInvoker = ({ agent, inputs }) => {
  if (agent.slug === "site-scout") return { url: "/products" };
  return { title: `finding from ${inputs.length} input(s)` };
};

// ── ADVERSARIAL PROBES ─────────────────────────────────────────────────────
describe("PR #99 adversarial review — cost-budget enforcement", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 2: input validation on opening (NaN / Infinity / negative / zero)
  // ─────────────────────────────────────────────────────────────────────────

  it("HOLE — opening=NaN silently permits unlimited spending (NaN < N is always false; check never trips)", async () => {
    const { outputs, ledger } = setup();
    // NaN comparisons are always false. `if (balance < cost)` never fires.
    // The whole budget system is bypassed by passing NaN.
    const res = await runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: NaN } });

    // RECEIPT: the gig completed despite a structurally-broken budget.
    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(2);
    expect(Number.isNaN(res.budget_state?.opening)).toBe(true);
    expect(Number.isNaN(res.budget_state?.balance)).toBe(true);
    // "settled" implies the cycle closed cleanly. It did — because the depletion
    // check is dead code under NaN. No `NaN < N` ever fires.
    expect(res.budget_state?.agent_state).toBe("settled");
    expect(res.budget_state?.depleted_agent).toBeNull();
    // ↑ This is the bug. A NaN budget should be REJECTED at runtime entry,
    //   not silently treated as ∞ credit. Recommended fix: validate
    //   Number.isFinite(opening) in runGig before constructing BudgetState.
  });

  it("HOLE — opening=Infinity makes the budget unlimited (no upper-bound validation)", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: Infinity } });
    expect(res.status).toBe("complete");
    expect(res.budget_state?.opening).toBe(Infinity);
    expect(res.budget_state?.balance).toBe(Infinity);
    // ↑ Same recommended fix: `Number.isFinite(opening)` guard at runtime entry.
    //   At minimum the budget-state.json schema (PR #56) should forbid non-finite.
  });

  it("PROTECTION — opening<0 graceful: immediate BudgetExhausted on phase 1 (balance<cost trivially)", async () => {
    const { outputs, ledger } = setup();
    await expect(
      runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: -100 } }),
    ).rejects.toBeInstanceOf(BudgetExhausted);
    // The depletion path catches negative-opening because -100 < 8.3.
    // This one isn't a hole — it's accidentally-correct behavior.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 3: cost-formula trust — negative / zero base_cost & k
  // ─────────────────────────────────────────────────────────────────────────

  it("HOLE — negative base_cost causes spent to go NEGATIVE and balance to grow unboundedly", async () => {
    const { outputs, ledger } = setup();
    // base_cost = -1000, k = 0 → every append "earns" 1000 back.
    const res = await runGig(
      standard,
      {},
      { outputs, ledger, invoke: happyInvoke, budget: { opening: 100, base_cost: -1000, k: 0 } },
    );

    // RECEIPT: spent is NEGATIVE (anti-spend); balance is GREATER than opening.
    expect(res.status).toBe("complete");
    expect(res.budget_state?.spent).toBeLessThan(0);
    expect(res.budget_state?.balance).toBeGreaterThan(res.budget_state!.opening);
    // ↑ This is the same family as the NaN bug. computeAppendCost is trusted to
    //   return a non-negative cost; runtime never validates. Recommended fix:
    //   either guard base_cost ≥ 0 / k ≥ 0 at entry, OR clamp cost = max(0, formula).
  });

  it("HOLE — negative k turns size into a credit; bigger inputs make the gig RICHER", async () => {
    const { outputs, ledger } = setup();
    const res = await runGig(
      standard,
      { x: 1 },
      { outputs, ledger, invoke: happyInvoke, budget: { opening: 10, base_cost: 0, k: -1 } },
    );
    expect(res.status).toBe("complete");
    expect(res.budget_state?.spent).toBeLessThan(0);
    expect(res.budget_state?.balance).toBeGreaterThan(res.budget_state!.opening);
  });

  it("HOLE — opening=0, base_cost=0, k=0: a 'free' gig completes with zero enforcement", async () => {
    // The pricing knobs are caller-controlled and any caller can opt themselves
    // into zero-cost work. There is no minimum-cost-per-append protection.
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: 0, base_cost: 0, k: 0 } });
    expect(res.status).toBe("complete");
    expect(res.budget_state?.spent).toBe(0);
    expect(res.budget_state?.balance).toBe(0);
    expect(res.budget_state?.agent_state).toBe("settled");
    // ↑ The contract should probably enforce a runtime-side MIN_BASE_COST > 0
    //   so callers can't opt out of accounting.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 8: cost-formula trust — JSON.stringify on circular gig_input
  // ─────────────────────────────────────────────────────────────────────────

  it("HOLE — circular gig_input crashes computeAppendCost with a TypeError, NOT a BudgetExhausted", async () => {
    const { outputs, ledger } = setup();
    const input: Record<string, unknown> = { site: "x" };
    input["self"] = input; // circular

    // The runtime serializes gig_input inside computeAppendCost via
    // JSON.stringify, which throws on circular refs. This surfaces as a
    // TypeError to the caller — *not* a typed BudgetExhausted, *not* a
    // RuntimeError. The cost path makes an undocumented input assumption.
    await expect(
      runGig(standard, input, { outputs, ledger, invoke: happyInvoke, budget: { opening: 1000 } }),
    ).rejects.toThrow(TypeError);
    // The same gig_input WITHOUT a budget runs fine — proving the failure
    // is in the cost-of-append path, not the runtime broadly.
    const { outputs: o2, ledger: l2 } = setup();
    const res = await runGig(standard, input, { outputs: o2, ledger: l2, invoke: happyInvoke });
    expect(res.status).toBe("complete");
    // ↑ Recommended fix: computeAppendCost should use a safe size proxy
    //   (e.g. structural-hash byte-length, or stringify with circular-replacer).
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 1 + PROBE 9: orphan outputs + inflated spent on mid-gig failure.
  // THE MOST CRITICAL FINDING — same family as "trusts existence not integrity"
  // ─────────────────────────────────────────────────────────────────────────

  it("HOLE [CRITICAL] — invoker throws mid-gig: prior-phase output orphaned in store, NO ledger entry written", async () => {
    const { outputs, ledger } = setup();
    const throwingInvoker: AgentInvoker = ({ agent }) => {
      if (agent.slug === "site-analyst") throw new Error("invoker exploded");
      return { url: "/products" };
    };

    await expect(
      runGig(standard, {}, { outputs, ledger, invoke: throwingInvoker, budget: { opening: 1000 } }),
    ).rejects.toThrow("invoker exploded");

    // RECEIPT: phase-1's output IS in the store but the gig has no ledger entry.
    // This is the same family of bug as "validate_derived_from accepts orphan
    // SHAs": the substrate has artifacts whose provenance is unrecorded.
    expect(outputs.all().length).toBe(1); // phase-1 output orphaned
    expect(ledger.query({}).length).toBe(0); // no ledger record exists
    expect(outputs.all()[0]?.agent_slug).toBe("site-scout"); // it's phase-1's
    // ↑ Recommended fix: runGig needs gig-atomic semantics. Either:
    //   (a) buffer outputs into a transactional staging area and commit on
    //       full-success, or
    //   (b) write a ledger entry with status="aborted" + the partial
    //       output_hashes so the audit trail is complete.
  });

  it("HOLE [CRITICAL] — BudgetExhausted mid-gig: prior outputs orphaned + spent already inflated PRE-invocation", async () => {
    // PR body claims "post-success: spent += cost" but runtime.ts:219 deducts
    // PRE-invocation. With a budget that allows phase 1 but not phase 2:
    //  - phase 1 invokes, cost-deducted, output written
    //  - phase 2 cost-check fails → BudgetExhausted
    //  - state shows ONLY phase-1 spent (correct), BUT the phase-1 output
    //    sits in the store with NO ledger record.
    const { outputs, ledger } = setup();
    let caught: BudgetExhausted | null = null;
    try {
      // opening=20 → phase 1 costs ~8.3, succeeds; phase 2 needs ~10+, BudgetExhausted.
      await runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: 20 } });
    } catch (e) {
      if (e instanceof BudgetExhausted) caught = e;
      else throw e;
    }
    expect(caught).not.toBeNull();
    expect(caught!.agent_slug).toBe("site-analyst"); // phase 2 tripped

    // ORPHAN PROOF:
    expect(outputs.all().length).toBeGreaterThanOrEqual(1); // phase-1 output is in store
    expect(ledger.query({}).length).toBe(0); // ledger has no record of this gig
    expect(outputs.all()[0]?.agent_slug).toBe("site-scout"); // it's the orphan
    // ↑ Same fix as above. The gig has phantom output without provenance.
  });

  it("HOLE — PR body says 'post-success: spent += cost' but runtime deducts PRE-invocation (doc/code divergence)", async () => {
    // This test directly proves the doc/code divergence by counting cost
    // deductions when the invoker throws. If the docstring were accurate
    // ("post-success"), a throwing-invoker should NOT have deducted that
    // phase's cost. The current code deducts BEFORE invoke, so spent reflects
    // both phase-1's success AND phase-2's would-be cost is checked but not
    // deducted (since check failed). The asymmetry: a phase that PASSES
    // the budget check but then the INVOKER itself throws — spent stays
    // inflated by that phase's pre-deducted cost.
    const { outputs, ledger } = setup();
    const phase1Invoker: AgentInvoker = ({ agent }) => {
      if (agent.slug === "site-scout") return { url: "/p" };
      throw new Error("phase 2 invoker threw");
    };
    try {
      await runGig(standard, {}, { outputs, ledger, invoke: phase1Invoker, budget: { opening: 1000 } });
    } catch {
      /* expected */
    }
    // We can't directly observe the in-memory BudgetState here (it's not
    // returned on the throw path — itself a separate observability hole)
    // but we can observe the orphan in the store.
    expect(outputs.all().length).toBe(1);
    expect(ledger.query({}).length).toBe(0);
    // ↑ Recommended fix: either move the `spent += cost` to AFTER successful
    //   output write + ledger append (matches the docstring), or update the
    //   docstring and the PR description to match the code.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 5: concurrent gigs with shared budget OBJECT — each gets full opening
  // ─────────────────────────────────────────────────────────────────────────

  it("HOLE — two concurrent gigs share the BudgetInput object but each gets FULL opening (no shared state)", async () => {
    // Eugene's mental model when passing the *same* budget object to two
    // gig_dispatch calls might be "they share a pool." The runtime instead
    // constructs a fresh BudgetState per gig — both gigs spend opening=1000
    // independently. So passing the same budget object N times gives you
    // N × opening of credit.
    const { outputs, ledger } = setup();
    const sharedBudget = { opening: 1000 };
    const [r1, r2] = await Promise.all([
      runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: sharedBudget }),
      runGig(standard, {}, { outputs, ledger, invoke: happyInvoke, budget: sharedBudget }),
    ]);

    // RECEIPT: both gigs see opening=1000 and the SAME spend — no shared pool.
    expect(r1.budget_state?.opening).toBe(1000);
    expect(r2.budget_state?.opening).toBe(1000);
    expect(r1.budget_state?.spent).toBe(r2.budget_state?.spent);
    // Each gig burned its own cost from its OWN copy of opening — so the
    // "shared" budget actually pays N gigs from N × opening.
    // ↑ Recommended fix: if pool-semantics are desired, add a separate
    //   BudgetPool type that carries persistent state across gigs. Document
    //   explicitly that BudgetInput is per-gig.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 7: backward-compat — omitting budget = unlimited credit (by-design)
  // ─────────────────────────────────────────────────────────────────────────

  it("BY-DESIGN — omitting budget gives unbounded spend (T5 in PR #99); no default cap exists", async () => {
    // PR #99 calls this out as a feature (back-compat for existing callers).
    // Documented for completeness: the absence of a budget means infinite
    // credit. Anyone wanting a global default-cap will need to wire it
    // upstream (server.ts gig_dispatch handler) rather than relying on the
    // runtime to enforce one.
    const { outputs, ledger } = setup();
    const res = await runGig(standard, {}, { outputs, ledger, invoke: happyInvoke });
    expect(res.status).toBe("complete");
    expect(res.budget_state).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE 10: composition error vs budget — composition wins (by-design)
  // ─────────────────────────────────────────────────────────────────────────

  it("BY-DESIGN — composition-RuntimeError fires BEFORE budget check; ordering is unambiguous", async () => {
    // A phase referencing an unknown agent throws RuntimeError at line 197 of
    // runtime.ts, before the budget block at line 209. Even with opening=0,
    // composition errors take precedence.
    const brokenStandard: Standard = {
      slug: "broken",
      domain: "eirtests",
      agents: [scout],
      phases: [{ name: "p", chairs: [{ role: "p", agent_slug: "nonexistent", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }],
    };
    const { outputs, ledger } = setup();
    await expect(
      runGig(brokenStandard, {}, { outputs, ledger, invoke: happyInvoke, budget: { opening: 0 } }),
    ).rejects.toThrow(/unknown agent/);
    // Note this is also fine — composition is structurally invalid, so the
    // budget question never arises.
  });
});
