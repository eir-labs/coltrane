// E6 — full provenance trace from a final artifact back to the original signal,
// THROUGH the MCP surface. A 3-phase gig builds a real derived_from chain
// (signal → interpretation → artifact); output_trace must return every ancestor.
// Counter-claim: the trace breaks or drops an edge (an ancestor missing), or
// a root signal falsely reports ancestors it never had.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  dispatchTool, createRegistry, createOutputStore, MemoryLedger,
  type ServerDeps, type DomainType, type AgentInvoker, type Standard, type Agent,
} from "../src";

const pageModel: DomainType = { slug: "page-model", extends: "Signal", domain: "eirtests", schema: { properties: { url: { type: "string" } } }, required_fields: ["url"] };
const finding: DomainType = { slug: "finding", extends: "Interpretation", domain: "eirtests", schema: { properties: { title: { type: "string" } } }, required_fields: ["title"] };
const fixPatch: DomainType = { slug: "fix-patch", extends: "Artifact", domain: "eirtests", schema: { properties: { summary: { type: "string" } } }, required_fields: ["summary"] };

const scout: Agent = { ...TEST_BEHAVIOR, slug: "site-scout", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
const analyst: Agent = { ...TEST_BEHAVIOR, slug: "site-analyst", primitives: ["INTERPRET"], input_types: ["page-model"], output_types: ["finding"], domain: "eirtests" };
const writer: Agent = { ...TEST_BEHAVIOR, slug: "fix-writer", primitives: ["CREATE"], input_types: ["finding"], output_types: ["fix-patch"], domain: "eirtests" };

const standard: Standard = {
  slug: "scan-and-fix", domain: "eirtests", agents: [scout, analyst, writer],
  phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "site-scout", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] }, { name: "interpret", chairs: [{ role: "interpret", agent_slug: "site-analyst", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] }, { name: "create", chairs: [{ role: "create", agent_slug: "fix-writer", depends_on: [], input_contract: [], output_contract: ["fix-patch"], required_skills: [] }] }],
};

// Each output carries its own core's substance — a Signal names its source, an
// Interpretation states its claims, an Artifact declares how it can be checked.
// outputs.write enforces every one of them on every seal (#227/#228 and the #227 ruling).
const invoke: AgentInvoker = ({ agent }) =>
  agent.slug === "site-scout" ? { url: "/products", source: "https://example.com/products" }
  : agent.slug === "site-analyst" ? { title: "missing alt text", claims: ["an image has no alt text"] }
  : { summary: "added alt attributes to 12 images", validation_criteria: ["every <img> has a non-empty alt"] };

function wired(): ServerDeps {
  const registry = createRegistry();
  [pageModel, finding, fixPatch].forEach((t) => registry.registerType(t));
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map([[standard.slug, standard]]), invoke, model_version: "claude-opus-4-7" };
}

describe("E6: full provenance trace artifact → signal", () => {
  it("traces the artifact back through the interpretation to the original signal", async () => {
    const deps = wired();
    const d = await dispatchTool("gig_dispatch", { wait: true, standard_slug: "scan-and-fix", input: { site_url: "x.com" } }, deps);
    const { gig_id } = d.data as { gig_id: string };

    const q = await dispatchTool("output_query", { gig_id }, deps);
    const outs = (q.data as { outputs: { id: string; domain_type: string }[] }).outputs;
    const sig = outs.find((o) => o.domain_type === "page-model")!;
    const interp = outs.find((o) => o.domain_type === "finding")!;
    const art = outs.find((o) => o.domain_type === "fix-patch")!;

    const trace = await dispatchTool("output_trace", { output_id: art.id }, deps);
    const ids = (trace.data as { graph: { nodes: { id: string }[] }; root_signals: { id: string }[] }).graph.nodes.map((n) => n.id);
    // every ancestor present — no broken edge
    expect(ids).toContain(interp.id);
    expect(ids).toContain(sig.id);
    // the root of the trace is the original signal (input_refs empty)
    const roots = (trace.data as { root_signals: { id: string }[] }).root_signals.map((r) => r.id);
    expect(roots).toContain(sig.id);
  });

  it("a root signal has no ancestors — trace returns the empty closure, no phantom edges", async () => {
    const deps = wired();
    const d = await dispatchTool("gig_dispatch", { wait: true, standard_slug: "scan-and-fix", input: {} }, deps);
    const { gig_id } = d.data as { gig_id: string };
    const q = await dispatchTool("output_query", { gig_id }, deps);
    const sig = (q.data as { outputs: { id: string; domain_type: string }[] }).outputs.find((o) => o.domain_type === "page-model")!;
    const trace = await dispatchTool("output_trace", { output_id: sig.id }, deps);
    // trace returns the ANCESTOR closure (excludes the node itself); a root signal
    // has none — anything here would be a fabricated edge.
    const ids = (trace.data as { graph: { nodes: { id: string }[] } }).graph.nodes.map((n) => n.id);
    expect(ids).toEqual([]);
    // and the signal is correctly identified as a root
    const roots = (trace.data as { root_signals: { id: string }[] }).root_signals.map((r) => r.id);
    expect(roots).toEqual([]);
  });
});
