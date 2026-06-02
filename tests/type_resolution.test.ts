import { describe, it, expect } from "vitest";
import { RESOLVE_WEIGHTS, createRegistry } from "../src";

const finding = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: {
    type: "object",
    properties: {
      pattern_key: { type: "string" },
      severity: { type: "string" },
      title: { type: "string" },
    },
  },
  required_fields: ["pattern_key", "severity", "title"],
};

describe("resolution weights", () => {
  it("sum to one", () => {
    const sum = Object.values(RESOLVE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("match the specified profile", () => {
    expect(RESOLVE_WEIGHTS).toEqual({
      field_coverage: 0.4,
      usage_gravity: 0.15,
      downstream_satisfaction: 0.2,
      domain_affinity: 0.15,
      recency: 0.1,
    });
  });
});

describe("resolve action by score", () => {
  it("uses an existing type at score at least 80", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const r = registry.resolveType({
      extends: "Interpretation",
      domain: "eirtests",
      required_fields: ["pattern_key", "severity", "title"],
    });
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.action).toBe("use");
  });

  it("creates a new type at score below 50", () => {
    const registry = createRegistry();
    const r = registry.resolveType({
      extends: "Verdict",
      domain: "brand-new",
      required_fields: ["a", "b", "c"],
    });
    expect(r.score).toBeLessThan(50);
    expect(r.action).toBe("create");
  });

  it("rejects registration when an existing type already scores at least 80", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    expect(() => registry.registerType({ ...finding, slug: "finding-2" })).toThrow();
  });
});
