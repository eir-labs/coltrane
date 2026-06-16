// The real invoker's PURE pieces: buildPrompt (5-layer hierarchy) and extractJson
// (tolerant JSON extraction from model output). The spawn itself is the non-
// deterministic seam (needs the claude CLI + a key) and is not unit-tested.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { buildPrompt, extractJson, type AgentInvocationContext } from "../src";
import type { Agent } from "../src";

const agent: Agent = { ...TEST_BEHAVIOR,
  slug: "site-analyst",
  primitives: ["INTERPRET"],
  input_types: ["page-model"],
  output_types: ["finding"],
  domain: "eirtests",
};

function ctx(overrides: Partial<AgentInvocationContext> = {}): AgentInvocationContext {
  return {
    agent,
    phase: "interpret",
    inputs: [],
    gig_input: { site_url: "example.com" },
    ...overrides,
  };
}

// NOTE: the behavioral CONTENT of buildPrompt (disposition/identity/method/constraints/
// tool-catalog/depth) is covered combinatorially by tests/agent_matrix.test.ts and against
// golden baselines by tests/prompt_full_parity.test.ts. This file keeps only buildPrompt's
// structural mechanics that those don't exercise (layer presence/order, upstream-input and
// output-schema rendering, ctx-resolved skills) plus extractJson.
describe("buildPrompt: layer structure + mechanics", () => {
  it("emits the layer headers and a typed JSON-only task", () => {
    const p = buildPrompt(ctx());
    expect(p).toContain("# Disposition");
    expect(p).toContain("# Identity");
    expect(p).toContain("site-analyst");
    expect(p).toContain("# Context");
    expect(p).toContain("example.com");
    expect(p).toContain("# Task");
    expect(p).toContain("finding");
    expect(p).toMatch(/ONLY a single JSON object/);
  });

  it("renders upstream inputs into the context layer", () => {
    const p = buildPrompt(
      ctx({
        inputs: [
          {
            id: "o1", core_type: "Signal", domain_type: "page-model", domain_type_version: 1,
            domain: "eirtests", gig_id: "g1", agent_slug: "site-scout", primitive: "SENSE",
            data: { url: "/products" }, input_refs: [], input_shas: [], created_at: "now", content_sha: "0".repeat(64),
          },
        ],
      }),
    );
    expect(p).toContain("page-model (from site-scout)");
    expect(p).toContain("/products");
  });

  it("embeds the output JSON schema when provided", () => {
    const p = buildPrompt(ctx(), { type: "object", required: ["title"] });
    expect(p).toContain("JSON schema");
    expect(p).toContain("title");
  });

  it("notes root agents have no upstream", () => {
    const p = buildPrompt(ctx({ inputs: [] }));
    expect(p).toContain("root agent");
  });

  it("emits the Skills layer when skills are present in the ctx", () => {
    const p = buildPrompt(
      ctx({
        skills: [
          { slug: "summarize-tight", md: "Compose the gist in one tight clause." },
          { slug: "no-filler", text: "Use only the supplied facts." },
        ],
      }),
    );
    expect(p).toContain("# Skills");
    expect(p).toContain("## summarize-tight");
    expect(p).toContain("Compose the gist in one tight clause.");
    expect(p).toContain("## no-filler");
    expect(p).toContain("Use only the supplied facts.");
    // Skills lands BEFORE Context (layer 3 of 5).
    expect(p.indexOf("# Skills")).toBeGreaterThan(p.indexOf("# Identity"));
    expect(p.indexOf("# Skills")).toBeLessThan(p.indexOf("# Context"));
  });

  it("omits the Skills layer entirely when no skills are bound", () => {
    const p = buildPrompt(ctx({ skills: [] }));
    expect(p).not.toContain("# Skills");
    // Default ctx (no skills field) also omits the layer.
    expect(buildPrompt(ctx())).not.toContain("# Skills");
  });
});

describe("extractJson: tolerant parse of model output", () => {
  it("parses a bare JSON object", () => {
    expect(extractJson('{"title":"x"}')).toEqual({ title: "x" });
  });

  it("extracts JSON from prose + code fence", () => {
    const out = 'Here is the finding:\n```json\n{"title":"missing alt","severity":"high"}\n```\nDone.';
    expect(extractJson(out)).toEqual({ title: "missing alt", severity: "high" });
  });

  it("handles nested braces", () => {
    expect(extractJson('prefix {"a":{"b":1},"c":2} suffix')).toEqual({ a: { b: 1 }, c: 2 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
