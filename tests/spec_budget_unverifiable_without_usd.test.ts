// RED — a dollar ceiling that cannot see the spend cannot be honoured (contract F3).
//
// The ceiling is enforced against SETTLED USD, read from the invokers' result events. If a chair
// settles but reports NO usd (an unpriced or unattributed invocation), the runtime cannot know
// whether the next batch is affordable. The contract's posture is fail-closed: no further batch
// starts, and the gig fails with a typed `budget_unverifiable` reason naming the chairs whose spend
// is unknown — never a silent completion that pretends $0.
//
// RED against today's src: `settled_usd` simply stays 0 when a result event carries no cost, the
// append-unit gate does not consult it, and the gig runs every chair to completion. Nothing is
// refused and no `budget_unverifiable` reason exists.
import { describe, it, expect } from "vitest";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type BudgetInput,
  type DomainType,
  type Agent,
  type Standard,
} from "../src/index.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const note: DomainType = {
  slug: "spent-note", extends: "Signal", domain: "demo",
  schema: { properties: { t: { type: "string" } } }, required_fields: ["t"],
};
const priced: Agent = { ...TEST_BEHAVIOR, slug: "priced-agent", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" };
const unpriced: Agent = { ...TEST_BEHAVIOR, slug: "unpriced-agent", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" };

// Phase 0 settles but reports NO usd; phase 1 would report normally. The unverifiable phase-0 spend
// must stop phase 1 from ever starting.
const standard: Standard = {
  slug: "spend", domain: "demo", agents: [unpriced, priced],
  phases: [
    { name: "p0", chairs: [{ role: "a", agent_slug: "unpriced-agent", depends_on: [], input_contract: [], output_contract: ["spent-note"], required_skills: [] }] },
    { name: "p1", chairs: [{ role: "b", agent_slug: "priced-agent", depends_on: [], input_contract: [], output_contract: ["spent-note"], required_skills: [] }] },
  ],
};

describe("F3 — an unverifiable (no-usd) settled invocation stops the next batch, typed", () => {
  it("a chair that settles with no reported usd fails the gig budget_unverifiable, naming it, before the next batch", async () => {
    const seen: string[] = [];
    const invoke: AgentInvoker = (ctx) => {
      seen.push(ctx.agent.slug);
      // The unpriced chair emits a result event with NO cost field — settled, but its dollars unknown.
      if (ctx.agent.slug === "unpriced-agent") {
        ctx.onEvent?.({ type: "result", raw: { type: "result", usage: { input_tokens: 10, output_tokens: 10 } } });
      } else {
        ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 10 } } });
      }
      return { t: "done", source: "fixture://demo/spent" };
    };
    const registry = createRegistry();
    registry.registerType(note);
    let caught: unknown = null;
    try {
      await runGig(standard, {}, {
        outputs: createOutputStore(registry), ledger: new MemoryLedger(),
        invoke, budget: { max_usd: 45 } as unknown as BudgetInput,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught, "a dollar ceiling ran a second batch on top of spend it could not see — unverifiable spend completed silently").toBeTruthy();
    expect(seen.includes("priced-agent"), "the next batch started even though the prior chair's dollar spend was unknown").toBe(false);
    const err = caught as (Record<string, unknown> & Error) | null;
    const reason = String(err?.["reason"] ?? err?.name ?? "") + " " + String(err?.message ?? "");
    expect(reason, "the failure is not the typed budget_unverifiable reason the contract names").toMatch(/budget_unverifiable/);
    expect(reason, "the failure does not name the chair whose spend is unknown").toMatch(/unpriced-agent|"a"/);
  });
});
