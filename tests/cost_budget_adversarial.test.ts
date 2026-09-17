// ADVERSARIAL, REWRITTEN to the budget-in-dollars contract. The original file (PR #99 review) pinned
// the append-unit holes as PASSING receipts: opening=NaN/Infinity "silently permits unlimited
// spending", opening<0 trips by accident, negative base_cost/k make spend go negative. Under the
// contract those holes are REFUSALS: a malformed dollar ceiling must be rejected by gig_dispatch
// BEFORE any chair runs, naming the field and the value — never silently run with no ceiling.
//
// Homes contract failure modes:
//   F1 — budget is not an object, or max_usd is missing / not a number / NaN / Infinity / zero /
//        negative → gig_dispatch refuses before anything runs, naming max_usd and the value.
//   F2 — budget carries the retired append-unit fields (opening, base_cost, k) → gig_dispatch refuses
//        naming each retired field and pointing at max_usd; they are never accepted and ignored.
//
// RED against today's src: src/server.ts reads `budgetArg["opening"]` and, finding none (or a
// non-number), sets `budget = undefined` — so every malformed budget here runs UNENFORCED to
// completion (ok:true, chairs invoked) instead of being refused.
import { describe, it, expect } from "vitest";
import { dispatchTool } from "../src/server.js";
import { budgetDeps, spendStandard, spendingInvoker } from "./_support/budget_dispatch.js";

async function dispatchWithBudget(budget: unknown): Promise<{ ok: boolean; error: string | undefined; seen: string[] }> {
  const seen: string[] = [];
  const deps = budgetDeps(spendStandard(2), spendingInvoker(0.01, seen));
  const r = (await dispatchTool(
    "gig_dispatch",
    { standard_slug: "spend", input: {}, wait: true, budget },
    deps,
  )) as { ok: boolean; error?: string };
  return { ok: r.ok, error: r.error, seen };
}

describe("F1 — a malformed dollar ceiling is refused by gig_dispatch before anything runs", () => {
  const cases: ReadonlyArray<{ name: string; budget: unknown; needle: string }> = [
    { name: "budget is not an object (a bare number)", budget: 45, needle: "45" },
    { name: "budget is not an object (a string)", budget: "45", needle: "45" },
    { name: "max_usd is missing", budget: {}, needle: "max_usd" },
    { name: "max_usd is not a number", budget: { max_usd: "45" }, needle: "max_usd" },
    { name: "max_usd is NaN", budget: { max_usd: Number.NaN }, needle: "NaN" },
    { name: "max_usd is Infinity", budget: { max_usd: Number.POSITIVE_INFINITY }, needle: "Infinity" },
    { name: "max_usd is zero", budget: { max_usd: 0 }, needle: "0" },
    { name: "max_usd is negative", budget: { max_usd: -5 }, needle: "-5" },
  ];

  it.each(cases)("$name → refused, naming the field/value, nothing ran", async ({ budget, needle }) => {
    const { ok, error, seen } = await dispatchWithBudget(budget);
    expect(ok, "a malformed dollar budget ran the gig with no ceiling instead of being refused").toBe(false);
    expect(seen.length, "a chair started under a malformed budget — the refusal was not before anything ran").toBe(0);
    expect(error ?? "", "the refusal did not name the budget field").toMatch(/max_usd/);
    expect(error ?? "", `the refusal did not name the offending value (${needle})`).toContain(needle);
  });
});

describe("F2 — a budget carrying the retired append-unit fields is refused, pointed at max_usd", () => {
  const cases: ReadonlyArray<{ name: string; budget: unknown; retired: string }> = [
    { name: "opening (the old append-unit ceiling)", budget: { opening: 45 }, retired: "opening" },
    { name: "base_cost alongside a max_usd", budget: { max_usd: 45, base_cost: 1 }, retired: "base_cost" },
    { name: "k alongside a max_usd", budget: { max_usd: 45, k: 0.1 }, retired: "k" },
  ];

  it.each(cases)("$name → refused, naming the retired field and max_usd, nothing ran", async ({ budget, retired }) => {
    const { ok, error, seen } = await dispatchWithBudget(budget);
    expect(ok, `a budget carrying the retired append-unit field "${retired}" was accepted instead of refused`).toBe(false);
    expect(seen.length, "a chair started despite a budget carrying a retired append-unit field").toBe(0);
    expect(error ?? "", `the refusal did not name the retired field "${retired}"`).toContain(retired);
    expect(error ?? "", "the refusal did not point the caller at max_usd").toMatch(/max_usd/);
  });
});
