import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { defineAgent, composeStandard } from "../src";

const a_signal_out = defineAgent({ ...TEST_BEHAVIOR,
  slug: "fetcher",
  primitives: ["SENSE"],
  input_types: ["url"],
  output_types: ["site-cache"],
});

const a_interp_in_signal_out = defineAgent({ ...TEST_BEHAVIOR,
  slug: "trust-analyst",
  primitives: ["SENSE", "INTERPRET", "JUDGE"],
  input_types: ["site-cache"],
  output_types: ["dimension-analysis"],
});

const a_review = defineAgent({ ...TEST_BEHAVIOR,
  slug: "review-panel",
  primitives: ["JUDGE", "VERIFY"],
  input_types: ["dimension-analysis"],
  output_types: ["dimension-review"],
});

describe("P5 — standard composition with invalid agent mix", () => {
  it("rejects a standard whose phases reference an undefined agent", () => {
    expect(() =>
      composeStandard({
        slug: "broken",
        domain: "eirtests",
        agents: [a_signal_out],
        phases: [
          { name: "fetch", chairs: [{ role: "fetch", agent_slug: "fetcher", depends_on: [], input_contract: [], output_contract: ["site-cache"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "ghost-agent", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] },
        ],
      }),
    ).toThrow();
  });

  it("rejects a standard where a downstream agent's input is not produced upstream", () => {
    expect(() =>
      composeStandard({
        slug: "broken",
        domain: "eirtests",
        agents: [a_signal_out, a_review],
        phases: [
          { name: "fetch", chairs: [{ role: "fetch", agent_slug: "fetcher", depends_on: [], input_contract: [], output_contract: ["site-cache"], required_skills: [] }] },
          { name: "review", chairs: [{ role: "review", agent_slug: "review-panel", depends_on: [], input_contract: [], output_contract: ["dimension-review"], required_skills: [] }] },
        ],
      }),
    ).toThrow();
  });

  it("accepts a standard where every phase's input is satisfied by an upstream output", () => {
    expect(() =>
      composeStandard({
        slug: "readiness-scan",
        domain: "eirtests",
        agents: [a_signal_out, a_interp_in_signal_out, a_review],
        phases: [
          { name: "fetch", chairs: [{ role: "fetch", agent_slug: "fetcher", depends_on: [], input_contract: [], output_contract: ["site-cache"], required_skills: [] }] },
          { name: "analyze", chairs: [{ role: "analyze", agent_slug: "trust-analyst", depends_on: [], input_contract: [], output_contract: ["dimension-analysis"], required_skills: [] }] },
          { name: "review", chairs: [{ role: "review", agent_slug: "review-panel", depends_on: [], input_contract: [], output_contract: ["dimension-review"], required_skills: [] }] },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a phase that targets the wrong domain (agent.domain ≠ standard.domain)", () => {
    const code_agent = defineAgent({ ...TEST_BEHAVIOR,
      slug: "code-fetcher",
      primitives: ["SENSE"],
      input_types: ["repo-uri"],
      output_types: ["codebase-signal"],
      domain: "code-maintenance",
    });
    expect(() =>
      composeStandard({
        slug: "readiness-scan",
        domain: "eirtests",
        agents: [code_agent],
        phases: [{ name: "fetch", chairs: [{ role: "fetch", agent_slug: "code-fetcher", depends_on: [], input_contract: [], output_contract: ["codebase-signal"], required_skills: [] }] }],
      }),
    ).toThrow();
  });
});
