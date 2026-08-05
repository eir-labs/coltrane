// O21 — genome file-loading: the core "add capability = add a FILE" claim, made real.
// Before this, loadGenome read ONLY core_types/ + domain_types/; agents/ standards/
// skills/ evals/ dirs were never read, so an agent/standard could only exist as inline
// TS. This proves all five definition classes load from FILES, validated identically to
// the code path (agents via defineAgent, standards via composeStandard), and that the
// shipped example genome (the worked hello-band) loads + composes from disk.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { writeSkillPackage } from "./_support/genome.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGenome, GenomeLoadError } from "../src/loader.js";
import { loadRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { runGig, type AgentInvoker } from "../src/runtime.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Build a throwaway genome dir with the required core types copied in + custom content.
function scratchGenome(): string {
  const dir = mkdtempSync(join(tmpdir(), "genome-"));
  cpSync(join(REPO, "core_types"), join(dir, "core_types"), { recursive: true });
  return dir;
}
function writeJson(dir: string, sub: string, name: string, obj: unknown) {
  mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, sub, name), JSON.stringify(obj));
}

describe("genome file-loading: all five classes load from files", () => {
  it("loads agents from files, validated through defineAgent", () => {
    const dir = scratchGenome();
    writeJson(dir, "agents", "sensor.json", { ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
    const g = loadGenome(dir);
    const a = g.agents.get("sensor");
    expect(a).toBeDefined();
    expect(a!.primitives).toEqual(["SENSE"]);
    expect(a!.input_types).toEqual([]); // defineAgent normalized the optional field
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads standards from files, resolving agent_slugs + composing", () => {
    const dir = scratchGenome();
    writeJson(dir, "agents", "sensor.json", { ...TEST_BEHAVIOR, slug: "sensor", primitives: ["SENSE"], output_types: ["raw-note"], domain: "demo" });
    writeJson(dir, "agents", "summarizer.json", { ...TEST_BEHAVIOR, slug: "summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" });
    writeJson(dir, "standards", "summarize.json", {
      slug: "summarize", domain: "demo", agent_slugs: ["sensor", "summarizer"],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] }],
    });
    const g = loadGenome(dir);
    const s = g.standards.get("summarize");
    expect(s).toBeDefined();
    // composeStandard normalizes legacy {name, agent} phases to single-chair
    // phases — the bound agent_slug now lives on chairs[0].agent_slug.
    expect(s!.phases.map((p) => p.chairs?.[0]?.agent_slug)).toEqual(["sensor", "summarizer"]);
    expect(s!.agents.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads skill packages + evals as slug-keyed records", () => {
    const dir = scratchGenome();
    writeSkillPackage(dir, { slug: "summarize-tight", md: "Be terse." });
    writeJson(dir, "evals", "gist-present.json", { slug: "gist-present", asserts: "output has a gist" });
    const g = loadGenome(dir);
    expect(g.skills.get("summarize-tight")).toBeDefined();
    expect(g.evals.get("gist-present")).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });

  // Rob #129: was hard-throw, now per-definition soft-fail. The genome still
  // loads; the offending file is recorded in load_errors.
  it("records a standard referencing an unknown agent as a load_error", () => {
    const dir = scratchGenome();
    writeJson(dir, "standards", "broken.json", { slug: "broken", domain: "demo", agent_slugs: ["ghost"], phases: [{ name: "x", chairs: [{ role: "x", agent_slug: "ghost", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }] });
    const g = loadGenome(dir);
    expect(g.standards.has("broken")).toBe(false);
    const err = g.load_errors.find((e) => e.kind === "standard" && e.slug === "broken");
    expect(err).toBeDefined();
    expect(err!.error).toMatch(/ghost|unknown agent/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("records duplicate agent slug as a load_error on the second file", () => {
    const dir = scratchGenome();
    writeJson(dir, "agents", "a.json", { ...TEST_BEHAVIOR, slug: "dup", primitives: ["SENSE"], domain: "demo" });
    writeJson(dir, "agents", "b.json", { ...TEST_BEHAVIOR, slug: "dup", primitives: ["SENSE"], domain: "demo" });
    const g = loadGenome(dir);
    // The first one wins; the second is skipped + recorded.
    expect(g.agents.has("dup")).toBe(true);
    const err = g.load_errors.find((e) => e.kind === "agent" && e.slug === "dup" && /duplicate/i.test(e.error));
    expect(err).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the SHIPPED example genome loads from disk (clone → it's there → it composes)", () => {
  it("the repo's own genome dirs load: sensor + summarizer agents, summarize standard", () => {
    const g = loadGenome(REPO);
    expect(g.agents.get("sensor")).toBeDefined();
    expect(g.agents.get("summarizer")).toBeDefined();
    const s = g.standards.get("summarize");
    expect(s).toBeDefined();
    expect(s!.agents.length).toBe(2);
  });

  it("the file-loaded standard RUNS a gig end-to-end (genome files → typed, sealed outputs)", async () => {
    const g = loadGenome(REPO);
    const registry = loadRegistry(g);
    const standard = g.standards.get("summarize")!;
    const invoke: AgentInvoker = (ctx) =>
      ctx.agent.slug === "sensor"
        ? { text: "the room is loud", source: "microphone://demo/room-1" }
        : { gist: "loud room", claims: ["the room is loud"] };
    const result = await runGig(standard, { topic: "noise" },
      { outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke, model_version: "deterministic-example" });
    expect(result.status).toBe("complete");
    const types = result.outputs.map((o) => o.domain_type).sort();
    expect(types).toEqual(["raw-note", "summary"]); // both phases produced typed, validated outputs from the file-loaded genome
  });
});
