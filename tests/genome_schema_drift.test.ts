// RED — the genome-schema-drift contract. Every genome class (agent, standard, skill, type) has
// its shape restated in 3-5 hand-maintained places — the type, the construction function, the MCP
// input_schema, the handler, the file format — and they have drifted. These reds pin the UNIFIED
// behavior the single-source consolidation must deliver; each fails against today's drift and goes
// green when the class derives from one field-source. A slice is done when its block goes green.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS } from "../src/mcp.js";
import { loadGenome } from "../src/loader.js";
import { defineAgent, type AgentDef } from "../src/composition.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const schemaProps = (slug: string): string[] => {
  const t = MCP_TOOLS.find((x) => x.slug === slug);
  const props = (t?.input_schema as { properties?: Record<string, unknown> })?.properties ?? {};
  return Object.keys(props);
};

// ── Standard — composeStandard drops fields the genome declares ──────────────────
describe("drift · Standard — declared fields survive composition", () => {
  const genome = loadGenome(REPO);
  const std = genome.standards.get("patent-triage-v1") as Record<string, unknown> | undefined;
  it("patent-triage-v1 loads", () => expect(std, "standard must load").toBeTruthy());
  it("max_examine_rounds (declared in the JSON) is preserved on the runtime Standard", () => {
    // the file declares max_examine_rounds: 3; composeStandard's hand-enumerated return drops it.
    expect(std?.["max_examine_rounds"], "the K-cap the genome declares must reach the runtime").toBe(3);
  });
  it("standard-level output_types (declared in the JSON) is preserved", () => {
    expect(std?.["output_types"], "declared standard output_types must survive composition").toBeTruthy();
  });
});

// ── Agent — the MCP agent_define schema must express every authored field ────────
describe("drift · Agent — the MCP write-surface covers the real shape", () => {
  const props = schemaProps("agent_define");
  // every field a genome agent actually authors must be expressible via agent_define.
  for (const f of ["allowed_tools", "skill_slugs", "behavioral_primitives", "code_tool_access", "domain"]) {
    it(`agent_define can express "${f}"`, () => {
      expect(props, `agent_define MCP schema cannot express ${f} — it has drifted from the Agent type`).toContain(f);
    });
  }
  it("agent_define does NOT advertise the retired nested `permissions` object", () => {
    // permissions{model_tier,code_tool_access,max_tool_calls} is the OLD shape; genome files use
    // FLAT fields. The MCP surface must not carry the retired shape.
    expect(props, "agent_define still advertises the retired `permissions` object").not.toContain("permissions");
  });
});

// ── Standard — the MCP standard_compose schema must express the gig contract ──────
describe("drift · Standard — the MCP write-surface covers the real shape", () => {
  it("standard_compose can express input_types (the #156/#177 gig contract)", () => {
    expect(schemaProps("standard_compose"), "standard_compose MCP schema cannot express input_types").toContain("input_types");
  });
});

// ── Skill — skill_define must emit the package format the loader reads ────────────
describe("drift · Skill — one shape across define + load", () => {
  it("skill_define is package-aware, not the retired flat-md format", () => {
    const props = schemaProps("skill_define");
    // the loader reads PACKAGES (meta.json + skill.mjs + fixtures); skill_define emits flat {slug,
    // domain, md} the loader can't load. The MCP surface must speak the package format.
    expect(props.includes("md") && !props.includes("fixtures"), `skill_define emits the retired flat format: ${JSON.stringify(props)}`).toBe(false);
  });
});

// ── The standing litmus — the construction function never drops a field ───────────
describe("drift · litmus — defineAgent is loss-free", () => {
  it("every field of a fully-populated AgentDef survives defineAgent", () => {
    const def: AgentDef = {
      slug: "litmus", primitives: ["SENSE"], input_types: ["a"], output_types: ["b"], domain: "demo",
      identity: "i", method: "1. a 2. b 3. c", constraints: [], behavioral_primitives: ["explorer", "critic"],
      allowed_tools: ["Read"], disallowed_tools: [], skill_slugs: ["s"],
      model_tier: "standard", max_tool_calls: 5, max_token_budget: 100, code_tool_access: "none", depth_profile: "standard",
    };
    const agent = defineAgent(def) as Record<string, unknown>;
    for (const k of Object.keys(def)) {
      expect(agent[k], `defineAgent dropped "${k}" — a lossy projection of the sealed def`).not.toBe(undefined);
    }
  });
});
