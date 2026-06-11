// E2 — backward-compat at scale: many scans run THROUGH the MCP surface, each
// producing a finding; the v1 `findings` view projects them all correctly. This is
// the migration guarantee — existing finding consumers keep working unchanged.
// Counter-claim: the view returns wrong rows (a non-eirtests / non-finding output
// leaks in), or projects stale/misjoined columns.
import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "./_support/agents.js";
import {
  dispatchTool, createRegistry, createOutputStore, MemoryLedger,
  type ServerDeps, type DomainType, type AgentInvoker, type Standard, type Agent,
} from "../src";

const pageModel: DomainType = { slug: "page-model", extends: "Signal", domain: "eirtests", schema: { properties: { url: { type: "string" } } }, required_fields: ["url"] };
const finding: DomainType = {
  slug: "finding", extends: "Verdict", domain: "eirtests",
  schema: { properties: { pattern_key: { type: "string" }, severity: { type: "string" }, title: { type: "string" } } },
  required_fields: ["pattern_key", "severity", "title"],
};
const note: DomainType = { slug: "note", extends: "Interpretation", domain: "codechange", schema: { properties: { body: { type: "string" } } }, required_fields: ["body"] };

const scout: Agent = { ...TEST_BEHAVIOR, slug: "site-scout", primitives: ["SENSE"], input_types: [], output_types: ["page-model"], domain: "eirtests" };
const verifier: Agent = { ...TEST_BEHAVIOR, slug: "readiness-verifier", primitives: ["VERIFY"], input_types: ["page-model"], output_types: ["finding"], domain: "eirtests" };
const scan: Standard = {
  slug: "readiness-scan", domain: "eirtests", agents: [scout, verifier],
  phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "site-scout", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] }, { name: "verify", chairs: [{ role: "verify", agent_slug: "readiness-verifier", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] }],
};

function wired(): ServerDeps {
  const registry = createRegistry();
  [pageModel, finding, note].forEach((t) => registry.registerType(t));
  const invoke: AgentInvoker = ({ agent, gig_input }) =>
    agent.slug === "site-scout"
      ? { url: `/page-${(gig_input as { n?: number }).n ?? 0}` }
      : { pattern_key: `pat-${(gig_input as { n?: number }).n ?? 0}`, severity: "high", title: `finding ${(gig_input as { n?: number }).n ?? 0}` };
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map([[scan.slug, scan]]), invoke, model_version: "m" };
}

describe("E2: backward-compat findings view at scale", () => {
  it("N scans through the surface → findings view projects N correct v1 rows", async () => {
    const deps = wired();
    const N = 25; // spirit of "100 scans" — fast + deterministic
    for (let n = 0; n < N; n++) {
      const r = await dispatchTool("gig_dispatch", { standard_slug: "readiness-scan", input: { n } }, deps);
      expect(r.ok).toBe(true);
    }
    const rows = deps.outputs.findings();
    expect(rows.length).toBe(N);
    expect(new Set(rows.map((r) => r.pattern_key)).size).toBe(N); // each scan distinct, no misjoin
    expect(rows.every((r) => r.severity === "high")).toBe(true);
    expect(rows.every((r) => r.agent_role === "readiness-verifier")).toBe(true); // agent_slug → agent_role
    expect(rows.every((r) => typeof r.title === "string" && r.title.startsWith("finding "))).toBe(true);
  });

  it("a non-eirtests note never leaks into the findings view", async () => {
    const deps = wired();
    await dispatchTool("gig_dispatch", { standard_slug: "readiness-scan", input: { n: 0 } }, deps);
    // a codechange note written straight to the store must NOT appear in findings()
    deps.outputs.write({ core_type: "Interpretation", domain_type: "note", domain: "codechange", gig_id: "g-note", agent_slug: "code-scout", primitive: "INTERPRET", data: { body: "not a finding" } });
    const rows = deps.outputs.findings();
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.title?.startsWith("finding "))).toBe(true);
  });
});
