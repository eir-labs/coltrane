import { describe, it, expect } from "vitest";
import { createRegistry } from "../src";

describe("core type immutability", () => {
  it("exposes no api to add or modify a core type", () => {
    const registry = createRegistry() as unknown as Record<string, unknown>;
    expect(registry.registerCoreType).toBeUndefined();
  });

  it("rejects a domain type that extends a non-core type", () => {
    const registry = createRegistry();
    expect(() =>
      registry.registerType({ slug: "x", extends: "not-a-core", domain: "d", schema: {}, required_fields: [] }),
    ).toThrow();
  });
});

describe("domain type extension", () => {
  it("extends one core type into multiple domains that each validate", () => {
    const registry = createRegistry();
    registry.registerType({
      slug: "test-spec", extends: "Artifact", domain: "code-maintenance",
      schema: { type: "object", properties: { spec_code: { type: "string" } } },
      required_fields: ["spec_code"],
    });
    registry.registerType({
      slug: "outreach-email", extends: "Artifact", domain: "company-ops",
      schema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } } },
      required_fields: ["subject", "body"],
    });
    expect(registry.validate({ core_type: "Artifact", domain_type: "test-spec", data: { spec_code: "x" } }).valid).toBe(true);
    expect(registry.validate({ core_type: "Artifact", domain_type: "outreach-email", data: { subject: "s", body: "b" } }).valid).toBe(true);
  });
});
