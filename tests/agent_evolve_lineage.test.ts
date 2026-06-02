// O20 — agent evolution threads the immutable lineage chain (parent_version),
// and evolve is creative-space-only BY CONSTRUCTION (harmonic/permissions can't
// ride through it — they need a proposal).
import { describe, it, expect } from "vitest";
import { evolveProfile, type AgentProfile } from "../src/agent_profile.js";

const base: AgentProfile = {
  slug: "scout", version: 1, status: "active", parent_version: null,
  primitives: ["SENSE"], input_types: ["url"], output_types: ["page-model"],
  domain: "eirtests", identity: "you scan", method: "look", constraints: [],
  depth_profile: "standard",
  permissions: { allowed_tools: [], disallowed_tools: [], model_tier: "standard", max_tool_calls: 10, max_token_budget: 1, can_write_outputs: true, can_trigger_standards: false },
};

describe("evolveProfile lineage (O20)", () => {
  it("karma: creative change threads version+1 + parent_version + draft; chain reconstructs", () => {
    const v2 = evolveProfile(base, { identity: "you scan deeply" });
    expect(v2.version).toBe(2);
    expect(v2.parent_version).toBe(1);
    expect(v2.parent_version).toBe(base.version); // chain reconstructs to predecessor
    expect(v2.status).toBe("draft");
    expect(v2.identity).toBe("you scan deeply");
    expect(v2.slug).toBe("scout");                // slug stable across versions
    expect(base.version).toBe(1); expect(base.identity).toBe("you scan"); // base untouched
    const v3 = evolveProfile(v2, { method: "look harder" });
    expect(v3.version).toBe(3); expect(v3.parent_version).toBe(2);        // chains again
  });

  it("apoha: harmonic fields can't ride through evolve — primitives/types carried unchanged", () => {
    const harmonic = { primitives: ["SENSE","INTERPRET"], domain: "other" } as unknown as Partial<Pick<AgentProfile,"identity"|"method"|"constraints">>;
    const v2 = evolveProfile(base, harmonic);
    expect(v2.primitives).toEqual(["SENSE"]);  // harmonic ignored, NOT applied
    expect(v2.domain).toBe("eirtests");          // unchanged
    expect(v2.parent_version).toBe(1);           // still a valid lineage hop
  });

  it("apoha: permissions never evolve — carried unchanged", () => {
    const v2 = evolveProfile(base, { method: "look harder" });
    expect(v2.permissions).toEqual(base.permissions);
  });
});
