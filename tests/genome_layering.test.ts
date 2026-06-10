// Genome extension Phase 2 (docs/genome-extension.md): a consumer genome extends a
// base genome. loadLayeredGenome resolves a layer stack (lowest→highest): a lower
// layer's definitions are inherited unless a higher layer overrides them by slug.
// Per-slug provenance records which layer supplied each effective definition.
//
// RED-first: loadLayeredGenome does not exist yet.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayeredGenome } from "../src/loader.js";

function writeJson(dir: string, sub: string, name: string, obj: unknown): void {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(obj));
}

describe("genome layering: a consumer genome extends a base", () => {
  it("inherits base definitions, adds its own, and overrides base by slug", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-base-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer-"));
    try {
      // BASE layer: an agent + a domain type (no core_types — seeded by the engine)
      writeJson(base, "agents", "base-agent.json", { slug: "base-agent", primitives: ["SENSE"], output_types: ["Signal"], domain: "base" });
      writeJson(base, "agents", "shared-agent.json", { slug: "shared-agent", primitives: ["SENSE"], output_types: ["Signal"], domain: "base" });
      writeJson(base, "domain_types", "base-type.json", { slug: "base-type", version: 1, extends: "Signal", domain: "base", status: "active", schema: { type: "object", properties: { x: { type: "string" } } }, required_fields: ["x"] });

      // CONSUMER layer: adds its own agent + OVERRIDES shared-agent (different domain)
      writeJson(consumer, "agents", "widget-agent.json", { slug: "widget-agent", primitives: ["INTERPRET"], output_types: ["Interpretation"], domain: "widgetco" });
      writeJson(consumer, "agents", "shared-agent.json", { slug: "shared-agent", primitives: ["SENSE"], output_types: ["Signal"], domain: "widgetco" });

      const g = loadLayeredGenome([base, consumer]); // lowest → highest

      // the immutable 6 are present (seeded)
      expect(g.core_types.size).toBe(6);
      // inherited from base
      expect(g.agents.has("base-agent")).toBe(true);
      expect([...g.domain_types.values()].some((d) => d.slug === "base-type")).toBe(true);
      // added by consumer
      expect(g.agents.has("widget-agent")).toBe(true);
      // overridden: consumer's shared-agent wins (domain widgetco, not base)
      expect(g.agents.get("shared-agent")?.domain).toBe("widgetco");
      // no errors
      expect(g.load_errors).toEqual([]);

      // per-slug provenance: which layer supplied each effective definition
      expect(g.provenance?.get("agent:base-agent")).toBe(base);
      expect(g.provenance?.get("agent:widget-agent")).toBe(consumer);
      expect(g.provenance?.get("agent:shared-agent")).toBe(consumer); // override → top layer
      expect(g.provenance?.get("domain_type:base-type@1")).toBe(base); // domain types keyed slug@version
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
