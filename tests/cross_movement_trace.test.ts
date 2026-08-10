// CROSS-MOVEMENT TRACE — the chart release's named gap.
//
// 0.7.0 made a gig a performance of many standards. Movement gig ids are LINKED, not shared:
// `<gig>.m.<movement_id>`. A downstream movement's records carry `input_refs`/`input_shas` that
// reach INTO the upstream movement's sealed records — the hash chain crosses the boundary and
// always did (tests/chart.test.ts pins it) — but `OutputStore.trace` scoped its walk to ONE
// gig_id, so `output_trace` stopped dead at the boundary. The provenance was intact in the data
// and invisible to the tool: the engine reported a SHORTER CHAIN as if it were the whole chain,
// which is the same defect class as #248.
//
// What this file pins:
//   1. UPSTREAM from a movement-B record reaches movement-A's root signal, and every node says
//      WHERE it lived (`gig_id`, `movement`, `performance_gig_id`, `crossed`). Crossing is
//      visible, never silent.
//   2. DOWNSTREAM from a movement-A record reaches movement-B's record, labeled the same way.
//   3. BOTH crosses in both directions from a middle movement.
//   4. HONESTY AT THE EDGE OF KNOWLEDGE: a sha the chain references and this store does not hold
//      (the upstream movement drained remotely and was never local) becomes an explicit terminal
//      `{ content_sha, missing: true }` — never dropped, never guessed.
//   5. THE FAMILY IS THE BOUND: two unrelated gigs still do not cross. The crossing rule is
//      "same performance", not "anything the store can resolve" — PR #85's isolation stands.
//   6. REGRESSION PIN: a single-standard gig's trace is byte-identical to what it was — the
//      store's own record objects, with no key added.
//
// RED-first: written against an engine whose `trace` scopes to one gig_id, carries no labels,
// drops unresolvable references, and has no `direction`.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeChart, runChart, degenerateChart, movementGigId, type ChartPlan } from "../src/chart.js";
import { composeStandard, type Agent, type Standard, type PhaseDef } from "../src/composition.js";
import { runGig, type AgentInvoker, type RunDeps } from "../src/runtime.js";
import { createRegistry } from "../src/registry.js";
import {
  createOutputStore, performanceRoot, movementOfGigId,
  type OutputStore, type OutputRecord, type TraceNode, type TraceMissingNode,
} from "../src/outputs.js";
import { MemoryLedger, type Ledger } from "../src/ledger.js";
import { createMemoryCheckpointStore, type CheckpointStore } from "../src/reuse.js";
import { dispatchTool, type ServerDeps } from "../src/index.js";
import { testAgent } from "./_support/agents.js";

// ── the fixture genome: three standards in a line ─────────────────────────────────────────────
// Bare core types, so the registry needs no domain registration and each payload owes only its
// core's substance floor (#227/#228).
const SIGNAL = { source: "fixture://cross-movement/look" };
const INTERPRETATION = { claims: [{ claim: "the chain crossed the movement boundary" }] };
const JUDGMENT = { criteria: ["the crossing is legible"] };

const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "trace-demo" });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "trace-demo" });
const judge: Agent = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["Interpretation"], output_types: ["Judgment"], domain: "trace-demo" });

const look = (): Standard => composeStandard({
  slug: "look", domain: "trace-demo", agents: [scout], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});
const digest = (): Standard => composeStandard({
  slug: "digest", domain: "trace-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});
const weigh = (): Standard => composeStandard({
  slug: "weigh", domain: "trace-demo", agents: [judge], input_types: ["Interpretation"], output_types: ["Judgment"],
  phases: [{ name: "p3", chairs: [{ role: "r3", agent_slug: "judge", depends_on: [], input_contract: ["Interpretation"], output_contract: ["Judgment"], required_skills: [] }] }] as PhaseDef[],
});
/** One standard, three chairs in a line — the SINGLE-STANDARD gig the regression pin is taken over. */
const solo = (): Standard => composeStandard({
  slug: "solo", domain: "trace-demo", agents: [scout, reader, judge], output_types: ["Judgment"],
  phases: [
    { name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] },
    { name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: ["r1"], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] },
    { name: "p3", chairs: [{ role: "r3", agent_slug: "judge", depends_on: ["r2"], input_contract: ["Interpretation"], output_contract: ["Judgment"], required_skills: [] }] },
  ] as PhaseDef[],
});

const standards = (): ReadonlyMap<string, Standard> => new Map([
  ["look", look()], ["digest", digest()], ["weigh", weigh()], ["solo", solo()],
]);
const agents = (): ReadonlyMap<string, Agent> => new Map([["scout", scout], ["reader", reader], ["judge", judge]]);

/** sense(look) ──Signal──▶ read(digest) ──Interpretation──▶ weighed(weigh) */
const triptych = (): Record<string, unknown> => ({
  slug: "look-then-digest-then-weigh",
  movements: [
    { movement_id: "sense", standard_slug: "look" },
    { movement_id: "read", standard_slug: "digest" },
    { movement_id: "weighed", standard_slug: "weigh" },
  ],
  edges: [
    { from_movement: "sense", to_movement: "read", output_type: "Signal" },
    { from_movement: "read", to_movement: "weighed", output_type: "Interpretation" },
  ],
});

function plan(chart: Record<string, unknown>): ChartPlan {
  const c = composeChart({ chart: chart as never, standards: standards(), agents: agents() });
  if (!c.ok) throw new Error(`fixture chart did not compose: ${JSON.stringify(c.violations)}`);
  return c;
}

const invoke: AgentInvoker = (ctx) =>
  ctx.agent.slug === "scout" ? { ...SIGNAL } : ctx.agent.slug === "judge" ? { ...JUDGMENT } : { ...INTERPRETATION };

const GIG = "trace-gig-0001";

interface Bench { outputs: OutputStore; ledger: Ledger; checkpoints: CheckpointStore }
const bench = (persistDir?: string): Bench => ({
  outputs: createOutputStore(createRegistry(), persistDir !== undefined ? { persistDir } : undefined),
  ledger: new MemoryLedger(),
  checkpoints: createMemoryCheckpointStore(),
});
const deps = (b: Bench, extra?: Partial<RunDeps>): RunDeps =>
  ({ outputs: b.outputs, ledger: b.ledger, invoke, gig_id: GIG, checkpoints: b.checkpoints, ...extra });

const server = (b: Bench): ServerDeps => ({
  registry: createRegistry(), outputs: b.outputs, ledger: b.ledger,
  standards: new Map(standards()), invoke, model_version: "fixture",
});

/** The three movements' sealed records, keyed by movement_id. */
async function performed(b: Bench): Promise<Record<string, OutputRecord>> {
  const res = await runChart(plan(triptych()), {}, deps(b));
  expect(res.status, "the fixture performance must complete").toBe("complete");
  const out: Record<string, OutputRecord> = {};
  for (const m of res.movements) {
    expect(m.outputs, `movement ${m.movement_id} sealed nothing`).toHaveLength(1);
    out[m.movement_id] = m.outputs[0]!;
  }
  return out;
}

const isMissing = (n: TraceNode): n is TraceMissingNode => n.missing === true;
const records = (nodes: readonly TraceNode[]): Array<Extract<TraceNode, { gig_id: string }>> =>
  nodes.filter((n): n is Extract<TraceNode, { gig_id: string }> => !isMissing(n));
const byId = (nodes: readonly TraceNode[], id: string): TraceNode | undefined => nodes.find((n) => n.id === id);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The id scheme, read back
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the performance family is derived from the chart's own id scheme", () => {
  it("a movement gig id resolves to its performance root and its movement", () => {
    const p = plan(triptych());
    const gid = movementGigId(p, GIG, "read");
    expect(gid).toBe(`${GIG}.m.read`);
    expect(performanceRoot(gid)).toBe(GIG);
    expect(movementOfGigId(gid)).toBe("read");
  });

  it("a plain gig id is its own performance root, and names no movement", () => {
    expect(performanceRoot(GIG)).toBe(GIG);
    expect(movementOfGigId(GIG)).toBeUndefined();
  });

  it("the root gig and its movements are ONE family; a lookalike gig id is not", () => {
    expect(performanceRoot(`${GIG}.m.read`)).toBe(performanceRoot(GIG));
    expect(performanceRoot(`${GIG}.m.read`)).toBe(performanceRoot(`${GIG}.m.sense`));
    expect(performanceRoot(`${GIG}x.m.read`)).not.toBe(performanceRoot(GIG));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1 — upstream crosses, and says where it went
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("OutputStore.trace — upstream walks the whole performance", () => {
  it("reaches movement A's root signal from a movement-B record", async () => {
    const b = bench();
    const rec = await performed(b);

    const nodes = b.outputs.trace(rec["read"]!.id);
    const ids = nodes.map((n) => n.id);
    expect(ids, "the chain crosses into the upstream movement's sealed record").toContain(rec["sense"]!.id);
  });

  it("labels every node with the gig it lived in, its movement, and its performance", async () => {
    const b = bench();
    const rec = await performed(b);

    const crossed = byId(b.outputs.trace(rec["read"]!.id), rec["sense"]!.id);
    expect(crossed).toBeDefined();
    expect(isMissing(crossed!)).toBe(false);
    expect(crossed).toMatchObject({
      gig_id: `${GIG}.m.sense`,
      movement: "sense",
      performance_gig_id: GIG,
      crossed: true,
    });
  });

  it("reaches the FIRST movement from the LAST — two boundaries, one walk", async () => {
    const b = bench();
    const rec = await performed(b);

    const nodes = b.outputs.trace(rec["weighed"]!.id);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain(rec["read"]!.id);
    expect(ids).toContain(rec["sense"]!.id);
    // and each says which movement it came from — an operator reads the arrangement off the trace
    expect(records(nodes).map((n) => n.movement).sort()).toEqual(["read", "sense"]);
  });

  it("max_depth still bounds the walk when the hop crosses a boundary", async () => {
    const b = bench();
    const rec = await performed(b);

    const one = b.outputs.trace(rec["weighed"]!.id, { max_depth: 1 });
    expect(one.map((n) => n.id)).toEqual([rec["read"]!.id]);
    expect(b.outputs.trace(rec["weighed"]!.id, { max_depth: 0 })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2 & 3 — downstream and both cross too
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("OutputStore.trace — downstream and both cross as well", () => {
  it("downstream from movement A reaches movement B and movement C", async () => {
    const b = bench();
    const rec = await performed(b);

    const nodes = b.outputs.trace(rec["sense"]!.id, { direction: "downstream" });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain(rec["read"]!.id);
    expect(ids).toContain(rec["weighed"]!.id);
    expect(ids, "the seed is not its own descendant").not.toContain(rec["sense"]!.id);
    expect(byId(nodes, rec["weighed"]!.id)).toMatchObject({
      gig_id: `${GIG}.m.weighed`, movement: "weighed", performance_gig_id: GIG, crossed: true,
    });
  });

  it("both reaches each end from the middle movement, without repeating a node", async () => {
    const b = bench();
    const rec = await performed(b);

    const nodes = b.outputs.trace(rec["read"]!.id, { direction: "both" });
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain(rec["sense"]!.id);
    expect(ids).toContain(rec["weighed"]!.id);
    expect(new Set(ids).size, "a node reachable both ways appears once").toBe(ids.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4 — honesty at the edge of knowledge
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("OutputStore.trace — a referenced sha this store does not hold is a NAMED hole", () => {
  it("renders an explicit missing terminal instead of silently shortening the chain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coltrane-cross-movement-"));
    try {
      const b = bench(dir);
      const rec = await performed(b);
      const senseId = rec["sense"]!.id;
      const senseSha = rec["sense"]!.content_sha;

      // The upstream movement drained remotely and was never local to THIS reader: its sealed
      // rows are simply not here. Its shas are, though — stamped into the sink's `input_shas`
      // at seal time, which is exactly why the hole can be named rather than guessed at.
      fs.rmSync(path.join(dir, "outputs", `${GIG}.m.sense.jsonl`));

      const sessionB = createOutputStore(createRegistry(), { persistDir: dir });
      const nodes = sessionB.trace(rec["read"]!.id);
      const hole = byId(nodes, senseId);
      expect(hole, "the reference is never dropped — the walk reports what it could not resolve").toBeDefined();
      expect(isMissing(hole!)).toBe(true);
      expect(hole).toMatchObject({
        id: senseId,
        content_sha: senseSha,
        missing: true,
        referenced_by: rec["read"]!.id,
      });
      // and nothing about the absent record is invented
      expect(Object.keys(hole!).sort()).toEqual(["content_sha", "id", "missing", "referenced_by"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("output_trace reports the hole at the tool surface, and does not call it a root signal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coltrane-cross-movement-"));
    try {
      const b = bench(dir);
      const rec = await performed(b);
      fs.rmSync(path.join(dir, "outputs", `${GIG}.m.sense.jsonl`));

      const sessionB = bench(dir);
      const r = await dispatchTool("output_trace", { output_id: rec["read"]!.id }, server(sessionB));
      expect(r.ok).toBe(true);
      const d = r.data as {
        graph: { nodes: TraceNode[] };
        root_signals: Array<{ id: string }>;
        missing: TraceMissingNode[];
      };
      expect(d.missing.map((m) => m.id)).toEqual([rec["sense"]!.id]);
      expect(d.graph.nodes.some((n) => n.id === rec["sense"]!.id), "the hole rides in the graph too").toBe(true);
      expect(
        d.root_signals.map((s) => s.id),
        "an unresolvable reference is not a known root signal — it is an unknown",
      ).not.toContain(rec["sense"]!.id);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5 — the family is the bound (PR #85's isolation, restated against the new rule)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("OutputStore.trace — the crossing rule is the PERFORMANCE, not the whole store", () => {
  it("two unrelated gigs still do not cross, even with a resolvable reference between them", () => {
    const b = bench();
    const a = b.outputs.write({
      core_type: "Signal", domain_type: "", domain: "trace-demo",
      gig_id: "solo-a", agent_slug: "scout", primitive: "SENSE", data: { ...SIGNAL },
    });
    const c = b.outputs.write({
      core_type: "Interpretation", domain_type: "", domain: "trace-demo",
      gig_id: "solo-b", agent_slug: "reader", primitive: "INTERPRET", data: { ...INTERPRETATION },
      input_refs: [a.id],
    });
    b.outputs.addRef(c.id, a.id, "derived_from", "INTERPRET");

    const nodes = b.outputs.trace(c.id);
    expect(nodes.map((n) => n.id), "a resolvable cross-GIG reference is out of family, not a hole").toEqual([]);
    expect(b.outputs.trace(a.id, { direction: "downstream" }).map((n) => n.id)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6 — the regression pin
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("a single-standard gig's trace is what it always was", () => {
  it("returns the store's OWN record objects, with no key added", async () => {
    const b = bench();
    const res = await runGig(solo(), {}, deps(b, { gig_id: "solo-gig-1" }));
    expect(res.status).toBe("complete");
    const last = res.outputs[res.outputs.length - 1]!;

    const nodes = b.outputs.trace(last.id);
    expect(nodes.length).toBe(2);
    for (const n of nodes) {
      const stored = b.outputs.get(n.id)!;
      expect(n, "an unlabelled node is the record itself, not a copy of it").toBe(stored);
      expect(Object.keys(n)).toEqual(Object.keys(stored));
      for (const added of ["movement", "performance_gig_id", "crossed", "missing"]) {
        expect(Object.prototype.hasOwnProperty.call(n, added), `a plain gig's trace gained "${added}"`).toBe(false);
      }
    }
  });

  it("a DEGENERATE chart's movement is a plain gig, so its trace is unlabelled too", async () => {
    const b = bench();
    const p = plan(degenerateChart("solo") as unknown as Record<string, unknown>);
    const res = await runChart(p, {}, deps(b, { gig_id: "solo-gig-2" }));
    expect(res.status).toBe("complete");
    const outs = res.movements[0]!.outputs;
    const nodes = b.outputs.trace(outs[outs.length - 1]!.id);
    expect(nodes.length).toBe(2);
    expect(nodes.every((n) => !isMissing(n) && n.movement === undefined && n.crossed === undefined)).toBe(true);
  });
});
