import { describe, it, expect } from "vitest";
import { proposeTypeChange, type ChangeClass } from "../src";

const base = {
  slug: "finding",
  version: 3,
  extends: "Interpretation",
  domain: "eirtests",
  status: "active" as const,
  schema: {
    type: "object" as const,
    properties: {
      pattern_key: { type: "string" },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      evidence: { type: "array" },
    },
    required: ["pattern_key", "severity", "evidence"],
  },
  required_fields: ["pattern_key", "severity", "evidence"],
};

describe("type versioning rules", () => {
  it("classifies an additive change (new optional field) as additive — no approval", () => {
    const next = {
      ...base,
      schema: {
        ...base.schema,
        properties: { ...base.schema.properties, kpi_impacts: { type: "array" } },
      },
    };
    const r = proposeTypeChange(base, next);
    expect(r.change_class).toBe<ChangeClass>("additive");
    expect(r.approval_required).toBe(false);
    expect(r.next_version).toBe(base.version + 1);
  });

  it("classifies a new required field as modified — old version coexists", () => {
    const next = {
      ...base,
      required_fields: [...base.required_fields, "location"],
    };
    const r = proposeTypeChange(base, next);
    expect(r.change_class).toBe<ChangeClass>("modified");
    expect(r.approval_required).toBe(false);
    expect(r.old_version_stays).toBe(true);
  });

  it("classifies a field removal as breaking — human approval required", () => {
    const props = { ...base.schema.properties };
    delete (props as Record<string, unknown>).evidence;
    const next = {
      ...base,
      schema: { ...base.schema, properties: props },
      required_fields: base.required_fields.filter((f) => f !== "evidence"),
    };
    const r = proposeTypeChange(base, next);
    expect(r.change_class).toBe<ChangeClass>("breaking");
    expect(r.approval_required).toBe(true);
  });
});
