import { describe, it, expect } from "vitest";
import { MCP_TOOLS, requiresApproval } from "../src";

describe("MCP surface: structural", () => {
  it("every tool has an input schema and an output schema", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.input_schema, `tool ${tool.slug} missing input_schema`).toBeDefined();
      expect(tool.output_schema, `tool ${tool.slug} missing output_schema`).toBeDefined();
    }
  });

  it("tool slugs are unique", () => {
    const slugs = MCP_TOOLS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("every tool is assigned to a category", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.category, `tool ${tool.slug} missing category`).toBeTruthy();
    }
  });
});

describe("MCP surface: approval gating", () => {
  it.each([
    "tool_propose",
    "tool_deprecate_propose",
    "charter_suggest_update",
  ])("%s always requires approval", (slug) => {
    expect(requiresApproval({ slug, change_class: null, target_kind: null })).toBe(true);
  });

  it("type_register requires approval only for breaking changes", () => {
    expect(
      requiresApproval({ slug: "type_register", change_class: "additive", target_kind: null }),
    ).toBe(false);
    expect(
      requiresApproval({ slug: "type_register", change_class: "modified", target_kind: null }),
    ).toBe(false);
    expect(
      requiresApproval({ slug: "type_register", change_class: "breaking", target_kind: null }),
    ).toBe(true);
  });

  it("type_extend requires approval only for breaking changes", () => {
    expect(
      requiresApproval({ slug: "type_extend", change_class: "additive", target_kind: null }),
    ).toBe(false);
    expect(
      requiresApproval({ slug: "type_extend", change_class: "breaking", target_kind: null }),
    ).toBe(true);
  });

  it("proposal_create requires approval when the proposal targets permissions", () => {
    expect(
      requiresApproval({ slug: "proposal_create", change_class: null, target_kind: "permissions" }),
    ).toBe(true);
    expect(
      requiresApproval({ slug: "proposal_create", change_class: null, target_kind: "method" }),
    ).toBe(false);
  });

  it.each([
    "type_resolve",
    "type_browse",
    "tool_registry_browse",
    "output_query",
    "output_trace",
    "charter_read",
    "execution_history_read",
    "access_grant_check",
    "agent_define",
    "agent_evolve",
    "standard_compose",
    "standard_simulate",
    "gig_dispatch",
    "gig_monitor",
    "gig_abort",
    "output_write",
    "agent_validate_pipeline",
    "health_check",
    "system_health",
    "system_audit",
    "capability_research",
  ])("%s never requires approval", (slug) => {
    expect(requiresApproval({ slug, change_class: null, target_kind: null })).toBe(false);
  });
});
