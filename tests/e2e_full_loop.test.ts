// E1 — the full loop, THROUGH the MCP surface: gig_dispatch → runtime executes →
// typed outputs land in the store → output_query returns them → output_trace walks
// provenance. This is "actually runs end-to-end": every step via dispatchTool, the
// same entry an MCP client hits. The agent invoker is mocked (deterministic) so the
// orchestration is exercised without spawning Claude.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  dispatchTool,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type ServerDeps,
  type DomainType,
  type AgentInvoker,
} from "../src";
import type { Standard, Agent } from "../src";

const pageModel: DomainType = {
  slug: "page-model",
  extends: "Signal",
  domain: "eirtests",
  schema: { properties: { url: { type: "string" } } },
  required_fields: ["url"],
};
const finding: DomainType = {
  slug: "finding",
  extends: "Interpretation",
  domain: "eirtests",
  schema: { properties: { title: { type: "string" } } },
  required_fields: ["title"],
};

const scout: Agent = { ...TEST_BEHAVIOR, slug: "site-scout", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
const analyst: Agent = { ...TEST_BEHAVIOR, slug: "site-analyst", primitives: ["INTERPRET"], input_types: ["page-model"], output_types: ["finding"], domain: "eirtests" };
const readinessScan: Standard = {
  slug: "readiness-scan",
  domain: "eirtests",
  agents: [scout, analyst],
  phases: [
    { name: "sense", chairs: [{ role: "sense", agent_slug: "site-scout", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] },
    { name: "interpret", chairs: [{ role: "interpret", agent_slug: "site-analyst", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] },
  ],
};

const invoke: AgentInvoker = ({ agent }) =>
  agent.slug === "site-scout" ? { url: "/products" } : { title: "missing alt text" };

function wiredServer(): ServerDeps {
  const registry = createRegistry();
  registry.registerType(pageModel);
  registry.registerType(finding);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[readinessScan.slug, readinessScan]]),
    invoke,
    model_version: "claude-opus-4-7",
  };
}

describe("E1: full loop through the MCP surface", () => {
  it("gig_dispatch → runtime executes → outputs land → output_query returns them → output_trace walks provenance", async () => {
    const deps = wiredServer();

    // 1. dispatch a standard through the MCP tool surface
    const dispatch = await dispatchTool("gig_dispatch", { standard_slug: "readiness-scan", input: { site_url: "example.com" } }, deps);
    expect(dispatch.ok).toBe(true);
    const { gig_id, manifest } = dispatch.data as { gig_id: string; manifest: { output_count: number; genome_hash: string } };
    expect(gig_id).toBeTruthy();
    expect(manifest.output_count).toBe(2);
    expect(manifest.genome_hash).toBeTruthy();

    // 2. monitor reports it complete
    const monitor = await dispatchTool("gig_monitor", { gig_id }, deps);
    expect((monitor.data as { status: string }).status).toBe("complete");

    // 3. query the outputs back through the surface
    const query = await dispatchTool("output_query", { gig_id }, deps);
    const outs = (query.data as { outputs: { id: string; domain_type: string; input_refs: string[] }[] }).outputs;
    expect(outs.length).toBe(2);
    expect(outs.map((o) => o.domain_type).sort()).toEqual(["finding", "page-model"]);

    // 4. trace the finding's provenance back to the page-model
    const fnd = outs.find((o) => o.domain_type === "finding")!;
    const pm = outs.find((o) => o.domain_type === "page-model")!;
    const trace = await dispatchTool("output_trace", { output_id: fnd.id }, deps);
    const nodeIds = (trace.data as { graph: { nodes: { id: string }[] } }).graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain(pm.id);
  });

  it("unknown standard is rejected, not silently run", async () => {
    const deps = wiredServer();
    const r = await dispatchTool("gig_dispatch", { standard_slug: "no-such-standard" }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown standard/);
  });
});
