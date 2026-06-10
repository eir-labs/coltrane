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
import { loadLayeredGenome, resolveGenome } from "../src/loader.js";

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

  it("a consumer standard composes a BASE agent — cross-layer reference resolves", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-base2-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-consumer2-"));
    try {
      // base ships a DOMAIN-AGNOSTIC player (#134) — composable into any domain;
      // consumer writes a standard that seats it (didn't define it itself)
      writeJson(base, "agents", "base-scout.json", { slug: "base-scout", primitives: ["SENSE"], output_types: ["Signal"] });
      writeJson(consumer, "standards", "widget-flow.json", {
        slug: "widget-flow",
        domain: "widgetco",
        agent_slugs: ["base-scout"],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "base-scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      });

      const g = loadLayeredGenome([base, consumer]);

      expect(g.load_errors, JSON.stringify(g.load_errors)).toEqual([]);
      expect(g.standards.has("widget-flow")).toBe(true);
      expect(g.provenance?.get("standard:widget-flow")).toBe(consumer);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});

describe("manifest-declared base: resolveGenome reads `extends` and layers", () => {
  it("a consumer's genome.json `extends` pulls in the base + composes its players", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-mbase-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-mconsumer-"));
    try {
      writeJson(base, "agents", "base-scout.json", { slug: "base-scout", primitives: ["SENSE"], output_types: ["Signal"] });
      // the consumer DECLARES its base (opt-in)
      writeFileSync(join(consumer, "genome.json"), JSON.stringify({ extends: [base] }));
      writeJson(consumer, "standards", "flow.json", {
        slug: "flow",
        domain: "widgetco",
        agent_slugs: ["base-scout"],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "base-scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      });

      const g = resolveGenome(consumer);

      expect(g.load_errors, JSON.stringify(g.load_errors)).toEqual([]);
      expect(g.agents.has("base-scout")).toBe(true);
      expect(g.standards.has("flow")).toBe(true);
      expect(g.provenance?.get("agent:base-scout")).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("no manifest = a plain single-root load (backward compatible)", () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-nomanifest-"));
    try {
      writeJson(root, "agents", "solo.json", { slug: "solo", primitives: ["SENSE"], output_types: ["Signal"] });
      const g = resolveGenome(root);
      expect(g.agents.has("solo")).toBe(true);
      expect(g.core_types.size).toBe(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
