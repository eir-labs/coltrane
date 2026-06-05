import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../src";

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(out, snapshot(p));
    else if (name.endsWith(".ts")) out[p] = readFileSync(p, "utf8");
  }
  return out;
}

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

describe("runtime type creation", () => {
  it("registers a domain type without changing any source file", () => {
    const before = snapshot("src");
    const registry = createRegistry();
    const result = registry.registerType(finding);
    const after = snapshot("src");
    expect(result.registered).toBe(true);
    expect(after).toEqual(before);
  });

  it("validates an instance against a type that lives only in the registry", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const ok = registry.validate({
      core_type: "Interpretation",
      domain_type: "finding",
      input_refs: [],
      data: { pattern_key: "p", severity: "high", title: "t" },
    });
    expect(ok.valid).toBe(true);
  });

  it("rejects an instance missing a required extension field", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    const bad = registry.validate({
      core_type: "Interpretation",
      domain_type: "finding",
      input_refs: [],
      data: { frame: "trust", claims: ["c1"], confidence: 0.8, severity: "high", title: "t" },
    });
    expect(bad.valid).toBe(false);
  });

  it("makes the registered type consumable in the same session", () => {
    const registry = createRegistry();
    registry.registerType(finding);
    expect(registry.listTypes().map((t) => t.slug)).toContain("finding");
  });
});
