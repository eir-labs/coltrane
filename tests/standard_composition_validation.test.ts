import { describe, it, expect } from "vitest";
import { defineAgent, composeStandard } from "../src";

const a_signal_out = defineAgent({
  slug: "fetcher",
  primitives: ["SENSE"],
  input_types: ["url"],
  output_types: ["site-cache"],
});

const a_interp_in_signal_out = defineAgent({
  slug: "trust-analyst",
  primitives: ["SENSE", "INTERPRET", "JUDGE"],
  input_types: ["site-cache"],
  output_types: ["dimension-analysis"],
});

const a_review = defineAgent({
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
          { name: "fetch", agent: "fetcher" },
          { name: "interpret", agent: "ghost-agent" },
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
          { name: "fetch", agent: "fetcher" },
          { name: "review", agent: "review-panel" },
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
          { name: "fetch", agent: "fetcher" },
          { name: "analyze", agent: "trust-analyst" },
          { name: "review", agent: "review-panel" },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a phase that targets the wrong domain (agent.domain ≠ standard.domain)", () => {
    const code_agent = defineAgent({
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
        phases: [{ name: "fetch", agent: "code-fetcher" }],
      }),
    ).toThrow();
  });
});
