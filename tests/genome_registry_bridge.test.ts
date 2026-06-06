import { describe, it, expect } from "vitest";
import { loadRegistry, type LoadedGenome } from "../src";

const genome: LoadedGenome = {
  core_types: new Map([
    ["Interpretation", { slug: "Interpretation", primitive: "INTERPRET", description: "", schema: {} }],
  ]),
  domain_types: new Map([
    ["finding@1", {
      slug: "finding",
      version: 1,
      extends: "Interpretation",
      domain: "eirtests",
      status: "active",
      schema: { type: "object", properties: { pattern_key: { type: "string" } } },
      required_fields: ["pattern_key"],
    }],
  ]),
  agents: new Map(),
  standards: new Map(),
  skills: new Map(),
  evals: new Map(),
  load_errors: [],
};

describe("genome to registry bridge", () => {
  it("populates the registry from the genome with no registerType calls", () => {
    const registry = loadRegistry(genome);
    expect(registry.listTypes().map((t) => t.slug)).toContain("finding");
  });

  it("makes genome-loaded types resolvable", () => {
    const registry = loadRegistry(genome);
    const r = registry.resolveType({ extends: "Interpretation", domain: "eirtests", required_fields: ["pattern_key"] });
    expect(r.action).toBe("use");
  });

  it("validates an instance against a genome-loaded type", () => {
    const registry = loadRegistry(genome);
    expect(
      registry.validate({ core_type: "Interpretation", domain_type: "finding", data: { pattern_key: "p" } }).valid,
    ).toBe(true);
  });
});
