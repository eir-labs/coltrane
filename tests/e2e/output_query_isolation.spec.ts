// Adversarial follow-up to T7 (output_trace cross-gig leakage, PR #85):
// does output_query ALSO leak across gigs?
//
// T7's pattern: the per-gig view bled into another gig's view when a
// provenance edge crossed the gig boundary. output_trace was vulnerable
// because it WALKS edges. output_query says it only filters rows by gig_id
// (server.ts case "output_query") — so on its face, edges shouldn't
// contaminate. This spec is the adversary: prove that, or break it.
//
// Three counter-claims under test:
//   1. Dispatch gig A and gig B independently. query(gig_id=A) returns
//      ONLY A's outputs — none of B's domain_types, agent_slugs, or ids.
//   2. After we add a derived_from edge FROM a gig-B output TO a gig-A
//      output (cross-gig provenance — exactly the T7 contamination shape),
//      query(gig_id=A) STILL returns only A's outputs. Edges must not
//      change the set output_query returns.
//   3. The reverse direction — derived_from FROM gig-A TO gig-B — also
//      must not cause B's outputs to surface under query(gig_id=A).
//
// If any of these fail, output_query has the same class of bug T7 found
// in output_trace, and we file the follow-up.

import { describe, it, expect } from "vitest";
import { TEST_BEHAVIOR } from "../_support/agents.js";
import {
  dispatchTool,
  createRegistry,
  createOutputStore,
  MemoryLedger,
  type ServerDeps,
  type DomainType,
  type AgentInvoker,
  type Standard,
  type Agent,
} from "../../src/index.js";

// Two minimal 2-phase standards, identical shape so the only thing
// distinguishing the outputs is gig_id + agent_slug. If isolation breaks,
// it'll be obvious which set leaked.
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

const scoutA: Agent = { ...TEST_BEHAVIOR,
  slug: "scout-A",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["page-model"],
  domain: "eirtests",
};
const analystA: Agent = { ...TEST_BEHAVIOR,
  slug: "analyst-A",
  primitives: ["INTERPRET"],
  input_types: ["page-model"],
  output_types: ["finding"],
  domain: "eirtests",
};
const scoutB: Agent = { ...TEST_BEHAVIOR,
  slug: "scout-B",
  primitives: ["SENSE"],
  input_types: [],
  output_types: ["page-model"],
  domain: "eirtests",
};
const analystB: Agent = { ...TEST_BEHAVIOR,
  slug: "analyst-B",
  primitives: ["INTERPRET"],
  input_types: ["page-model"],
  output_types: ["finding"],
  domain: "eirtests",
};

const standardA: Standard = {
  slug: "scan-A",
  domain: "eirtests",
  agents: [scoutA, analystA],
  phases: [
    { name: "sense", chairs: [{ role: "sense", agent_slug: "scout-A", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] },
    { name: "interpret", chairs: [{ role: "interpret", agent_slug: "analyst-A", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] },
  ],
};
const standardB: Standard = {
  slug: "scan-B",
  domain: "eirtests",
  agents: [scoutB, analystB],
  phases: [
    { name: "sense", chairs: [{ role: "sense", agent_slug: "scout-B", depends_on: [], input_contract: [], output_contract: ["page-model"], required_skills: [] }] },
    { name: "interpret", chairs: [{ role: "interpret", agent_slug: "analyst-B", depends_on: [], input_contract: [], output_contract: ["finding"], required_skills: [] }] },
  ],
};

// Each output carries its CORE's substance floor, enforced on every seal (#227 ruling):
// page-model is Signal-cored so it names where it was acquired, finding is Interpretation-cored
// so it states its claims. Both stay derived from the agent slug, so the outputs of gig A and
// gig B remain distinguishable — which is the isolation this spec is actually measuring.
const invoke: AgentInvoker = ({ agent }) =>
  agent.primitives.includes("SENSE")
    ? { url: `/${agent.slug}/landing`, source: `https://eirtests.example/${agent.slug}` }
    : { title: `${agent.slug} found a thing`, claims: [`${agent.slug} found a thing`] };

function wired(): ServerDeps {
  const registry = createRegistry();
  [pageModel, finding].forEach((t) => registry.registerType(t));
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([
      [standardA.slug, standardA],
      [standardB.slug, standardB],
    ]),
    invoke,
    model_version: "claude-opus-4-7",
  };
}

interface OutRow {
  id: string;
  gig_id: string;
  domain_type: string;
  agent_slug: string;
}

async function queryByGig(deps: ServerDeps, gig_id: string): Promise<OutRow[]> {
  const r = await dispatchTool("output_query", { gig_id }, deps);
  return (r.data as { outputs: OutRow[] }).outputs;
}

describe("output_query isolation across gigs (T7 follow-up)", () => {
  it("baseline: query(gig_A) returns only gig_A's rows, never gig_B's", async () => {
    const deps = wired();

    const da = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-A", input: {} },
      deps,
    );
    const db = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-B", input: {} },
      deps,
    );
    const gigA = (da.data as { gig_id: string }).gig_id;
    const gigB = (db.data as { gig_id: string }).gig_id;
    expect(gigA).not.toEqual(gigB);

    const rowsA = await queryByGig(deps, gigA);
    const rowsB = await queryByGig(deps, gigB);

    // each gig produces exactly 2 outputs (sense + interpret)
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);

    // EVERY row returned for gig A is actually tagged gig A
    expect(rowsA.every((r) => r.gig_id === gigA)).toBe(true);
    expect(rowsB.every((r) => r.gig_id === gigB)).toBe(true);

    // and gig A's query contains NONE of gig B's row ids — the disjoint check
    const idsA = new Set(rowsA.map((r) => r.id));
    const idsB = new Set(rowsB.map((r) => r.id));
    for (const id of idsB) expect(idsA.has(id)).toBe(false);

    // gig A's query must not surface any of gig B's agent_slugs
    const slugsInA = new Set(rowsA.map((r) => r.agent_slug));
    expect(slugsInA.has("scout-B")).toBe(false);
    expect(slugsInA.has("analyst-B")).toBe(false);
  });

  it("adversarial: cross-gig derived_from from B→A does NOT contaminate query(gig_A)", async () => {
    const deps = wired();

    const da = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-A", input: {} },
      deps,
    );
    const db = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-B", input: {} },
      deps,
    );
    const gigA = (da.data as { gig_id: string }).gig_id;
    const gigB = (db.data as { gig_id: string }).gig_id;

    const rowsA_before = await queryByGig(deps, gigA);
    const rowsB_before = await queryByGig(deps, gigB);
    const aFinding = rowsA_before.find((r) => r.domain_type === "finding");
    const bFinding = rowsB_before.find((r) => r.domain_type === "finding");
    expect(aFinding, "gig A should have a finding").toBeDefined();
    expect(bFinding, "gig B should have a finding").toBeDefined();

    // The contamination shape T7 exposed: a derived_from edge crossing the
    // gig boundary. We point gig B's interpretation at gig A's interpretation,
    // so if output_query is doing any kind of edge-walk (it shouldn't), B's
    // row will surface in gig A's query result.
    deps.outputs.addRef(bFinding!.id, aFinding!.id, "derived_from", "INTERPRET");

    const rowsA_after = await queryByGig(deps, gigA);

    // still only A's rows
    expect(rowsA_after).toHaveLength(rowsA_before.length);
    expect(rowsA_after.every((r) => r.gig_id === gigA)).toBe(true);
    // explicit check: B's finding id must NOT appear in A's query
    const idsA_after = new Set(rowsA_after.map((r) => r.id));
    expect(idsA_after.has(bFinding!.id)).toBe(false);

    // the scope statement: query(gig_A) is NOT { everything reachable via
    // derived_from from A } — it is exactly { rows whose gig_id === A }
    expect(rowsA_after.map((r) => r.gig_id)).not.toContain(gigB);
  });

  it("adversarial reverse: cross-gig derived_from from A→B does NOT pull B into query(gig_A)", async () => {
    const deps = wired();

    const da = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-A", input: {} },
      deps,
    );
    const db = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-B", input: {} },
      deps,
    );
    const gigA = (da.data as { gig_id: string }).gig_id;
    const gigB = (db.data as { gig_id: string }).gig_id;

    const rowsA = await queryByGig(deps, gigA);
    const rowsB = await queryByGig(deps, gigB);
    const aFinding = rowsA.find((r) => r.domain_type === "finding")!;
    const bSignal = rowsB.find((r) => r.domain_type === "page-model")!;

    // gig-A finding "derived_from" a gig-B signal — the trace direction T7 had
    deps.outputs.addRef(aFinding.id, bSignal.id, "derived_from", "INTERPRET");

    const rowsA_after = await queryByGig(deps, gigA);
    const idsA_after = new Set(rowsA_after.map((r) => r.id));
    // gig-B's row must NOT appear in gig-A's query just because gig-A points at it
    expect(idsA_after.has(bSignal.id)).toBe(false);
    expect(rowsA_after.every((r) => r.gig_id === gigA)).toBe(true);
  });

  it("the dual: query(gig_B) is symmetrically isolated under both edge directions", async () => {
    const deps = wired();

    const da = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-A", input: {} },
      deps,
    );
    const db = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "scan-B", input: {} },
      deps,
    );
    const gigA = (da.data as { gig_id: string }).gig_id;
    const gigB = (db.data as { gig_id: string }).gig_id;
    const rowsA = await queryByGig(deps, gigA);
    const rowsB = await queryByGig(deps, gigB);
    const aFinding = rowsA.find((r) => r.domain_type === "finding")!;
    const bFinding = rowsB.find((r) => r.domain_type === "finding")!;

    deps.outputs.addRef(aFinding.id, bFinding.id, "derived_from", "INTERPRET");
    deps.outputs.addRef(bFinding.id, aFinding.id, "refines", "INTERPRET");

    const rowsB_after = await queryByGig(deps, gigB);
    expect(rowsB_after.every((r) => r.gig_id === gigB)).toBe(true);
    const idsB_after = new Set(rowsB_after.map((r) => r.id));
    expect(idsB_after.has(aFinding.id)).toBe(false);
  });
});
