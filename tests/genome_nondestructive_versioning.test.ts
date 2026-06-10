// Non-destructive versioning: a re-compose / re-define over an existing slug
// must NOT silently destroy the prior bytes. The ledger keeps the identity hash;
// this keeps the actual prior content, snapshotted under .coltrane/history/ so a
// definition is recoverable, not just provably-changed.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent } from "../src/composition.js";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { type: "object", properties: { text: { type: "string" } } }, required_fields: [] };
const gist: DomainType = { slug: "gist", extends: "Interpretation", domain: "demo", schema: { type: "object", properties: { text: { type: "string" } } }, required_fields: [] };
const sensor2: Agent = { ...TEST_BEHAVIOR, slug: "sensor2", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" };
const summarizer2: Agent = { ...TEST_BEHAVIOR, slug: "summarizer2", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["gist"], domain: "demo" };

function makeDeps(dir: string): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(gist);
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map(), genome_dir: dir };
}

describe("non-destructive genome writes", () => {
  it("composing over an existing standard slug snapshots the prior bytes before overwriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-ver-"));
    const deps = makeDeps(dir);
    const slug = "vtest";

    // v1 — single-phase standard
    await dispatchTool("standard_compose", { slug, domain: "demo", agents: [sensor2], phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor2", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] }, deps);
    const v1 = readFileSync(join(dir, "standards", `${slug}.json`), "utf8");

    // v2 — different content (adds a second phase)
    await dispatchTool("standard_compose", { slug, domain: "demo", agents: [sensor2, summarizer2], phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor2", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer2", depends_on: [], input_contract: [], output_contract: ["gist"], required_skills: [] }] }] }, deps);
    const v2 = readFileSync(join(dir, "standards", `${slug}.json`), "utf8");

    expect(v2).not.toBe(v1); // current file updated to v2

    // prior bytes preserved under .coltrane/history/standards/<slug>/
    const histDir = join(dir, ".coltrane", "history", "standards", slug);
    expect(existsSync(histDir)).toBe(true);
    const snaps = readdirSync(histDir);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(histDir, snaps[0]!), "utf8")).toBe(v1); // the OLD bytes, intact
  });

  it("re-composing identical content writes no history snapshot (no-op overwrite)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-ver-"));
    const deps = makeDeps(dir);
    const slug = "idemp";
    const args = { slug, domain: "demo", agents: [sensor2], phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor2", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }] };
    await dispatchTool("standard_compose", args, deps);
    await dispatchTool("standard_compose", args, deps);
    const histDir = join(dir, ".coltrane", "history", "standards", slug);
    expect(existsSync(histDir)).toBe(false); // identical bytes → nothing to preserve
  });
});
