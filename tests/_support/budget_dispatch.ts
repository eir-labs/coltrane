// Shared scaffolding for the budget-in-dollars DISPATCH-DOOR laws (F1, F2, I4/O5, I6). It builds the
// smallest in-memory ServerDeps that makes `dispatchTool("gig_dispatch", …)` reach runGig — a
// registry with one Signal-subtype, an output store, a ledger, a gig_runs map, a standards map and an
// injected invoker — exactly the shape tests/cli.test.ts uses to drive the CLI through the surface.
// The LAW ASSERTIONS live in each *.test.ts; only the mechanical deps live here.
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type AgentInvoker,
  type DomainType,
  type Standard,
} from "../../src/index.js";
import type { ServerDeps } from "../../src/server.js";
import { testAgent } from "./agents.js";

export const spentNote: DomainType = {
  slug: "spent-note",
  extends: "Signal",
  domain: "demo",
  schema: { properties: { t: { type: "string" } } },
  required_fields: ["t"],
};

const worker = testAgent({ slug: "worker", primitives: ["SENSE"], input_types: [], output_types: ["spent-note"], domain: "demo" });

/** A `n`-chair, `n`-phase (strictly sequential) standard whose every chair seats `worker`. */
export function spendStandard(n: number, slug = "spend"): Standard {
  return {
    slug,
    domain: "demo",
    agents: [worker],
    phases: Array.from({ length: n }, (_, i) => ({
      name: `p${i}`,
      chairs: [{ role: `w${i}`, agent_slug: "worker", depends_on: i === 0 ? [] : [`w${i - 1}`], input_contract: [], output_contract: ["spent-note"], required_skills: [] }],
    })),
  } as Standard;
}

/** Minimal ServerDeps whose standards map holds `standard` and whose invoker is `invoke`. */
export function budgetDeps(standard: Standard, invoke: AgentInvoker): ServerDeps {
  const registry = createRegistry();
  registry.registerType(spentNote);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    gig_runs: new Map(),
    standards: new Map([[standard.slug, standard]]),
    invoke,
  } as unknown as ServerDeps;
}

/** An invoker that reports exactly `usd` of settled spend per chair and records which chairs STARTED,
 *  so a door that must refuse before anything runs can be proven to have invoked nothing. */
export function spendingInvoker(usd: number, seen: string[]): AgentInvoker {
  return (ctx) => {
    seen.push(ctx.agent.slug);
    ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 10 } } });
    return { t: "done", source: "fixture://demo/spent" };
  };
}
