// RED — a budget documented in dollars is enforced in dollars, and its state is REPORTED in dollars.
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
//
// MEASURED on 2026-09-17 (this run, tests/_scratch_probe): a `budget: { max_usd }` handed to today's
// runGig is read as `opening: undefined` — the append gate never trips (NaN < cost is false) and the
// returned budget_state carries `unit: "append-units"`, no `max_usd`, no `spent_usd`, though
// `settled_usd` IS tracked. So the runtime already KNOWS the settled dollars; it neither enforces the
// ceiling against them nor reports the budget in the denomination the door advertises.
//
// Covers subsystem-contract invariants I1 (LAW 1) and I2 (LAW 2, folded up from the old control).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  runGig,
  BudgetExhausted,
  type AgentInvoker,
  type BudgetInput,
  type BudgetState,
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

/** A chair that reports exactly `usd` of real settled spend, the way the CLI's result event does,
 *  and counts how many chairs the runtime actually let start. */
function spending(usd: number, invoked: { n: number }): AgentInvoker {
  return (ctx) => {
    invoked.n += 1;
    ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
    return { t: "done", source: "fixture://demo/spent" };
  };
}

/** The contract's dollar denomination, read off whatever budget snapshot rode back. */
const dollars = (bs: BudgetState | Record<string, unknown> | undefined) => bs as Record<string, unknown> | undefined;

async function run(standard: Standard, gigInput: Record<string, unknown>, max_usd: number, usd: number, invoked: { n: number }) {
  const registry = createRegistry();
  registry.registerType(note);
  return runGig(standard, gigInput, {
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    invoke: spending(usd, invoked),
    // THE CONTRACT'S SHAPE: the budget is a dollar ceiling. Cast because today's BudgetInput still
    // names `opening`/`base_cost`/`k`; the field the door accepts is `max_usd`.
    budget: { max_usd } as unknown as BudgetInput,
  });
}

describe("a dollar budget is enforced in dollars", () => {
  it("LAW 0 — the CLI documents --budget in dollars (the claim the laws below hold it to)", () => {
    const cli = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    expect(cli).toMatch(/--budget <dollars>/);
  });

  it("LAW 1 (I1) — a $45 budget runs a gig whose real spend is $0.02, however large its payload, and reports the ceiling in dollars", async () => {
    const payload = { request: "x".repeat(24_000) }; // the size of a real change-request plus plan
    const invoked = { n: 0 };
    let refused: unknown = null;
    let bs: Record<string, unknown> | undefined;
    try {
      const res = await run(chairs(2), payload, 45, 0.01, invoked);
      expect(res.outputs, "a dollar ceiling 2,000x the real spend must not refuse on a payload-size estimate").toHaveLength(2);
      bs = dollars(res.budget_state);
    } catch (e) {
      refused = e;
    }
    expect(
      refused === null ? null : String((refused as Error).message ?? refused),
      "a dollar ceiling 2,000x the real spend refused the gig on a payload-size estimate",
    ).toBe(null);
    // AND the budget the operator set in dollars is REPORTED in dollars — not silently re-denominated
    // into append-units. Today `unit` is "append-units", `max_usd` is absent, `spent_usd` is absent.
    expect(bs?.["unit"], "the budget was enforced/reported in append-units, not the dollars the door advertises").toBe("usd");
    expect(bs?.["max_usd"], "the dollar ceiling the operator set never reached the budget state").toBe(45);
    expect(bs?.["spent_usd"], "the settled dollars were tracked as settled_usd but never surfaced as spent_usd").toBeCloseTo(0.02, 5);
  });

  it("LAW 2 (I2) — three $0.03 chairs against a $0.05 ceiling: exactly two start, then BudgetExhausted", async () => {
    // Folded up from the old LAW 2 control. $0.03 per chair against a $0.05 ceiling cannot pay for a
    // third: after two chairs settle $0.06 of real spend, the ceiling is past and no further chair
    // starts. Today the append-unit gate never trips on a `max_usd` input, so all three run to
    // completion and nothing is thrown.
    const invoked = { n: 0 };
    let caught: unknown = null;
    let outputs = -1;
    try {
      const res = await run(chairs(3), {}, 0.05, 0.03, invoked);
      outputs = res.outputs.length;
    } catch (e) {
      caught = e;
    }
    expect(caught, "a gig spent past its dollar ceiling and ran to completion — settled spend was never the gate").toBeInstanceOf(BudgetExhausted);
    expect(invoked.n, "the ceiling did not stop the third chair from starting").toBe(2);
    expect(outputs, "three chairs sealed outputs against a ceiling that pays for two").toBe(-1);
  });
});
