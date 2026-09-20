// A TOOL'S PROSE AND ITS SCHEMA ARE TWO STATEMENTS OF ONE FACT.
// (contract-tool-prose-agrees-with-schema-v1)
//
// `tests/advertised_args_are_read.test.ts` pinned two of the three statements a tool makes about
// itself: what its `input_schema` advertises, and what its handler actually reads. The third is the
// one a model reads FIRST — `TOOL_DESCRIPTIONS`, the prose — and nothing held it to the other two.
//
// THE MEASURED DRIFT (operator, 2026-09-19). `gig_dispatch`'s description said:
//
//     `budget` sets a ceiling in append units (a rate limiter on context growth, not dollars)
//
// while its own `input_schema`, declared ~200 lines above it in the same file, said:
//
//     budget: { max_usd: { description: "the per-gig ceiling, in USD (US dollars)" } }
//
// The append-unit gate was removed when budgets became dollars: `BudgetState` (src/runtime.ts:691)
// now carries `max_usd`, `spent_usd` and `unit?: "usd"`, and there is no other denomination in the
// engine. So one tool told its callers two contradicting things about the same argument, and the
// half that was wrong is the half a model reads before it decides what to send.
//
// This is the class CLAUDE.md names: a behaviour claim stays true because a test breaks when it
// drifts, while a STATUS claim rots silently. The fix is not to correct the sentence — it is to make
// the sentence checkable, so the next denomination change cannot quietly leave prose behind.
//
// THESE LAWS ARE RED BY DESIGN against `src/mcp.ts` as it stands.
import { describe, it, expect } from "vitest";
import { MCP_TOOLS, TOOL_DESCRIPTIONS } from "../src/mcp.js";

/** Denominations the engine has RETIRED. `BudgetState.unit` is `"usd"` and nothing else — a
 *  description still naming one of these is describing a gate that was removed. */
const RETIRED_DENOMINATIONS = [/append[ -]units?/i, /context units?/i];

/** A tool whose schema declares a `budget` argument, and that argument's own advertised prose. */
function budgetTools(): { slug: string; schemaProse: string; description: string }[] {
  const out: { slug: string; schemaProse: string; description: string }[] = [];
  for (const tool of MCP_TOOLS) {
    const props = (tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
    const budget = props["budget"] as { description?: string; properties?: Record<string, { description?: string }> } | undefined;
    if (!budget) continue;
    // The denomination may be stated on `budget` itself or on the fields inside it.
    const nested = Object.values(budget.properties ?? {}).map((p) => p.description ?? "").join(" ");
    out.push({
      slug: tool.slug,
      schemaProse: `${budget.description ?? ""} ${nested}`.trim(),
      description: TOOL_DESCRIPTIONS[tool.slug] ?? "",
    });
  }
  return out;
}

describe("no tool describes an argument in a denomination the engine retired", () => {
  it("O1 — no TOOL_DESCRIPTIONS entry names a retired budget denomination", () => {
    const offenders: string[] = [];
    for (const [slug, description] of Object.entries(TOOL_DESCRIPTIONS)) {
      for (const retired of RETIRED_DENOMINATIONS) {
        const hit = retired.exec(description);
        if (hit) offenders.push(`${slug}: "${hit[0]}"`);
      }
    }
    expect(
      offenders,
      "a tool's prose still names a denomination the engine removed — BudgetState carries max_usd / spent_usd / unit:\"usd\" and nothing else (src/runtime.ts:691-709), so this sentence describes a gate that is gone and a caller reading it will send the wrong thing",
    ).toEqual([]);
  });
});

describe("a tool that takes a budget says the same denomination its schema does", () => {
  it("O2 — every budget-taking tool's schema states USD, and its description agrees", () => {
    const tools = budgetTools();
    expect(tools.map((t) => t.slug), "gig_dispatch is the tool that takes a budget; this law is derived from the surface, not hard-coded to it").toContain("gig_dispatch");

    for (const tool of tools) {
      expect(
        tool.schemaProse,
        `${tool.slug}'s schema does not state a denomination for budget — the argument is then whatever the caller guesses`,
      ).toMatch(/usd|dollar/i);
      // AFFIRMATIVE, deliberately. A bare /usd|dollar/ passes on the very sentence this contract
      // exists to kill — "not dollars" contains "dollars" — so the law would have gone green while
      // reading the defect. It must match a statement that the ceiling IS denominated in dollars.
      expect(
        tool.description,
        `${tool.slug}'s schema states USD but its description never says the ceiling IS in dollars — the prose is the half a model reads first`,
      ).toMatch(/\b(in|of)\s+(us\s+)?(dollars|usd)\b/i);
    }
  });

  it("O3 — no budget-taking tool's description DENIES the denomination its schema states", () => {
    for (const tool of budgetTools()) {
      expect(
        tool.description,
        `${tool.slug} advertises "${tool.schemaProse}" in its schema and then denies it in prose — the two statements cannot both be read as true, and nothing chooses between them`,
      ).not.toMatch(/not dollars|not in dollars|rather than dollars/i);
    }
  });
});
