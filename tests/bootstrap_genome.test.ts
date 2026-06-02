// O15 / §13 — the Bootstrap Run + rm-rf-rebuild litmus. The repo IS the genome:
// a fresh process loads the genome FROM DISK (core_types/ on the real repo root),
// builds a registry with zero hardcoded core types, extends it at runtime, and runs
// a full gig end-to-end through the MCP surface. Proves "seed the schema → seed the
// players → the loop runs" boots from files alone.
// Counter-claim: the disk genome is missing/!=6 core types, or a gig can't run
// on the registry that was reconstituted purely from files.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadGenome, loadRegistry, createOutputStore, MemoryLedger, dispatchTool,
  type ServerDeps, type DomainType, type AgentInvoker, type Standard, type Agent,
} from "../src";

// the repo root = this test file's dir (tests/) joined with ".."
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("§13 Bootstrap Run — genome boots from disk", () => {
  it("loadGenome reads exactly the 6 core types off the real repo's core_types/", () => {
    const genome = loadGenome(REPO_ROOT);
    expect([...genome.core_types.keys()].sort()).toEqual(
      ["Artifact", "Interpretation", "Judgment", "Plan", "Signal", "Verdict"],
    );
  });

  it("a registry reconstituted from the disk genome runs a full gig end-to-end (rebuild litmus)", async () => {
    // 1. boot the registry from FILES — no hardcoded core types
    const genome = loadGenome(REPO_ROOT);
    const registry = loadRegistry(genome);

    // 2. extend it at runtime (domain types added on top of the disk-booted core)
    const pageModel: DomainType = { slug: "page-model", extends: "Signal", domain: "eirtests", schema: { properties: { url: { type: "string" } } }, required_fields: ["url"] };
    const finding: DomainType = { slug: "finding", extends: "Interpretation", domain: "eirtests", schema: { properties: { title: { type: "string" } } }, required_fields: ["title"] };
    registry.registerType(pageModel);
    registry.registerType(finding);

    // 3. wire the server on the booted registry and run a gig through the MCP surface
    const scout: Agent = { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
    const analyst: Agent = { slug: "analyst", primitives: ["INTERPRET"], input_types: ["page-model"], output_types: ["finding"], domain: "eirtests" };
    const scan: Standard = { slug: "scan", domain: "eirtests", agents: [scout, analyst], phases: [{ name: "sense", agent: "scout" }, { name: "interpret", agent: "analyst" }] };
    const invoke: AgentInvoker = ({ agent }) => (agent.slug === "scout" ? { url: "/" } : { title: "x" });
    const deps: ServerDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map([[scan.slug, scan]]), invoke, model_version: "m" };

    const d = await dispatchTool("gig_dispatch", { standard_slug: "scan", input: {} }, deps);
    expect(d.ok).toBe(true);
    expect((d.data as { manifest: { output_count: number } }).manifest.output_count).toBe(2);
    // the outputs validated against the disk-booted core types
    expect(deps.outputs.all().map((o) => o.domain_type).sort()).toEqual(["finding", "page-model"]);
  });

  it("a genome-loaded type validates instances with zero manual registerType for the core (counter-claim guard)", () => {
    const registry = loadRegistry(loadGenome(REPO_ROOT));
    // an unregistered domain type must NOT validate — the registry only knows what was booted
    const res = registry.validate({ core_type: "Signal", domain_type: "ghost-type", data: { anything: true } });
    expect(res.valid).toBe(false);
  });
});
