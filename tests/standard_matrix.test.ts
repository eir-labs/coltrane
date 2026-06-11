// The standard matrix — the integration layer of the recursion. Each TopologySpec is
// materialized into real coltrane artifacts ONCE, and that single genome is asserted at
// TWO pyramid layers:
//   - UNIT: every agent it contains renders a valid behavioral prompt
//   - INTEGRATION: the standard it forms composes, runs through a deterministic invoker,
//     and satisfies the coordination invariants (completeness, provenance, reproducibility)
// Invalid topologies must fail closed at compose time. The agents here are generated, not
// hand-authored — combinatorial coverage that pops up at both layers from one spec.
import { describe, it, expect } from "vitest";
import { buildPrompt, runGig, BELBIN_DESCRIPTIONS } from "../src";
import type { Agent, AgentInvocationContext, AgentInvoker } from "../src";
import { materialize, TOPOLOGIES } from "./_support/specs.js";

const VALID = TOPOLOGIES.filter((t) => t.valid);
const INVALID = TOPOLOGIES.filter((t) => !t.valid);

// deterministic invoker: every agent emits schema-valid {value} for its output type.
const invoke: AgentInvoker = ({ agent }) => ({ value: `${agent.slug}-v` });

// ── UNIT layer: the generated agents are valid unit cases ────────────────────────
const unitCases = VALID.flatMap((t) =>
  materialize(t).agents.map((agent) => ({ id: `${t.name} :: ${agent.slug}`, agent })),
);

describe("recursion — UNIT: every agent inside a generated standard is a valid prompt case", () => {
  it.each(unitCases)("$id renders its behavioral load", ({ agent }) => {
    const prompt = buildPrompt({ agent, phase: "p", inputs: [], gig_input: {} } as AgentInvocationContext);
    expect(prompt).toContain(agent.identity);
    expect(prompt).toContain(agent.method);
    for (const role of agent.behavioral_primitives) {
      expect(prompt).toContain(role);
      expect(prompt).toContain(BELBIN_DESCRIPTIONS[role]);
    }
  });
});

// ── INTEGRATION layer: the same specs, run as gigs ───────────────────────────────
describe("recursion — INTEGRATION: every generated standard runs + holds the invariants", () => {
  it.each(VALID.map((t) => ({ id: t.name, topo: t })))("$id composes, runs, and coordinates", async ({ topo }) => {
    const g = materialize(topo);

    const res = await runGig(g.std, {}, { outputs: g.outputs, ledger: g.ledger, invoke });

    // completeness: one sealed output per chair, gig complete
    expect(res.status).toBe("complete");
    expect(res.outputs.length).toBe(topo.nodes.length);

    // provenance / order: every node that depends on upstream sees it in its input_refs
    for (const n of topo.nodes) {
      if (!n.depends_on?.length) continue;
      const o = res.outputs.find((x) => x.agent_slug === n.role)!;
      expect(o, `no output for ${n.role}`).toBeTruthy();
      expect(o.input_refs.length, `${n.role} has no provenance`).toBeGreaterThan(0);
    }
  });

  it.each(VALID.map((t) => ({ id: t.name, topo: t })))("$id is reproducible — same genome_hash + run_fingerprint across runs", async ({ topo }) => {
    const a = materialize(topo);
    const b = materialize(topo);
    const ra = await runGig(a.std, {}, { outputs: a.outputs, ledger: a.ledger, invoke });
    const rb = await runGig(b.std, {}, { outputs: b.outputs, ledger: b.ledger, invoke });
    expect(ra.genome_hash).toBe(rb.genome_hash);
    expect(ra.run_fingerprint).toBe(rb.run_fingerprint);
  });
});

// ── INTEGRATION layer: invalid topologies fail closed at compose time ────────────
describe("recursion — INTEGRATION: invalid topologies fail closed", () => {
  it.each(INVALID.map((t) => ({ id: t.name, topo: t })))("$id is rejected by composeStandard", ({ topo }) => {
    expect(() => materialize(topo)).toThrow();
  });
});
