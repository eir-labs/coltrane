// agent_evolve cascade — Bug 1 from the tamper-test session.
//
// The (slug, changes) call shape was a stub: it returned ok:true with a
// hardcoded empty cascade_check, never applied the change, never persisted to
// the genome files, and never re-bound the agent inside the standards that use
// it — so genome_hash was blind to agent_evolve. This pins the real contract:
//   1. apply `changes` to the named agent
//   2. type-check EVERY standard the agent is bound into (composeStandard)
//   3. fail CLOSED — if any binding standard breaks, reject + persist nothing
//   4. on success: persist agents/<slug>.json + rebind the in-memory standard
//      so a subsequent genome_hash actually moves
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Standard, Agent } from "../src/composition.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sensor: Agent = { slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" };
const summarizer: Agent = { slug: "summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" };
const summarize: Standard = {
  slug: "summarize",
  domain: "demo",
  agents: [sensor, summarizer],
  phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] }],
};

interface AffectedStandard { slug: string; type_check_passed: boolean; errors: string[] }
interface CascadeCheck { agents_affected: unknown[]; standards_affected: AffectedStandard[] }

function makeDeps(): { deps: ServerDeps; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-evolve-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "summarizer.json"), JSON.stringify(summarizer, null, 2) + "\n");
  writeFileSync(join(dir, "agents", "sensor.json"), JSON.stringify(sensor, null, 2) + "\n");
  const registry = createRegistry();
  const standards = new Map<string, Standard>([["summarize", structuredClone(summarize)]]);
  const deps: ServerDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards, genome_dir: dir };
  return { deps, dir };
}

describe("agent_evolve (slug, changes) cascade", () => {
  it("evolves an agent, type-checks the binding standard, persists, and rebinds in-memory", async () => {
    const { deps, dir } = makeDeps();
    // Widen outputs (an unconsumed extra output is legal; output_types is in genomeHash).
    const r = await dispatchTool("agent_evolve", { slug: "summarizer", changes: { output_types: ["summary", "gist"] } }, deps);
    expect(r.ok).toBe(true);
    const cc = (r.data as { cascade_check: CascadeCheck }).cascade_check;
    const aff = cc.standards_affected.find((s) => s.slug === "summarize");
    expect(aff).toBeTruthy();
    expect(aff!.type_check_passed).toBe(true);
    // persisted to disk
    const onDisk = JSON.parse(readFileSync(join(dir, "agents", "summarizer.json"), "utf8"));
    expect(onDisk.output_types).toEqual(["summary", "gist"]);
    // re-bound in the live standard so genome_hash sees it
    const embedded = deps.standards!.get("summarize")!.agents.find((a) => a.slug === "summarizer")!;
    expect(embedded.output_types).toEqual(["summary", "gist"]);
  });

  it("rejects an evolve that breaks a standard it is bound into; persists nothing (fail closed)", async () => {
    const { deps, dir } = makeDeps();
    // dropping raw-note breaks summarize: phase 2 input no longer produced upstream
    const r = await dispatchTool("agent_evolve", { slug: "summarizer", changes: { input_types: ["phase18-note"] } }, deps);
    expect(r.ok).toBe(false);
    const cc = (r.data as { cascade_check: CascadeCheck }).cascade_check;
    const aff = cc.standards_affected.find((s) => s.slug === "summarize");
    expect(aff!.type_check_passed).toBe(false);
    expect(aff!.errors.length).toBeGreaterThan(0);
    // disk unchanged — the evolve did not persist
    const onDisk = JSON.parse(readFileSync(join(dir, "agents", "summarizer.json"), "utf8"));
    expect(onDisk.input_types).toEqual(["raw-note"]);
    // in-memory standard unchanged too
    const embedded = deps.standards!.get("summarize")!.agents.find((a) => a.slug === "summarizer")!;
    expect(embedded.input_types).toEqual(["raw-note"]);
  });
});
