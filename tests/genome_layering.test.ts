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
import { loadLayeredGenome, resolveGenome, genomeCascadeCheck } from "../src/loader.js";
import { bootstrapServerDeps, dispatchTool } from "../src";

function writeJson(dir: string, sub: string, name: string, obj: unknown): void {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), JSON.stringify(obj));
}

// fake an installed npm package under <consumer>/node_modules/<pkg>, shipping a genome
function writeInstalledPackage(consumerRoot: string, pkg: string, version: string): void {
  const pkgDir = join(consumerRoot, "node_modules", pkg);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version }));
  writeJson(pkgDir, "agents", "base-player.json", { slug: "base-player", primitives: ["SENSE"], output_types: ["Signal"] });
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

describe("genome cascade: base-evolution impact on the consumer layer", () => {
  it("reports a consumer standard that breaks when the base drops the player it composes", () => {
    const fromBase = mkdtempSync(join(tmpdir(), "coltrane-from-"));
    const toBase = mkdtempSync(join(tmpdir(), "coltrane-to-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-casc-"));
    try {
      // fromBase ships base-scout; toBase renamed it away (base-scout no longer exists)
      writeJson(fromBase, "agents", "base-scout.json", { slug: "base-scout", primitives: ["SENSE"], output_types: ["Signal"] });
      writeJson(toBase, "agents", "base-finder.json", { slug: "base-finder", primitives: ["SENSE"], output_types: ["Signal"] });
      // consumer composes base-scout — fine against fromBase, broken against toBase
      writeJson(consumer, "standards", "flow.json", {
        slug: "flow",
        domain: "widgetco",
        agent_slugs: ["base-scout"],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "base-scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      });

      const report = genomeCascadeCheck(consumer, fromBase, toBase);

      expect(report.broken.length).toBe(1);
      expect(report.broken[0]?.slug).toBe("flow");
      expect(report.broken[0]?.error).toMatch(/base-scout/);
    } finally {
      rmSync(fromBase, { recursive: true, force: true });
      rmSync(toBase, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("a consumer that uses nothing base-specific has an empty cascade", () => {
    const fromBase = mkdtempSync(join(tmpdir(), "coltrane-from2-"));
    const toBase = mkdtempSync(join(tmpdir(), "coltrane-to2-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-casc2-"));
    try {
      writeJson(fromBase, "agents", "base-a.json", { slug: "base-a", primitives: ["SENSE"], output_types: ["Signal"] });
      writeJson(toBase, "agents", "base-b.json", { slug: "base-b", primitives: ["SENSE"], output_types: ["Signal"] });
      writeJson(consumer, "agents", "own.json", { slug: "own", primitives: ["SENSE"], output_types: ["Signal"], domain: "widgetco" });
      const report = genomeCascadeCheck(consumer, fromBase, toBase);
      expect(report.broken).toEqual([]);
    } finally {
      rmSync(fromBase, { recursive: true, force: true });
      rmSync(toBase, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});

describe("genome layering — review follow-ups", () => {
  it("an extends cycle (A → B → A) is detected and rejected", () => {
    const a = mkdtempSync(join(tmpdir(), "coltrane-cyc-a-"));
    const b = mkdtempSync(join(tmpdir(), "coltrane-cyc-b-"));
    try {
      writeFileSync(join(a, "genome.json"), JSON.stringify({ extends: [b] }));
      writeFileSync(join(b, "genome.json"), JSON.stringify({ extends: [a] }));
      expect(() => resolveGenome(a)).toThrow(/cycle/i);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("consumer references slug X AND overrides slug X — the standard resolves to the OVERRIDE", () => {
    const base = mkdtempSync(join(tmpdir(), "coltrane-ovbase-"));
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-ovcons-"));
    try {
      // base + consumer both define agnostic "shared"; distinguish by allowed_tools
      writeJson(base, "agents", "shared.json", { slug: "shared", primitives: ["SENSE"], output_types: ["Signal"], allowed_tools: ["base-tool"] });
      writeJson(consumer, "agents", "shared.json", { slug: "shared", primitives: ["SENSE"], output_types: ["Signal"], allowed_tools: ["consumer-tool"] });
      writeJson(consumer, "standards", "flow.json", {
        slug: "flow",
        domain: "widgetco",
        agent_slugs: ["shared"],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "shared", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      });

      const g = loadLayeredGenome([base, consumer]);

      expect(g.load_errors).toEqual([]);
      // override-wins at the genome level
      expect(g.agents.get("shared")?.allowed_tools).toEqual(["consumer-tool"]);
      expect(g.provenance?.get("agent:shared")).toBe(consumer);
      // and the standard's reference resolved to the consumer-overridden agent, not the base
      const flow = g.standards.get("flow");
      const seated = flow?.agents.find((a) => a.slug === "shared");
      expect(seated?.allowed_tools).toEqual(["consumer-tool"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});

describe("package-resolved base + version pinning", () => {
  it("resolves a base by package name and honors a MATCHING version pin", () => {
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-pkg-"));
    try {
      writeInstalledPackage(consumer, "@test/base", "1.0.0");
      writeFileSync(join(consumer, "genome.json"), JSON.stringify({ extends: ["@test/base@1.0.0"] }));
      writeJson(consumer, "standards", "flow.json", {
        slug: "flow",
        domain: "widgetco",
        agent_slugs: ["base-player"],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "base-player", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      });
      const g = resolveGenome(consumer);
      expect(g.load_errors, JSON.stringify(g.load_errors)).toEqual([]);
      expect(g.agents.has("base-player")).toBe(true);
      expect(g.standards.has("flow")).toBe(true);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("a version-pin MISMATCH surfaces a manifest load_error (pinned vX, installed vY)", () => {
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-pin-"));
    try {
      writeInstalledPackage(consumer, "@test/base", "2.0.0"); // installed 2.0.0
      writeFileSync(join(consumer, "genome.json"), JSON.stringify({ extends: ["@test/base@1.0.0"] })); // pinned 1.0.0
      const g = resolveGenome(consumer);
      const pinErr = g.load_errors.find((e) => e.kind === "manifest" && e.slug === "@test/base");
      expect(pinErr, "expected a manifest pin-mismatch load_error").toBeDefined();
      expect(pinErr!.error).toMatch(/pinned to 1\.0\.0/);
      expect(pinErr!.error).toMatch(/2\.0\.0 is installed/);
      // the base still loaded (mismatch is a warning, not a hard fail)
      expect(g.agents.has("base-player")).toBe(true);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("the pin-mismatch warning + provenance are queryable at runtime via system_health", async () => {
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-rt-"));
    try {
      writeInstalledPackage(consumer, "@test/base", "2.0.0"); // installed 2.0.0
      writeFileSync(join(consumer, "genome.json"), JSON.stringify({ extends: ["@test/base@1.0.0"] })); // pinned 1.0.0
      const deps = bootstrapServerDeps(consumer);
      const res = await dispatchTool("system_health", {}, deps);
      const data = res.data as { load_errors: Array<{ kind: string; error: string }>; provenance: Record<string, string> };
      // #2 — pin mismatch is readable at runtime, not boot-time-only
      expect(data.load_errors.some((e) => e.kind === "manifest" && /pinned to 1\.0\.0/.test(e.error))).toBe(true);
      // #4 — provenance is exposed; the base player is attributed to a layer
      expect(Object.keys(data.provenance).some((k) => k.startsWith("agent:base-player"))).toBe(true);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("an unresolvable base package surfaces a manifest load_error", () => {
    const consumer = mkdtempSync(join(tmpdir(), "coltrane-noresolve-"));
    try {
      writeFileSync(join(consumer, "genome.json"), JSON.stringify({ extends: ["@test/not-installed"] }));
      const g = resolveGenome(consumer);
      const err = g.load_errors.find((e) => e.kind === "manifest" && /cannot resolve base package/.test(e.error));
      expect(err).toBeDefined();
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
