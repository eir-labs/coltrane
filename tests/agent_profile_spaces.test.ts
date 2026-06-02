import { describe, it, expect } from "vitest";
import { proposeAgentChange, type ProfileSpace } from "../src";

const base = {
  slug: "trust-analyst",
  version: 4,
  status: "active" as const,
  primitives: ["SENSE", "INTERPRET", "JUDGE"] as const,
  input_types: ["site-cache"],
  output_types: ["dimension-analysis"],
  domain: "eirtests",
  identity: "you are a trust analyst",
  method: "score each dimension 0-100",
  constraints: ["never invent evidence"],
  depth_profile: "standard" as const,
  permissions: {
    allowed_tools: ["url_scan"],
    disallowed_tools: [],
    model_tier: "standard" as const,
    max_tool_calls: 20,
    max_token_budget: 0.5,
    can_write_outputs: true,
    can_trigger_standards: false,
  },
};

describe("agent profile: three spaces", () => {
  it("classifies a change to identity as Creative — no approval", () => {
    const next = { ...base, identity: "you are a critical trust analyst" };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("creative");
    expect(r.approval_required).toBe(false);
  });

  it("classifies a change to method as Creative — no approval", () => {
    const next = { ...base, method: "score by quartiles" };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("creative");
    expect(r.approval_required).toBe(false);
  });

  it("classifies a primitives change as Harmonic — type-checked, no human approval", () => {
    const next = { ...base, primitives: ["SENSE", "INTERPRET", "JUDGE", "PLAN"] as const };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("harmonic");
    expect(r.approval_required).toBe(false);
    expect(r.type_check_passed).toBe(true);
  });

  it("classifies an output_types change as Harmonic and runs type-check", () => {
    const next = { ...base, output_types: ["dimension-review"] };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("harmonic");
    expect(r.type_check_passed).toBeDefined();
  });

  it("classifies a tool change as Permissions — human approval required", () => {
    const next = {
      ...base,
      permissions: { ...base.permissions, allowed_tools: ["url_scan", "shell_exec"] },
    };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("permissions");
    expect(r.approval_required).toBe(true);
  });

  it("classifies a model_tier upgrade as Permissions — human approval required", () => {
    const next = {
      ...base,
      permissions: { ...base.permissions, model_tier: "premium" as const },
    };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("permissions");
    expect(r.approval_required).toBe(true);
  });

  it("classifies a budget raise as Permissions — human approval required", () => {
    const next = {
      ...base,
      permissions: { ...base.permissions, max_token_budget: 5.0 },
    };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("permissions");
    expect(r.approval_required).toBe(true);
  });

  it("classifies enabling can_write_outputs as Permissions — human approval required", () => {
    const next = {
      ...base,
      permissions: { ...base.permissions, can_trigger_standards: true },
    };
    const r = proposeAgentChange(base, next);
    expect(r.space).toBe<ProfileSpace>("permissions");
    expect(r.approval_required).toBe(true);
  });
});
