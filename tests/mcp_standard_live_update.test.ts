// Live-update: a standard composed through the MCP surface must be dispatchable
// in the SAME session — without a server restart / re-bootstrap.
//
// Bug (T14 / "manual-refresh-required"): standard_compose persisted the file +
// ledger but never updated deps.standards, the in-memory map gig_dispatch reads.
// So the intended workflow — compose, then dispatch — returned "unknown
// standard" until the process re-bootstrapped. The MCP surface is the genome's
// mouth; a write through it MUST update the live runtime, not just disk.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, type DomainType } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import type { Agent } from "../src/composition.js";
import type { AgentInvoker } from "../src/runtime.js";

const note: DomainType = {
  slug: "note", extends: "Signal", domain: "demo",
  schema: { type: "object", properties: { text: { type: "string" } } }, required_fields: [],
};
const gist: DomainType = {
  slug: "gist", extends: "Interpretation", domain: "demo",
  schema: { type: "object", properties: { text: { type: "string" } } }, required_fields: [],
};
const sensor2: Agent = { ...TEST_BEHAVIOR, slug: "sensor2", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" };
const summarizer2: Agent = { ...TEST_BEHAVIOR, slug: "summarizer2", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["gist"], domain: "demo" };

const mockInvoke: AgentInvoker = ({ agent }) => (agent.slug === "sensor2" ? { text: "sensed" } : { text: "summarized" });

function makeDeps(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(gist);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map(),
    invoke: mockInvoke,
    model_version: "test",
  };
}

describe("MCP write-through: compose → dispatch in one session", () => {
  it("a standard composed via standard_compose is immediately dispatchable (no restart)", async () => {
    const deps = makeDeps();
    const compose = await dispatchTool("standard_compose", {
      slug: "live-compose-test",
      domain: "demo",
      agents: [sensor2, summarizer2],
      phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "sensor2", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer2", depends_on: [], input_contract: [], output_contract: ["gist"], required_skills: [] }] }],
    }, deps);
    expect(compose.ok).toBe(true);

    // Same deps, same session — the dispatcher must see what we just composed.
    const run = await dispatchTool("gig_dispatch", { standard_slug: "live-compose-test", input: {} }, deps);
    expect(run.ok).toBe(true);
    expect((run.data as { manifest: { output_count: number } }).manifest.output_count).toBe(2);
  });
});
