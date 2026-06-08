// E3 — a multi-phase bug-fix standard runs end-to-end in order: find → triage →
// plan → fix → review, one primitive per phase (SENSE·INTERPRET·PLAN·CREATE·VERIFY).
// Every phase must execute, in declared order, each consuming the prior.
// Counter-claim: a phase is skipped (fewer outputs than phases) or the order
// is broken.
import { describe, it, expect } from "vitest";
import {
  dispatchTool, createRegistry, createOutputStore, MemoryLedger,
  type ServerDeps, type DomainType, type AgentInvoker, type Standard, type Agent,
} from "../src";

const types: DomainType[] = [
  { slug: "defect", extends: "Signal", domain: "codechange", schema: { properties: { symptom: { type: "string" } } }, required_fields: ["symptom"] },
  { slug: "triage", extends: "Interpretation", domain: "codechange", schema: { properties: { severity: { type: "string" } } }, required_fields: ["severity"] },
  { slug: "fix-plan", extends: "Plan", domain: "codechange", schema: { properties: { steps: { type: "string" } } }, required_fields: ["steps"] },
  { slug: "patch", extends: "Artifact", domain: "codechange", schema: { properties: { diff: { type: "string" } } }, required_fields: ["diff"] },
  { slug: "fix-review", extends: "Verdict", domain: "codechange", schema: { properties: { verdict: { type: "string" } } }, required_fields: ["verdict"] },
];

const agents: Agent[] = [
  { slug: "detector", primitives: ["SENSE"], input_types: [], output_types: ["defect"], domain: "codechange" },
  { slug: "triager", primitives: ["INTERPRET"], input_types: ["defect"], output_types: ["triage"], domain: "codechange" },
  { slug: "planner", primitives: ["PLAN"], input_types: ["triage"], output_types: ["fix-plan"], domain: "codechange" },
  { slug: "fixer", primitives: ["CREATE"], input_types: ["fix-plan"], output_types: ["patch"], domain: "codechange" },
  { slug: "reviewer", primitives: ["VERIFY"], input_types: ["patch"], output_types: ["fix-review"], domain: "codechange" },
];

const phaseOrder = ["find", "triage", "plan", "fix", "review"];
const bugFix: Standard = {
  slug: "bug-fix", domain: "codechange", agents,
  phases: [
    { name: "find", chairs: [{ role: "find", agent_slug: "detector", depends_on: [], input_contract: [], output_contract: ["defect"], required_skills: [] }] }, { name: "triage", chairs: [{ role: "triage", agent_slug: "triager", depends_on: [], input_contract: [], output_contract: ["triage"], required_skills: [] }] },
    { name: "plan", chairs: [{ role: "plan", agent_slug: "planner", depends_on: [], input_contract: [], output_contract: ["fix-plan"], required_skills: [] }] }, { name: "fix", chairs: [{ role: "fix", agent_slug: "fixer", depends_on: [], input_contract: [], output_contract: ["patch"], required_skills: [] }] }, { name: "review", chairs: [{ role: "review", agent_slug: "reviewer", depends_on: [], input_contract: [], output_contract: ["fix-review"], required_skills: [] }] },
  ],
};

const invoke: AgentInvoker = ({ agent }) => ({
  detector: { symptom: "500 on /checkout" }, triager: { severity: "critical" },
  planner: { steps: "null-check the cart" }, fixer: { diff: "+ if (!cart) return" }, reviewer: { verdict: "pass" },
}[agent.slug]!);

function wired(): ServerDeps {
  const registry = createRegistry();
  types.forEach((t) => registry.registerType(t));
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), standards: new Map([[bugFix.slug, bugFix]]), invoke, model_version: "m" };
}

describe("E3: bug-fix standard runs all phases in order", () => {
  it("all 5 phases execute, in declared order, none skipped", async () => {
    const deps = wired();
    const d = await dispatchTool("gig_dispatch", { standard_slug: "bug-fix", input: {} }, deps);
    expect(d.ok).toBe(true);
    expect((d.data as { manifest: { output_count: number } }).manifest.output_count).toBe(5);

    const q = await dispatchTool("output_query", { gig_id: (d.data as { gig_id: string }).gig_id }, deps);
    const outs = (q.data as { outputs: { phase: string; domain_type: string }[] }).outputs;
    // one output per phase, in declared order — no skip, no reorder
    expect(outs.map((o) => o.phase)).toEqual(phaseOrder);
    expect(outs.map((o) => o.domain_type)).toEqual(["defect", "triage", "fix-plan", "patch", "fix-review"]);
  });

  it("the review verdict traces back to the original defect (full chain intact)", async () => {
    const deps = wired();
    const d = await dispatchTool("gig_dispatch", { standard_slug: "bug-fix", input: {} }, deps);
    const q = await dispatchTool("output_query", { gig_id: (d.data as { gig_id: string }).gig_id }, deps);
    const outs = (q.data as { outputs: { id: string; domain_type: string }[] }).outputs;
    const review = outs.find((o) => o.domain_type === "fix-review")!;
    const defect = outs.find((o) => o.domain_type === "defect")!;
    const trace = await dispatchTool("output_trace", { output_id: review.id }, deps);
    const ids = (trace.data as { graph: { nodes: { id: string }[] } }).graph.nodes.map((n) => n.id);
    expect(ids).toContain(defect.id); // 5-hop chain reaches the root
  });
});
