// RED — a budget documented in dollars is enforced in dollars.
//
// THE DEFECT. `coltrane dispatch --budget <dollars>` says it is a per-gig ceiling in dollars
// (src/cli.ts usage). The runtime's gate compares that number against computeAppendCost, which is
// `base_cost + k × payload bytes` with defaults 1 and 0.1 — a size estimate in no currency. A gig
// with a 24KB payload is charged ~2,400 before its first chair runs, so every realistic dollar
// ceiling refuses every non-trivial gig, and the refusal reads like an honest out-of-money stop.
//
// MEASURED on 2026-09-16. `coltrane dispatch build-from-red-spec-v0 --input @build_input.json
// --budget 45` refused immediately: "BudgetExhausted: agent "red-spec-attester" needs cost=2385.6
// but balance=45 (opening=45, spent=0, credit=0)". Nothing ran. The same gig re-dispatched with no
// budget ran normally.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  type AgentInvoker,
  type DomainType,
  type Standard,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = {
  slug: "spent-note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { t: { type: "string" } } },
  required_fields: ["t"],
};

const worker = testAgent({ slug: "worker", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" });

function chairs(n: number): Standard {
  return {
    slug: "spend",
    domain: "demo",
    agents: [worker],
    phases: Array.from({ length: n }, (_, i) => ({
      name: `p${i}`,
      chairs: [{ role: `w${i}`, agent_slug: "worker", depends_on: i === 0 ? [] : [`w${i - 1}`], input_contract: [], output_contract: ["spent-note"], required_skills: [] }],
    })),
  } as Standard;
}

/** A chair that reports exactly `usd` of real spend, the way the CLI's result event does. */
function spending(usd: number): AgentInvoker {
  return (ctx) => {
    ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
    return { t: "done", source: "fixture://demo/spent" };
  };
}

async function run(standard: Standard, gigInput: Record<string, unknown>, opening: number, usd: number) {
  const registry = createRegistry();
  registry.registerType(note);
  return runGig(standard, gigInput, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke: spending(usd),
    budget: { opening },
  });
}

describe("a dollar budget is enforced in dollars", () => {
  it("LAW 0 — the CLI documents --budget in dollars (the claim the laws below hold it to)", () => {
    const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/--budget <dollars>/);
  });

  it("LAW 1 — a $45 budget runs a gig whose real spend is $0.02, however large its payload", async () => {
    const payload = { request: "x".repeat(24_000) }; // the size of a real change-request plus plan
    let refused: unknown = null;
    try {
      const res = await run(chairs(2), payload, 45, 0.01);
      expect(res.outputs).toHaveLength(2);
    } catch (e) {
      refused = e;
    }
    expect(
      refused === null ? null : String((refused as Error).message ?? refused),
      "a dollar ceiling 2,000x the real spend refused the gig on a payload-size estimate",
    ).toBe(null);
  });

  it("LAW 2 (control) — spend that really exceeds the dollar budget still stops the gig", async () => {
    // Green today, for the wrong reason (the size estimate trips first). After the fix it must stay
    // green for the RIGHT reason: $0.03 per chair against a $0.05 ceiling cannot pay for three chairs.
    let stopped = false;
    try {
      const res = await run(chairs(3), {}, 0.05, 0.03);
      stopped = res.outputs.length < 3;
    } catch {
      stopped = true;
    }
    expect(stopped, "a gig spent past its dollar ceiling and ran to completion").toBe(true);
  });
});
