// Lighthouse G3 / L3 — hoarding-decay at cycle rollover.
//
// Per finitude-budget v3.3 (eir spec):
//   A voice's hoarded balance MUST NOT persist forever. Across a `budget_period`
//   boundary, undecayed balance is subject to `decay_delta` (a multiplicative or
//   subtractive penalty) so that hoarding is bounded — the world (G1 mint) is the
//   only source of fresh quota, and accumulated unused budget gradually returns
//   toward equilibrium rather than ratcheting infinitely upward.
//
// This is the L3 check. The capabilities required from coltrane-oss runtime:
//   (a) a per-voice (per-agent / per-coltrane-profile) BUDGET BALANCE that is
//       *stateful* across gigs (not just a per-gig hard ceiling),
//   (b) a `budget_period` field on the profile / runtime config that defines the
//       rollover boundary (wall-clock or gig-count),
//   (c) a `decay_delta` parameter applied at the boundary,
//   (d) the runtime advancing the period when invoked across a boundary and
//       applying the decay to any carried balance.
//
// PRE-REG HONESTY (T10 finding): the cost-budget runtime DOES NOT EXIST in
// coltrane-oss. There is exactly one budget surface: `max_token_budget` on the
// ColtraneProfile — a STATIC per-gig hard ceiling enforced inside
// estimateCostAndGate(). There is no stateful balance, no period boundary, no
// decay primitive, no rollover code path. This test does not pretend otherwise.
// It documents the absence by asserting on the absence — RED-honest by design.
//
// Lighthouse interpretation: a GREEN L3 here would require the v3.3 spec to land
// in code first (new primitive + profile fields + runtime tick). Until then the
// honest verdict is `not_implemented` and this test fails loudly so the gap
// stays visible on every run instead of papering itself over.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./_harness.js";

// --------------------------------------------------------------------------
// helpers — surface scans against the live tree (no mocks, no test fixtures)
// --------------------------------------------------------------------------

function readIfExists(rel: string): string | null {
  const p = join(REPO_ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf-8") : null;
}

function listSrcFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
    }
  }
  walk(join(REPO_ROOT, "src"));
  walk(join(REPO_ROOT, "core_types"));
  walk(join(REPO_ROOT, "domain_types"));
  return out;
}

function grepSrc(pattern: RegExp): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const f of listSrcFiles()) {
    const lines = readFileSync(f, "utf-8").split("\n");
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file: f, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

// --------------------------------------------------------------------------
// L3 — hoarding decay at cycle rollover
// --------------------------------------------------------------------------

describe("L3 — hoarding decay at budget_period rollover (finitude-budget v3.3)", () => {
  it("the runtime exposes a stateful budget BALANCE per voice (not just per-gig ceiling)", () => {
    // Acceptance: a balance store that survives across gig invocations.
    // Search surface: any of `budget_balance`, `balance`, `budget_state`, `voice_balance`.
    const balanceHits = grepSrc(/\b(budget_balance|budgetBalance|voice_balance|budget_state|hoarded_balance)\b/);
    expect(
      balanceHits,
      "no stateful budget BALANCE primitive found in src/ — only `max_token_budget` (a per-gig static ceiling) exists. " +
        "v3.3 requires a balance that accumulates and decays across gigs."
    ).not.toHaveLength(0);
  });

  it("the profile schema declares `budget_period` (rollover boundary)", () => {
    const periodHits = grepSrc(/\bbudget_period\b/);
    expect(
      periodHits,
      "no `budget_period` field declared in profile / runtime config. " +
        "v3.3 requires a named period (wall-clock window or gig-count) to define the rollover boundary."
    ).not.toHaveLength(0);
  });

  it("the profile schema declares `decay_delta` (penalty applied at boundary)", () => {
    const decayHits = grepSrc(/\bdecay_delta\b/);
    expect(
      decayHits,
      "no `decay_delta` field declared. " +
        "v3.3 requires a configurable decay applied to carried balance at each period boundary."
    ).not.toHaveLength(0);
  });

  it("the runtime contains a decay primitive (function that applies decay_delta at rollover)", () => {
    // Acceptance: any of decay(), applyDecay(), rollover(), tickPeriod() in src/runtime or src/budget.
    const decayFnHits = grepSrc(/\b(applyDecay|decayBalance|rolloverBudget|tickBudgetPeriod|advancePeriod)\s*\(/);
    expect(
      decayFnHits,
      "no decay primitive function found. v3.3 requires the runtime to ADVANCE the period " +
        "and APPLY decay_delta to any carried balance — neither code path exists."
    ).not.toHaveLength(0);
  });

  it("the runtime tests cover the boundary case (balance > 0 before rollover; balance < initial after)", () => {
    // Acceptance: at least one test file under tests/ exercises a rollover crossing.
    const testHits = grepSrc(/rollover|period_boundary|cycle_rollover|budget_decay/i);
    // grepSrc only walks src/ + types; expand to tests/.
    const testFiles: string[] = [];
    function walk(dir: string): void {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) testFiles.push(full);
      }
    }
    walk(join(REPO_ROOT, "tests"));
    const boundaryTestHits = testFiles.filter((f) => {
      // skip THIS spec — self-reference doesn't count as coverage.
      if (f.endsWith("lighthouse_g3_hoarding_decay.spec.ts")) return false;
      const txt = readFileSync(f, "utf-8");
      return /rollover|period_boundary|cycle_rollover|budget_decay|hoarding/i.test(txt);
    });
    expect(
      boundaryTestHits.length + testHits.length,
      "no existing test exercises a budget_period boundary crossing with decay_delta application. " +
        "the cost-budget runtime is absent end-to-end (no impl, no tests)."
    ).toBeGreaterThan(0);
  });

  it("DIAGNOSTIC — current budget surface is a per-gig hard ceiling only (documents the gap)", () => {
    // This assertion PASSES — it's the honest baseline: what DOES exist.
    // Together with the four failing assertions above, the spec file reports:
    //   - present: max_token_budget (static, per-gig)
    //   - absent: balance / period / decay / rollover (the v3.3 stateful surface)
    const profile = readIfExists("src/coltrane_profile.ts");
    expect(profile, "src/coltrane_profile.ts should exist").not.toBeNull();
    expect(profile!).toMatch(/max_token_budget/);
    // Confirm it's static (literal default + ceiling check, no period state).
    expect(profile!).toMatch(/max_token_budget:\s*\d/);
    // Confirm budget_exceeded is a per-call gate, not a balance check.
    expect(profile!).toMatch(/budget_exceeded/);
    // And confirm the v3.3 surface is genuinely absent here too.
    expect(profile!, "v3.3 fields must not silently appear without runtime backing").not.toMatch(/budget_period/);
    expect(profile!, "v3.3 fields must not silently appear without runtime backing").not.toMatch(/decay_delta/);
  });
});
