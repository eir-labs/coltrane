// agent.domain=null|undefined should be compatible with any standard's
// domain, not rejected. Issue #134.
//
// Intent: composeStandard accepts an agent whose .domain is null OR undefined,
// treating it as domain-agnostic. The only reject case is when the agent
// declares an EXPLICIT domain that conflicts with the standard's.
//
// Non-goals: not removing the strictness — explicit conflicts still throw.
// Not touching defineAgent's default-to-null normalization.

import { describe, it, expect } from "vitest";
import { defineAgent, composeStandard, CompositionError, type Agent } from "../src/composition.js";

describe("agent.domain null/undefined is domain-agnostic (Rob #134)", () => {
  it("an agent with domain undefined composes into any standard", () => {
    // Build an agent OBJECT directly (skipping defineAgent's normalize) — this
    // is how the MCP path constructs Agents from raw client JSON in #132.
    const agentNoDomain: Agent = {
      slug: "scout",
      primitives: ["SENSE"],
      input_types: [],
      output_types: ["raw-note"],
      domain: undefined as unknown as string | null,
    };
    const composed = composeStandard({
      slug: "demo-standard",
      domain: "elder-scam-shield",
      agents: [agentNoDomain],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    });
    expect(composed.slug).toBe("demo-standard");
  });

  it("an agent with domain null composes into any standard (existing behavior preserved)", () => {
    const agentNullDomain = defineAgent({
      slug: "scout-from-defineAgent",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      // no domain → defineAgent normalizes to null
    });
    expect(agentNullDomain.domain).toBe(null);

    const composed = composeStandard({
      slug: "demo-standard-2",
      domain: "elder-scam-shield",
      agents: [agentNullDomain],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout-from-defineAgent", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    });
    expect(composed.slug).toBe("demo-standard-2");
  });

  it("an agent with an explicit conflicting domain STILL throws (strictness preserved)", () => {
    const agentExplicitDomain = defineAgent({
      slug: "scout-elsewhere",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "different-domain",
    });
    expect(() => composeStandard({
      slug: "demo-standard-3",
      domain: "elder-scam-shield",
      agents: [agentExplicitDomain],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout-elsewhere", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    })).toThrow(CompositionError);
  });
});
