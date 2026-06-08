// #123 — eval_slugs declared on a standard were silently dropped. The runtime
// already runs evals when standard.eval_slugs is set (runtime.ts), but neither
// standard_compose nor the loader carried the field, so the 5th class never
// reached the runtime. This pins the full round-trip: compose → live map →
// persisted file → reload all preserve eval_slugs.
import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { loadGenome } from "../src/loader.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent } from "../src/composition.js";
import { mkdtempSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = process.cwd();
// reuse genome agent slugs so the reloaded standard's agent_slugs resolve
const sensor: Agent = { slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" };
const summarizer: Agent = { slug: "summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" };

function seedGenome(): string {
  const dir = mkdtempSync(join(tmpdir(), "coltrane-eval-"));
  for (const d of ["core_types", "domain_types", "agents", "standards", "skills", "evals"]) {
    const src = join(REPO, d);
    if (existsSync(src)) cpSync(src, join(dir, d), { recursive: true });
  }
  return dir;
}

describe("evals: eval_slugs survive compose → persist → reload (#123)", () => {
  it("standard_compose threads eval_slugs to the live map, the persisted file, and a reload", async () => {
    const dir = seedGenome();
    const registry = createRegistry();
    const deps: ServerDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map(), genome_dir: dir };

    const r = await dispatchTool("standard_compose", {
      slug: "eval-rt",
      domain: "demo",
      agents: [sensor, summarizer],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] }],
      eval_slugs: ["nonempty-summary"],
    }, deps);
    expect(r.ok).toBe(true);

    // live write-through carries eval_slugs (the running runtime would run them)
    expect(deps.standards!.get("eval-rt")?.eval_slugs).toContain("nonempty-summary");
    // persisted file carries eval_slugs
    const onDisk = JSON.parse(readFileSync(join(dir, "standards", "eval-rt.json"), "utf8"));
    expect(onDisk.eval_slugs).toContain("nonempty-summary");
    // a fresh load preserves them — the loader no longer drops the field
    const g = loadGenome(dir);
    expect(g.standards.get("eval-rt")?.eval_slugs).toContain("nonempty-summary");
  });
});
