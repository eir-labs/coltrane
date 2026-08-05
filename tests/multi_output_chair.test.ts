// RED-first — a chair seals ALL its declared output types, not just the first.
//
// The gap (surfaced by a live patent-triage run, 2026-06-12): novelty-searcher declares
// output_types ["prior-art-hit","novelty-verdict"] and its chair's output_contract lists
// both, but the runtime sealed only ONE record (the first), so the downstream verdict-judger
// reported its required novelty-verdict "FAILED-BY-ABSENCE". The genome's agents are not
// 1:1 primitive↔output_type (claim-rewriter is 2/1, verdict-judger 3/2), so each output
// type's core is resolved from its own `extends`, not paired with primitives[i].
//
// Contract pinned here:
//   - a chair whose agent declares N output types seals N records, one per type
//   - each record's core_type is resolved from that type's extends (SENSE→Signal, JUDGE→Judgment)
//   - all N share the chair's upstream provenance (derived_from the same inputs)
//   - the multi-output invoker returns a blob KEYED by output-type slug; single-output is unchanged
import { describe, it, expect } from "vitest";
import {
  createRegistry,
  createOutputStore,
  MemoryLedger,
  composeStandard,
  runGig,
  type AgentInvoker,
  type DomainType,
  type PhaseDef,
  type Chair,
} from "../src/index.js";
import { testAgent } from "./_support/agents.js";

function setup() {
  const registry = createRegistry();
  const hit: DomainType = { slug: "hit", extends: "Signal", domain: "demo", schema: { properties: { who: { type: "string" } } }, required_fields: ["who"] };
  const verdict: DomainType = { slug: "verdict", extends: "Judgment", domain: "demo", schema: { properties: { call: { type: "string" } } }, required_fields: ["call"] };
  registry.registerType(hit);
  registry.registerType(verdict);
  const outputs = createOutputStore(registry);
  const ledger = new MemoryLedger();
  return { registry, outputs, ledger };
}

// a two-output agent: SENSE→hit + JUDGE→verdict, the novelty-searcher shape
const searcher = () => testAgent({
  slug: "searcher",
  primitives: ["SENSE", "JUDGE"],
  input_types: [],
  output_types: ["hit", "verdict"],
  domain: "demo",
});

// Each per-type payload carries its own CORE's substance floor, enforced at seal on every
// output regardless of domain type (#227 ruling). A multi-output chair is exactly where that
// matters: `hit` is a Signal and `verdict` is a Judgment, so one blob has to satisfy two
// different floors and a fixture that satisfies only one aborts the whole chair.
const HIT = { who: "nix", source: "search://demo/prior-art" };
const VERDICT = { call: "PASS", criteria: ["novelty over the cited hit"] };

const oneChair: Chair = {
  role: "search", agent_slug: "searcher", depends_on: [],
  input_contract: [], output_contract: ["hit", "verdict"], required_skills: [],
};

describe("a chair seals every declared output type", () => {
  it("a two-output chair produces two sealed records, one per type", async () => {
    const { outputs, ledger } = setup();
    const std = composeStandard({
      slug: "two-out", domain: "demo", agents: [searcher()],
      phases: [{ name: "search", chairs: [oneChair] } as PhaseDef],
    });
    // multi-output invoker: a blob keyed by output-type slug
    const invoke: AgentInvoker = () => ({ hit: HIT, verdict: VERDICT });

    const res = await runGig(std, { q: "x" }, { outputs, ledger, invoke });
    expect(res.status).toBe("complete");

    const sealed = outputs.all().filter((o) => o.gig_id === res.gig_id);
    expect(sealed.map((o) => o.domain_type).sort()).toEqual(["hit", "verdict"]);
    const byType = Object.fromEntries(sealed.map((o) => [o.domain_type, o]));
    // core_type resolved from each type's extends — not from primitives[0]
    expect(byType["hit"]!.core_type).toBe("Signal");
    expect(byType["verdict"]!.core_type).toBe("Judgment");
    expect(byType["hit"]!.data).toEqual(HIT);
    expect(byType["verdict"]!.data).toEqual(VERDICT);
  });

  it("a downstream chair can depend on the SECOND output type (the judge-needs-verdict case)", async () => {
    const { registry, outputs, ledger } = setup();
    registry.registerType({ slug: "ruling", extends: "Interpretation", domain: "demo", schema: { properties: { text: { type: "string" } } }, required_fields: ["text"] });
    const judger = testAgent({ slug: "judger", primitives: ["INTERPRET"], input_types: ["verdict"], output_types: ["ruling"], domain: "demo" });
    const std = composeStandard({
      slug: "search-then-judge", domain: "demo", agents: [searcher(), judger],
      phases: [
        { name: "search", chairs: [oneChair] } as PhaseDef,
        { name: "judge", chairs: [{ role: "judge", agent_slug: "judger", depends_on: ["search"], input_contract: ["verdict"], output_contract: ["ruling"], required_skills: [] }] } as PhaseDef,
      ],
    });
    let seen: unknown = null;
    const invoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "searcher") return { hit: HIT, verdict: VERDICT };
      seen = ctx.inputs.find((i) => i.domain_type === "verdict")?.data ?? null;
      return { text: "filed on the verdict", claims: ["the verdict is PASS"] };
    };
    await runGig(std, { q: "x" }, { outputs, ledger, invoke });
    // the judge must actually receive the novelty-verdict as a distinct upstream record
    expect(seen).toEqual(VERDICT);
  });

  it("a single-output chair is unchanged — the invoker blob IS the data (no keying)", async () => {
    const { registry, outputs, ledger } = setup();
    registry.registerType({ slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] });
    const solo = testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" });
    const std = composeStandard({
      slug: "solo-out", domain: "demo", agents: [solo],
      phases: [{ name: "sense", chairs: [{ role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] } as PhaseDef],
    });
    const invoke: AgentInvoker = () => ({ t: "hello", source: "fixture://demo/solo" });
    const res = await runGig(std, { q: "x" }, { outputs, ledger, invoke });
    const sealed = outputs.all().filter((o) => o.gig_id === res.gig_id);
    expect(sealed.length).toBe(1);
    expect(sealed[0]!.data).toEqual({ t: "hello", source: "fixture://demo/solo" });
  });
});
