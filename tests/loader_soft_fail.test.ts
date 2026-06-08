// Soft-fail loader. Issue #129.
//
// Intent: when one definition file is invalid, loadGenome skips it +
// accumulates the error in load_errors. Other valid definitions
// continue to load. Core-type missing still HARD-fails.
//
// Non-goals: not changing the core-types gate (those must be present for the
// system to function). Not removing strictness, only softening the
// per-definition gate so one bad file can't block the whole genome.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGenome, GenomeLoadError } from "../src/loader.js";

const REQUIRED_CORE_TYPES = [
  { slug: "Signal", description: "raw observation" },
  { slug: "Interpretation", description: "structured meaning" },
  { slug: "Judgment", description: "evaluation against a rubric" },
  { slug: "Plan", description: "ordered intent" },
  { slug: "Artifact", description: "produced deliverable" },
  { slug: "Verdict", description: "pass/fail with reasons" },
];

function writeJson(dir: string, name: string, body: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

function seedCoreTypes(root: string): void {
  for (const c of REQUIRED_CORE_TYPES) writeJson(join(root, "core_types"), `${c.slug}.json`, c);
}

describe("loadGenome: soft-fail per definition (Rob #129)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "coltrane-loader-soft-fail-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("one bad standard skipped; good standards + agents still load; load_errors records the skip", () => {
    seedCoreTypes(root);

    // Two valid agents
    writeJson(join(root, "agents"), "scout.json", {
      slug: "scout",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    });
    writeJson(join(root, "agents"), "summarizer.json", {
      slug: "summarizer",
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
    });

    // One valid standard
    writeJson(join(root, "standards"), "good.json", {
      slug: "good-standard",
      domain: "demo",
      agent_slugs: ["scout"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    });

    // One BROKEN standard: references an undefined agent — composeStandard rejects it
    writeJson(join(root, "standards"), "broken.json", {
      slug: "broken-standard",
      domain: "demo",
      agent_slugs: ["scout"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "ghost-agent", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }],
    });

    const genome = loadGenome(root);

    // Valid definitions all load
    expect(genome.agents.has("scout")).toBe(true);
    expect(genome.agents.has("summarizer")).toBe(true);
    expect(genome.standards.has("good-standard")).toBe(true);

    // Broken standard is skipped, not killing the load
    expect(genome.standards.has("broken-standard")).toBe(false);

    // load_errors records exactly the offending file
    expect(genome.load_errors).toBeDefined();
    expect(genome.load_errors.length).toBeGreaterThanOrEqual(1);
    const errs = genome.load_errors.filter((e) => e.kind === "standard");
    expect(errs).toHaveLength(1);
    const e0 = errs[0]!;
    expect(e0.path).toMatch(/broken\.json$/);
    expect(e0.slug).toBe("broken-standard");
    expect(e0.error).toMatch(/ghost-agent|unknown agent|undefined agent/i);
  });

  it("one bad agent skipped; other agents load; standards referencing it are skipped too with their own load_errors", () => {
    seedCoreTypes(root);

    // Good agent
    writeJson(join(root, "agents"), "scout.json", {
      slug: "scout",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    });

    // Bad agent — no primitives at all (defineAgent rejects)
    writeJson(join(root, "agents"), "broken-agent.json", {
      slug: "broken-agent",
      primitives: [],
      output_types: ["raw-note"],
      domain: "demo",
    });

    // Standard referencing the broken agent must be soft-skipped too
    writeJson(join(root, "standards"), "depends-on-broken.json", {
      slug: "depends-on-broken",
      domain: "demo",
      agent_slugs: ["broken-agent"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "broken-agent", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }],
    });

    const genome = loadGenome(root);

    expect(genome.agents.has("scout")).toBe(true);
    expect(genome.agents.has("broken-agent")).toBe(false);
    expect(genome.standards.has("depends-on-broken")).toBe(false);

    const agentErrs = genome.load_errors.filter((e) => e.kind === "agent");
    const stdErrs = genome.load_errors.filter((e) => e.kind === "standard");
    expect(agentErrs).toHaveLength(1);
    expect(agentErrs[0]!.slug).toBe("broken-agent");
    expect(stdErrs).toHaveLength(1);
    expect(stdErrs[0]!.slug).toBe("depends-on-broken");
  });

  it("malformed JSON in a definition file is skipped; load_errors records the path + parse error", () => {
    seedCoreTypes(root);

    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents", "good.json"), JSON.stringify({
      slug: "good",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    }));
    writeFileSync(join(root, "agents", "broken.json"), "{not valid json");

    const genome = loadGenome(root);
    expect(genome.agents.has("good")).toBe(true);
    const parseErrs = genome.load_errors.filter((e) => /malformed JSON|JSON|parse/i.test(e.error));
    expect(parseErrs.length).toBeGreaterThanOrEqual(1);
    expect(parseErrs.some((e) => e.path.endsWith("broken.json"))).toBe(true);
  });

  it("missing core type STILL hard-fails — soft path only applies past the strict gate", () => {
    // Only write 5 of the 6 required core types
    for (const c of REQUIRED_CORE_TYPES.slice(0, 5)) {
      writeJson(join(root, "core_types"), `${c.slug}.json`, c);
    }
    expect(() => loadGenome(root)).toThrow(GenomeLoadError);
  });

  it("clean genome reports an empty load_errors", () => {
    seedCoreTypes(root);
    writeJson(join(root, "agents"), "scout.json", {
      slug: "scout",
      primitives: ["SENSE"],
      output_types: ["raw-note"],
      domain: "demo",
    });

    const genome = loadGenome(root);
    expect(genome.load_errors).toEqual([]);
  });
});
