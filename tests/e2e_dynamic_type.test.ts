// E4 — a type created during gig execution is immediately consumable by a downstream
// agent in the same gig. Proves "no file changes to add a type" works end-to-end
// through the runtime (not just at load time).
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  dispatchTool,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type ServerDeps,
  type DomainType,
  type AgentInvoker,
} from "../src";
import type { Standard, Agent } from "../src";

const upstreamType: DomainType = {
  slug: "raw-finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { properties: { description: { type: "string" } } },
  required_fields: ["description"],
};

const downstreamType: DomainType = {
  slug: "scored-finding",
  extends: "Judgment",
  domain: "eirtests",
  schema: {
    properties: {
      description: { type: "string" },
      severity_score: { type: "number" },
    },
  },
  required_fields: ["description", "severity_score"],
};

const upstream: Agent = { ...TEST_BEHAVIOR,
  slug: "finder",
  primitives: ["INTERPRET"],
  input_types: [],
  output_types: ["raw-finding"],
  domain: "eirtests",
};

const downstream: Agent = { ...TEST_BEHAVIOR,
  slug: "scorer",
  primitives: ["JUDGE"],
  input_types: ["raw-finding"],
  output_types: ["scored-finding"],
  domain: "eirtests",
};

const standard: Standard = {
  slug: "dynamic-type-pipeline",
  domain: "eirtests",
  agents: [upstream, downstream],
  phases: [
    { name: "find", chairs: [{ role: "find", agent_slug: "finder", depends_on: [], input_contract: [], output_contract: ["raw-finding"], required_skills: [] }] },
    { name: "score", chairs: [{ role: "score", agent_slug: "scorer", depends_on: [], input_contract: [], output_contract: ["scored-finding"], required_skills: [] }] },
  ],
};

const invoke: AgentInvoker = ({ agent }) =>
  agent.slug === "finder"
    ? { description: "missing alt text" }
    : { description: "missing alt text", severity_score: 0.7 };

function wireDeps(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(upstreamType);
  // NOTE: downstreamType is INTENTIONALLY not pre-declared.
  // It will be registered MID-GIG via the MCP tool, then consumed by the downstream agent.
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[standard.slug, standard]]),
    invoke,
  };
}

describe("E4 — type created mid-execution, consumed by downstream agent", () => {
  it("a new domain type registered via type_register is immediately visible to the downstream agent's output validation", async () => {
    const deps = wireDeps();

    // mid-execution: register the downstream type via the MCP tool
    const reg = await dispatchTool("type_register", {
      slug: downstreamType.slug,
      extends: downstreamType.extends,
      domain: downstreamType.domain,
      schema: downstreamType.schema,
      required_fields: downstreamType.required_fields,
      reason: "needed for scoring phase",
    }, deps);
    expect(reg.ok).toBe(true);

    // dispatch the gig
    const r = await dispatchTool("gig_dispatch", { wait: true,
      standard_slug: standard.slug,
      input: {},
    }, deps);
    expect(r.ok).toBe(true);

    // both outputs should land — proving the dynamically-registered type validates
    const outs = await dispatchTool("output_query", {}, deps);
    expect(outs.ok).toBe(true);
    const data = outs.data as { outputs: Array<{ domain_type: string }> };
    const types = data.outputs.map((o) => o.domain_type).sort();
    expect(types).toEqual(["raw-finding", "scored-finding"]);
  });

  it("a downstream output whose dynamically-registered type rejects its data shape is BLOCKED at write (no silent persistence)", async () => {
    const deps = wireDeps();

    // register a strict downstream type that requires severity_score
    await dispatchTool("type_register", {
      slug: downstreamType.slug,
      extends: downstreamType.extends,
      domain: downstreamType.domain,
      schema: downstreamType.schema,
      required_fields: downstreamType.required_fields,
      reason: "needed for scoring phase",
    }, deps);

    // swap in an invoker that produces a downstream payload missing the required field
    const badInvoke: AgentInvoker = ({ agent }) =>
      agent.slug === "finder"
        ? { description: "missing alt text" }
        : { description: "missing alt text" /* severity_score missing */ };
    const deps2 = { ...wireDeps(), invoke: badInvoke };
    await dispatchTool("type_register", {
      slug: downstreamType.slug,
      extends: downstreamType.extends,
      domain: downstreamType.domain,
      schema: downstreamType.schema,
      required_fields: downstreamType.required_fields,
      reason: "needed for scoring phase",
    }, deps2);

    // dispatch should either fail OR record a partial result; what must NOT happen
    // is silent persistence of an invalid scored-finding.
    await dispatchTool("gig_dispatch", { wait: true, standard_slug: standard.slug, input: {} }, deps2).catch(() => undefined);
    const outs = await dispatchTool("output_query", { domain_type: "scored-finding" }, deps2);
    const data = outs.data as { outputs: unknown[] };
    expect(data.outputs.length).toBe(0);
  });
});
