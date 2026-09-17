// RED — a standard loaded through the store keeps its examine loop and its reserve pool.
//
// Slice 2 (contract-amend-round-runs-v1, O5 and F2). The drain loads its genome through the store
// (src/worker.ts: rpcGenomeStore(ctx).load()), and the store's standards envelope selects
// slug, version, status, domain, phases, input_types, output_types and nothing else
// (src/genome_store.ts Q.standards), while reconstructGenome composes only those. So a standard
// authored with max_examine_rounds 3 runs on the drain with no examine loop at all, and its
// reserve_pool is gone: the file genome and the store genome are two different standards.
// (The hosted coltrane_standards table may need these columns; that migration is outside this repo.)
import { describe, it, expect } from "vitest";
import { reconstructGenome, Q } from "../src/genome_store.js";
import { TEST_BEHAVIOR } from "./_support/agents.js";

const agentRow = (slug: string, primitive: string, input_types: string[], output_types: string[]) =>
  ({ ...TEST_BEHAVIOR, slug, version: 1, status: "active", primitives: [primitive], input_types, output_types, domain: "demo" });

const AGENTS = [
  agentRow("planner", "PLAN", [], ["Plan"]),
  agentRow("maker", "CREATE", ["Plan"], ["Artifact"]),
  agentRow("checker", "VERIFY", ["Artifact"], ["Verdict"]),
];

const standardRow = (extra: Record<string, unknown>) => ({
  slug: "loop", version: 1, status: "active", domain: "demo", input_types: [], output_types: [],
  phases: [
    { name: "plan", chairs: [{ role: "plan", agent_slug: "planner", depends_on: [], input_contract: [], output_contract: ["Plan"], required_skills: [] }] },
    { name: "make", chairs: [{ role: "make", agent_slug: "maker", depends_on: ["plan"], input_contract: ["Plan"], output_contract: ["Artifact"], required_skills: [] }] },
    { name: "check", chairs: [{ role: "check", agent_slug: "checker", depends_on: ["make"], input_contract: ["Artifact"], output_contract: ["Verdict"], required_skills: [] }] },
  ],
  ...extra,
});

const load = (standard: Record<string, unknown>) =>
  reconstructGenome({ core_types: [], domain_types: [], skills: [], charts: [], venues: [], agents: AGENTS, standards: [standard] } as never);

describe("the store keeps the examine loop", () => {
  it("O5 — the standards envelope selects max_examine_rounds and reserve_pool", () => {
    const columns = Q.standards.split("select=")[1]!.split(",");
    expect(columns, "the drain never reads the examine loop back from the store").toContain("max_examine_rounds");
    expect(columns, "the drain never reads the reserve pool back from the store").toContain("reserve_pool");
  });

  it("O5 — a store row carrying max_examine_rounds and reserve_pool reconstructs a standard that keeps both", () => {
    const g = load(standardRow({ max_examine_rounds: 3, reserve_pool: 2 }));
    expect(g.load_errors, "fixture: the standard must compose").toEqual([]);
    const s = g.standards.get("loop") as unknown as { max_examine_rounds?: number; reserve_pool?: number };
    expect(s.max_examine_rounds, "the store genome dropped the examine loop: the drain never amends").toBe(3);
    expect(s.reserve_pool, "the store genome dropped the reserve pool").toBe(2);
  });

  it("F2 — a malformed max_examine_rounds is a load error naming the slug and field, never a loop silently disabled", () => {
    const g = load(standardRow({ max_examine_rounds: "three" }));
    expect(g.standards.has("loop"), "a standard whose loop cannot be read was loaded without it").toBe(false);
    const e = g.load_errors.find((x) => x.slug === "loop");
    expect(e?.error ?? "", "the load error must name the field").toContain("max_examine_rounds");
  });

  it("control — a row with neither field reconstructs as today, with no loop and no pool", () => {
    // Green today. A fix that invents a default round count goes red.
    const g = load(standardRow({}));
    expect(g.load_errors).toEqual([]);
    const s = g.standards.get("loop") as unknown as { max_examine_rounds?: number; reserve_pool?: number };
    expect(s.max_examine_rounds).toBeUndefined();
    expect(s.reserve_pool).toBeUndefined();
  });
});
