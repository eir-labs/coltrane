// Subtype polymorphism (docs/genome-extension.md): a chair contract declared against
// a CORE type is satisfied by ANY domain type extending it. This is what makes base
// players reusable — write an agent against the 6 cores, and it operates over any
// downstream domain extension. Domain-type contracts stay exact; only core-type
// contracts are polymorphic.
//
// RED-first: today the runtime gathers inputs by EXACT domain_type, so a base agent
// declaring input `Interpretation` never sees a `widget-finding` (extends Interpretation).
import { describe, it, expect } from "vitest";
import {
  runGig,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type DomainType,
  type AgentInvoker,
} from "../src";
import type { Standard, Agent } from "../src";

// a downstream domain type extending a core type
const widgetFinding: DomainType = {
  slug: "widget-finding",
  extends: "Interpretation",
  domain: "widgetco",
  schema: { properties: { note: { type: "string" } } },
  required_fields: ["note"],
};
const assessment: DomainType = {
  slug: "assessment",
  extends: "Judgment",
  domain: "base",
  schema: { properties: { verdict: { type: "string" } } },
  required_fields: ["verdict"],
};

const finder: Agent = {
  slug: "finder",
  primitives: ["INTERPRET"],
  input_types: [],
  output_types: ["widget-finding"],
  domain: "widgetco",
};
// the base player: declares input against the CORE type, not a domain type
const baseAnalyst: Agent = {
  slug: "base-analyst",
  primitives: ["JUDGE"],
  input_types: ["Interpretation"],
  output_types: ["assessment"],
  domain: "base",
};

const standard: Standard = {
  slug: "poly",
  domain: "base",
  agents: [finder, baseAnalyst],
  phases: [
    { name: "find", chairs: [{ role: "find", agent_slug: "finder", depends_on: [], input_contract: [], output_contract: ["widget-finding"], required_skills: [] }] },
    { name: "assess", chairs: [{ role: "assess", agent_slug: "base-analyst", depends_on: [], input_contract: [], output_contract: ["assessment"], required_skills: [] }] },
  ],
};

function setup() {
  const registry = createRegistry();
  registry.registerType(widgetFinding);
  registry.registerType(assessment);
  return { outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("subtype polymorphism: a core-type contract accepts any domain subtype", () => {
  it("a base agent declaring input `Interpretation` consumes a `widget-finding` (extends Interpretation)", async () => {
    const { outputs, ledger } = setup();
    const seen: Record<string, string[]> = {};
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      seen[agent.slug] = inputs.map((i) => i.domain_type);
      return agent.slug === "finder" ? { note: "found" } : { verdict: "ok" };
    };

    const res = await runGig(standard, {}, { outputs, ledger, invoke });

    expect(res.status).toBe("complete");
    // the base player saw the downstream subtype as its `Interpretation` input
    expect(seen["base-analyst"], "base player should consume the Interpretation subtype").toContain(
      "widget-finding",
    );
  });

  it("an eval declared on a CORE type judges a domain subtype filling it (polymorphic eval)", async () => {
    const registry = createRegistry();
    registry.registerType({ slug: "domain-verdict", extends: "Verdict", domain: "x", schema: { properties: { decided: { type: "boolean" } } }, required_fields: ["decided"] });
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    const checker: Agent = { slug: "checker", primitives: ["VERIFY"], input_types: [], output_types: ["domain-verdict"], domain: "x" };
    const std: Standard = {
      slug: "v",
      domain: "x",
      agents: [checker],
      phases: [{ name: "verify", chairs: [{ role: "verify", agent_slug: "checker", depends_on: [], input_contract: [], output_contract: ["domain-verdict"], required_skills: [] }] }],
      eval_slugs: ["v-check"],
    };
    const evals = new Map([["v-check", { slug: "v-check", on_type: "Verdict", non_empty_fields: ["decided"] }]]);
    const invoke: AgentInvoker = () => ({ decided: true });
    const res = await runGig(std, {}, { outputs, ledger, invoke, evals });
    // the eval is declared on core `Verdict`; the produced `domain-verdict` subtype is judged
    // (was 0.0 under exact on_type matching)
    expect(res.eval_scores["v-check"]).toBe(1.0);
  });

  it("a domain-type contract stays EXACT — an unrelated subtype is not pulled in", async () => {
    const { outputs, ledger } = setup();
    // base-analyst variant that declares a DOMAIN input — must NOT accept widget-finding
    const exactAnalyst: Agent = { ...baseAnalyst, slug: "exact-analyst", input_types: ["assessment"] };
    const exactStandard: Standard = {
      ...standard,
      agents: [finder, exactAnalyst],
      phases: [
        standard.phases[0]!,
        { name: "assess", chairs: [{ role: "assess", agent_slug: "exact-analyst", depends_on: [], input_contract: [], output_contract: ["assessment"], required_skills: [] }] },
      ],
    };
    const seen: Record<string, string[]> = {};
    const invoke: AgentInvoker = ({ agent, inputs }) => {
      seen[agent.slug] = inputs.map((i) => i.domain_type);
      return agent.slug === "finder" ? { note: "found" } : { verdict: "ok" };
    };
    await runGig(exactStandard, {}, { outputs, ledger, invoke });
    expect(seen["exact-analyst"], "a domain-type input must not pull an unrelated subtype").not.toContain(
      "widget-finding",
    );
  });
});
