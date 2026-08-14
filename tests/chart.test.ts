// THE CHART — a gig is a performance of MANY standards.
//
// A gig has always bound one standard. The chart promotes that binding one level: MOVEMENTS name
// standards, typed EDGES carry a source movement's sealed outputs into a sink movement's entry
// chairs, APPROVAL GATES park between movements, and a BUDGET ENVELOPE bounds the whole
// performance. The single-standard gig survives untouched as the degenerate one-movement chart,
// whose `chart_hash` short-circuits byte-for-byte to `genomeHash` of that standard — so an
// existing run's `run_fingerprint` does not move.
//
// The rules fail CLOSED at compose time (never at minute nine): a cycle, an edge naming a type no
// movement seals, an unclassified conditional flow, an entry slot with no provider, a gate key
// that collides with a human chair — each is refused where the chart is authored, with the rule
// named. `composeChart` returns a structured violation list; nothing collapses to a boolean.
//
// RED-first: written against an engine that has no ChartSchema, no composeChart and no runChart.
// Spec: sealed design gig 51fda6b1 (product-design-v1), design-concept `chart-schema-spec-001`.
import { describe, it, expect, vi } from "vitest";
import {
  ChartSchema, ChartEdgeSchema, ChartMovementSchema, ChartSeatingSchema,
  ChartApprovalGateSchema, ChartBudgetEnvelopeSchema,
} from "../src/genome_schema.js";
import {
  composeChart, chartHash, runChart, degenerateChart, isDegenerateChart, dispatchTarget,
  movementGigId, movementCheckpointId, chartCheckpointId,
  type ChartPlan, type ChartViolation,
} from "../src/chart.js";
import { composeStandard, type Agent, type Standard, type PhaseDef } from "../src/composition.js";
import { runGig, genomeHash, type AgentInvoker, type RunDeps } from "../src/runtime.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore, type OutputStore } from "../src/outputs.js";
import { MemoryLedger, type Ledger, type GigLedgerEntry } from "../src/ledger.js";
import {
  createMemoryCheckpointStore, reuseCacheKey, checkpointRoleKey,
  type CheckpointStore, type GigCheckpoint, type ReuseKeyInput,
} from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";

// ── the fixture genome ────────────────────────────────────────────────────────────────────────
// Two standards in a line, one per movement. Bare core types, so the registry needs no domain
// registration and each payload only owes its core's substance floor (#227/#228).
const SIGNAL = { source: "fixture://chart/look" };
const INTERPRETATION = { claims: [{ claim: "the chart carried the signal across the movement boundary" }] };
const JUDGMENT = { criteria: ["the arrangement is approved to proceed"] };

const scout: Agent = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "chart-demo" });
const reader: Agent = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "chart-demo" });
const maybe: Agent = testAgent({ slug: "maybe", primitives: ["SENSE", "JUDGE"], output_types: ["Signal", "Judgment"], domain: "chart-demo" });
const judge: Agent = testAgent({ slug: "judge", primitives: ["JUDGE"], input_types: ["Interpretation"], output_types: ["Judgment"], domain: "chart-demo" });

/** Movement A's standard: seals a Signal from the dispatch payload. */
const look = (): Standard => composeStandard({
  slug: "look", domain: "chart-demo", agents: [scout], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});

/** Movement B's standard: its ENTRY chair consumes a Signal from outside the standard. */
const digest = (): Standard => composeStandard({
  slug: "digest", domain: "chart-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});

/** Movement B, TWO chairs deep — so a failure in its second chair leaves a movement checkpoint. */
const digestDeep = (): Standard => composeStandard({
  slug: "digest-deep", domain: "chart-demo", agents: [reader, judge], input_types: ["Signal"], output_types: ["Judgment"],
  phases: [
    { name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] },
    { name: "p3", chairs: [{ role: "r3", agent_slug: "judge", depends_on: ["r2"], input_contract: ["Interpretation"], output_contract: ["Judgment"], required_skills: [] }] },
  ] as PhaseDef[],
});

/** Two standards that each name a chair `reviewer` — the collision the composite key must survive. */
const lookRev = (): Standard => composeStandard({
  slug: "look-rev", domain: "chart-demo", agents: [scout], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "reviewer", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});
const digestRev = (): Standard => composeStandard({
  slug: "digest-rev", domain: "chart-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "reviewer", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});

/** A standard whose terminal chair seals `Judgment` ONLY as an optional output. */
const lookMaybe = (): Standard => composeStandard({
  slug: "look-maybe", domain: "chart-demo", agents: [maybe], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "maybe", depends_on: [], input_contract: [], output_contract: ["Signal", "Judgment"], optional_outputs: ["Judgment"], required_skills: [] }] }] as PhaseDef[],
});

/** A standard carrying a HUMAN chair — the within-movement approval office R8 must not collide with. */
const lookApprove = (): Standard => composeStandard({
  slug: "look-approve", domain: "chart-demo", agents: [scout], output_types: ["Signal"],
  phases: [
    { name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] },
    { name: "p2", chairs: [{ role: "governor", human: true, agent_slug: "", depends_on: ["r1"], input_contract: [], output_contract: ["Judgment"], required_skills: [] }] },
  ] as PhaseDef[],
});

const standards = (): ReadonlyMap<string, Standard> => new Map([
  ["look", look()], ["digest", digest()], ["digest-deep", digestDeep()],
  ["look-maybe", lookMaybe()], ["look-approve", lookApprove()],
  ["look-rev", lookRev()], ["digest-rev", digestRev()],
]);
const agents = (): ReadonlyMap<string, Agent> => new Map([["scout", scout], ["reader", reader], ["maybe", maybe], ["judge", judge]]);

/** The two-movement chart the runtime tests drive: look ──Signal──▶ digest. */
const lineChart = (over?: Record<string, unknown>) => ({
  slug: "look-then-digest",
  movements: [
    { movement_id: "sense", standard_slug: "look" },
    { movement_id: "read", standard_slug: "digest" },
  ],
  edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
  ...over,
});

const compose = (chart: Record<string, unknown>, payload_types?: readonly string[]): ReturnType<typeof composeChart> =>
  composeChart({ chart: chart as never, standards: standards(), agents: agents(), ...(payload_types ? { payload_types } : {}) });

/** A composition that MUST have succeeded — the plan a run needs. */
function plan(chart: Record<string, unknown>, payload_types?: readonly string[]): ChartPlan {
  const c = compose(chart, payload_types);
  if (!c.ok) throw new Error(`fixture chart did not compose: ${JSON.stringify(c.violations)}`);
  return c;
}

const rules = (v: readonly ChartViolation[]): string[] => [...new Set(v.map((x) => x.rule))];

// ── run bench ─────────────────────────────────────────────────────────────────────────────────
interface Bench { outputs: OutputStore; ledger: Ledger; checkpoints: CheckpointStore }
const bench = (): Bench => ({
  outputs: createOutputStore(createRegistry()),
  ledger: new MemoryLedger(),
  checkpoints: createMemoryCheckpointStore(),
});

/** Counts invocations per agent slug; optionally fails one agent N times; optionally reports spend. */
function counting(opts?: { failOn?: { agent: string; times: number }; usd?: Record<string, number> }): {
  invoke: AgentInvoker; calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  let failsLeft = opts?.failOn?.times ?? 0;
  const invoke: AgentInvoker = (ctx) => {
    calls[ctx.agent.slug] = (calls[ctx.agent.slug] ?? 0) + 1;
    const usd = opts?.usd?.[ctx.agent.slug];
    if (usd !== undefined) {
      ctx.onEvent?.({ type: "result", raw: { type: "result", total_cost_usd: usd, usage: { input_tokens: 10, output_tokens: 2 } } });
    }
    if (opts?.failOn && ctx.agent.slug === opts.failOn.agent && failsLeft > 0) {
      failsLeft--;
      throw new Error(`stub failure in ${ctx.agent.slug}`);
    }
    switch (ctx.agent.slug) {
      case "scout": return { ...SIGNAL };
      case "maybe": return { ...SIGNAL };
      case "judge": return { ...JUDGMENT };
      default: return { ...INTERPRETATION };
    }
  };
  return { invoke, calls };
}

const GIG = "chart-gig-0001";
const deps = (b: Bench, invoke: AgentInvoker, extra?: Partial<RunDeps>): RunDeps =>
  ({ outputs: b.outputs, ledger: b.ledger, invoke, gig_id: GIG, checkpoints: b.checkpoints, ...extra });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R0 — the schema gate
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("ChartSchema — the parse gate (R0)", () => {
  it("accepts a minimal two-movement chart with one hard edge, and applies the defaults", () => {
    const c = ChartSchema.parse(lineChart());
    expect(c.movements).toHaveLength(2);
    expect(c.movements[0]!.runtime_fills, "an unstated hydration map is empty, not absent").toEqual({});
    expect(c.movements[0]!.seatings).toEqual([]);
    expect(c.edges[0]!.optional, "an edge is a HARD edge unless it says otherwise").toBe(false);
    expect(c.approval_gates).toEqual([]);
    expect(c.budget_envelope).toBeUndefined();
  });

  it("rejects a chart with no movements — a performance of nothing is not a chart", () => {
    expect(() => ChartSchema.parse({ slug: "empty", movements: [] })).toThrow();
  });

  it("every sub-schema is strict — an unknown key is a typo, not an extension point", () => {
    expect(() => ChartSchema.parse({ ...lineChart(), venu: "fly-iad" })).toThrow();
    expect(() => ChartEdgeSchema.parse({ from_movement: "a", to_movement: "b", output_type: "Signal", optionall: true })).toThrow();
    expect(() => ChartMovementSchema.parse({ movement_id: "a", standard_slug: "look", runtime_fill: {} })).toThrow();
    expect(() => ChartSeatingSchema.parse({ chair: "r1", agent_slug: "scout", evidence: [] })).toThrow();
    expect(() => ChartApprovalGateSchema.parse({ gate_id: "g", after_movement: "a", before_movement: "b", chair: "c", promptt: "x" })).toThrow();
    expect(() => ChartBudgetEnvelopeSchema.parse({ total_usd: 1, currency: "usd" })).toThrow();
  });

  it("carries the fields the arrangement needs: seatings, gates, envelope, venue", () => {
    const c = ChartSchema.parse({
      ...lineChart(),
      movements: [
        { movement_id: "sense", standard_slug: "look", runtime_fills: { "Signal": { source: "x" } },
          seatings: [{ chair: "r1", agent_slug: "scout", technique_evidence: [{ source: "gig://prior", claim: "sealed 12 signals" }] }] },
        { movement_id: "read", standard_slug: "digest" },
      ],
      approval_gates: [{ gate_id: "go-ahead", after_movement: "sense", before_movement: "read", chair: "producer", prompt: "ship it?" }],
      budget_envelope: { total_usd: 2.5 },
      venue: "opaque-binding",
    });
    expect(c.movements[0]!.seatings[0]!.agent_slug).toBe("scout");
    expect(c.approval_gates[0]!.gate_id).toBe("go-ahead");
    expect(c.budget_envelope?.total_usd).toBe(2.5);
    expect(c.venue).toBe("opaque-binding");
  });

  it("a malformed chart never reaches the relational rules — composeChart reports R0", () => {
    const c = compose({ slug: "bad", movements: [{ movement_id: "m", standard_slug: "look", nope: 1 }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R0"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R1..R9 — one minimal violating input per rule, in firing order
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("composeChart — the rules fire in order, and each names itself", () => {
  it("R1 — a duplicate movement_id is refused before anything keys on it", () => {
    const c = compose({ slug: "dup", movements: [
      { movement_id: "m", standard_slug: "look" },
      { movement_id: "m", standard_slug: "digest" },
    ] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R1"]);
    expect(c.violations[0]!.detail).toMatch(/duplicate movement_id/i);
    expect(c.violations[0]!.movement_id).toBe("m");
  });

  it("R1 — a movement_id that cannot name a checkpoint is refused (it would silently break resume)", () => {
    // The checkpoint store guards its paths (`/^[A-Za-z0-9._-]+$/`); an id outside that charset
    // reads back as "no checkpoint" rather than as an error, which would make resume silently
    // impossible. Caught where the author can see it.
    const c = compose({ slug: "slashy", movements: [{ movement_id: "a/b", standard_slug: "look" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R1"]);
  });

  it("R2 — a movement naming a standard the genome cannot resolve", () => {
    const c = compose({ slug: "ghost-std", movements: [{ movement_id: "m", standard_slug: "no-such-standard" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R2"]);
    expect(c.violations[0]!.detail).toMatch(/unknown standard "no-such-standard"/);
    expect(c.violations[0]!.movement_id).toBe("m");
  });

  it("R3 — a seating naming a chair the movement's standard does not declare (dead seat)", () => {
    const c = compose({ slug: "dead-seat", movements: [
      { movement_id: "m", standard_slug: "look", seatings: [{ chair: "not-a-chair", agent_slug: "scout" }] },
    ] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R3"]);
    expect(c.violations[0]!.detail).toMatch(/chair "not-a-chair"/);
  });

  it("R3 — a seating naming an agent the genome does not hold (same defect class as a dead tool grant)", () => {
    const c = compose({ slug: "ghost-agent", movements: [
      { movement_id: "m", standard_slug: "look", seatings: [{ chair: "r1", agent_slug: "nobody" }] },
    ] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R3"]);
    expect(c.violations[0]!.detail).toMatch(/agent "nobody"/);
  });

  it("R4 — an edge endpoint that is not a movement in this chart", () => {
    const c = compose({ ...lineChart(), edges: [{ from_movement: "sense", to_movement: "elsewhere", output_type: "Signal" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R4"]);
    expect(c.violations[0]!.detail).toMatch(/unknown movement/i);
  });

  it("R4 — a GATE endpoint that is not a movement (R5's graph cannot be built over unknown nodes)", () => {
    const c = compose({ ...lineChart(), approval_gates: [{ gate_id: "g", after_movement: "sense", before_movement: "nowhere", chair: "producer" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R4"]);
  });

  it("R5 — a cyclic movement graph is refused, with the cycle path", () => {
    const c = compose({ ...lineChart(), edges: [
      { from_movement: "sense", to_movement: "read", output_type: "Signal" },
      { from_movement: "read", to_movement: "sense", output_type: "Interpretation" },
    ] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations), "R5 fires before R6 could complain about the same edges").toEqual(["R5"]);
    expect(c.violations[0]!.detail).toMatch(/cyclic/i);
    expect(c.violations[0]!.detail, "the path, not just the verdict").toMatch(/sense/);
  });

  it("R5 — an approval gate that orders two movements against their dataflow is a cycle too", () => {
    const c = compose({ ...lineChart(), approval_gates: [{ gate_id: "g", after_movement: "read", before_movement: "sense", chair: "producer" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R5"]);
  });

  it("R6 — an edge naming a type the source movement never seals is a DEAD NAME, at compose", () => {
    const c = compose({ ...lineChart(), edges: [{ from_movement: "sense", to_movement: "read", output_type: "Plan" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R6"]);
    expect(c.violations[0]!.detail).toMatch(/dead name/i);
    expect(c.violations[0]!.detail).toMatch(/Plan/);
    expect(c.violations[0]!.edge).toMatchObject({ from_movement: "sense", to_movement: "read", output_type: "Plan" });
  });

  it("R6 — a type sealed only through a terminal chair's optional_outputs must declare optional:true", () => {
    const conditional = {
      slug: "maybe-chart",
      movements: [{ movement_id: "sense", standard_slug: "look-maybe" }, { movement_id: "rule", standard_slug: "look" }],
      edges: [{ from_movement: "sense", to_movement: "rule", output_type: "Judgment" }],
    };
    const refused = compose(conditional);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(rules(refused.violations)).toEqual(["R6"]);
      expect(refused.violations[0]!.detail).toMatch(/optional:true/);
    }
    // The SAME edge, classified: a conditional edge composes.
    const accepted = compose({ ...conditional, edges: [{ from_movement: "sense", to_movement: "rule", output_type: "Judgment", optional: true }] });
    expect(accepted.ok, JSON.stringify(accepted.ok ? [] : accepted.violations)).toBe(true);
    if (accepted.ok) expect(accepted.edges_classified).toEqual([{ from_movement: "sense", to_movement: "rule", output_type: "Judgment", kind: "conditional" }]);
  });

  it("R6 — a REQUIRED sealed type composes as a hard edge whatever `optional` says", () => {
    const c = compose({ ...lineChart(), edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal", optional: true }] });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.edges_classified[0]!.kind).toBe("hard");
  });

  it("R7 — an entry slot with no provider is a DEAD SLOT (no edge, no runtime_fill, no payload)", () => {
    const c = compose({ slug: "orphan", movements: [{ movement_id: "read", standard_slug: "digest" }] });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R7"]);
    expect(c.violations[0]!.detail).toMatch(/dead slot/i);
    expect(c.violations[0]!.detail).toMatch(/Signal/);
    expect(c.violations[0]!.movement_id).toBe("read");
  });

  it("R7 — satisfied by a runtime_fill, by the chart payload, or by a hard edge", () => {
    expect(compose({ slug: "filled", movements: [{ movement_id: "read", standard_slug: "digest", runtime_fills: { Signal: { source: "x" } } }] }).ok).toBe(true);
    expect(compose({ slug: "paid-in", movements: [{ movement_id: "read", standard_slug: "digest" }] }, ["Signal"]).ok).toBe(true);
    expect(compose(lineChart()).ok).toBe(true);
  });

  it("R7 — a CONDITIONAL edge does not satisfy a required entry slot", () => {
    // The whole point of the classification: an optional flow may carry nothing, so it cannot be
    // the sole provider of something the sink requires. It fails closed at compose, not at run.
    const c = compose({
      slug: "conditional-only",
      movements: [{ movement_id: "sense", standard_slug: "look-maybe" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal", optional: true },
        { from_movement: "sense", to_movement: "read", output_type: "Judgment", optional: true }],
    });
    // `Signal` is REQUIRED-sealed by look-maybe, so that edge is hard and the slot IS satisfied.
    expect(c.ok).toBe(true);
    // Now the only Signal-bearing edge is genuinely conditional → the slot has no provider.
    const only = compose({
      slug: "conditional-really",
      movements: [{ movement_id: "sense", standard_slug: "look-maybe" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "sense", to_movement: "read", output_type: "Judgment", optional: true }],
    });
    expect(only.ok).toBe(false);
    if (!only.ok) expect(rules(only.violations)).toEqual(["R7"]);
  });

  it("R8 — a gate_id may not collide with a within-movement human chair role", () => {
    const c = compose({
      slug: "gate-collision",
      movements: [{ movement_id: "sense", standard_slug: "look-approve" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
      approval_gates: [{ gate_id: "governor", after_movement: "sense", before_movement: "read", chair: "producer" }],
    });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R8"]);
    expect(c.violations[0]!.detail).toMatch(/collides with a human chair role/);
    expect(c.violations[0]!.gate_id).toBe("governor");
  });

  it("R8 — a duplicate gate_id, and a gate that gates itself", () => {
    const dup = compose({ ...lineChart(), approval_gates: [
      { gate_id: "g", after_movement: "sense", before_movement: "read", chair: "producer" },
      { gate_id: "g", after_movement: "sense", before_movement: "read", chair: "producer" },
    ] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(rules(dup.violations)).toEqual(["R8"]);

    const self = compose({ ...lineChart(), approval_gates: [{ gate_id: "g", after_movement: "read", before_movement: "read", chair: "producer" }] });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(rules(self.violations)).toEqual(["R8"]);
  });

  it("R9 — a budget envelope that is not a finite positive number is refused on the compose path", () => {
    // `z.number().positive()` (R0) accepts Infinity: it is a number and it is > 0. An unbounded
    // envelope is not a bound, so the compose path restates the rule where it can bite.
    const c = compose({ ...lineChart(), budget_envelope: { total_usd: Number.POSITIVE_INFINITY } });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(rules(c.violations)).toEqual(["R9"]);
    expect(compose({ ...lineChart(), budget_envelope: { total_usd: 0.5 } }).ok).toBe(true);
  });

  it("returns a STRUCTURED composition — never a bare boolean", () => {
    const bad = compose({ slug: "x", movements: [{ movement_id: "m", standard_slug: "nope" }] });
    expect(bad).toHaveProperty("violations");
    if (!bad.ok) expect(bad.violations[0]).toMatchObject({ rule: expect.any(String), detail: expect.any(String) });
    const good = plan(lineChart());
    expect(good.order, "the topological order the run walks").toEqual(["sense", "read"]);
    expect(good.chart_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(good.movements.map((m) => m.standard.slug)).toEqual(["look", "digest"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// chart_hash — the arrangement's identity, folded into run_fingerprint
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("chart_hash", () => {
  it("a one-movement, no-edge, no-gate chart hashes BYTE-IDENTICALLY to genomeHash(standard)", () => {
    const p = plan(degenerateChart("look") as unknown as Record<string, unknown>);
    expect(p.chart_hash).toBe(genomeHash(look()));
  });

  it("is deterministic and INDEPENDENT of declaration order", () => {
    const a = plan(lineChart());
    const b = plan({ ...lineChart(), movements: [
      { movement_id: "read", standard_slug: "digest" }, { movement_id: "sense", standard_slug: "look" },
    ] });
    expect(b.chart_hash).toBe(a.chart_hash);
  });

  it("moves when the arrangement moves — a movement id, an edge, an edge's classification", () => {
    const base = plan(lineChart()).chart_hash;
    const renamed = plan({ ...lineChart(),
      movements: [{ movement_id: "look-first", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "look-first", to_movement: "read", output_type: "Signal" }] }).chart_hash;
    expect(renamed).not.toBe(base);
    const optional = plan({ ...lineChart(), edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal", optional: true }] }).chart_hash;
    expect(optional).not.toBe(base);
  });

  it("two movements naming the SAME standard are distinguishable (edge case C)", () => {
    const twice = plan({ slug: "twice", movements: [
      { movement_id: "first", standard_slug: "look" }, { movement_id: "second", standard_slug: "look" },
    ] });
    expect(twice.chart_hash).not.toBe(genomeHash(look()));
    expect(movementCheckpointId(twice, GIG, "first")).not.toBe(movementCheckpointId(twice, GIG, "second"));
    expect(movementGigId(twice, GIG, "first")).not.toBe(movementGigId(twice, GIG, "second"));
  });

  it("chartHash is callable on the plan alone (the hash is a fact about the arrangement)", () => {
    const p = plan(lineChart());
    expect(chartHash(p)).toBe(p.chart_hash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The degenerate chart IS today's single-standard gig
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("back-compat — the one-movement chart is the single-standard gig", () => {
  it("desugars a bare standard_slug into a one-movement, no-edge, no-gate chart", () => {
    const c = ChartSchema.parse(degenerateChart("look", { seed: 1 }));
    expect(c.slug).toBe("look");
    expect(c.movements).toEqual([{ movement_id: "look", standard_slug: "look", runtime_fills: { seed: 1 }, seatings: [] }]);
    expect(c.edges).toEqual([]);
    expect(c.approval_gates).toEqual([]);
    expect(isDegenerateChart(c)).toBe(true);
    expect(isDegenerateChart(ChartSchema.parse(lineChart()))).toBe(false);
  });

  it("produces a run_fingerprint BYTE-IDENTICAL to a direct single-standard dispatch", async () => {
    const direct = await runGig(look(), {}, deps(bench(), counting().invoke, { gig_id: "direct-1" }));

    const b = bench();
    const c = counting();
    const res = await runChart(plan(degenerateChart("look") as unknown as Record<string, unknown>), {}, deps(b, c.invoke, { gig_id: "direct-2" }));

    expect(res.status).toBe("complete");
    expect(res.movements[0]!.result?.run_fingerprint).toBe(direct.run_fingerprint);
    expect(res.chart_hash).toBe(direct.genome_hash);
    expect(c.calls).toEqual({ scout: 1 });
  });

  it("keeps standard_slug populated on the ledger row, and adds the chart identity beside it", async () => {
    const b = bench();
    await runChart(plan(degenerateChart("look") as unknown as Record<string, unknown>), {}, deps(b, counting().invoke));
    const rows = b.ledger.query({ kind: "gig" }) as GigLedgerEntry[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entry_id: GIG, gig_id: GIG,
      standard_slug: "look", chart_slug: "look", movement_id: "look",
    });
  });

  it("dispatchTarget refines to EXACTLY ONE of standard_slug / chart_slug", () => {
    expect(dispatchTarget({ standard_slug: "look" })).toEqual({ ok: true, kind: "standard", slug: "look" });
    expect(dispatchTarget({ chart_slug: "look-then-digest" })).toEqual({ ok: true, kind: "chart", slug: "look-then-digest" });
    const both = dispatchTarget({ standard_slug: "look", chart_slug: "look-then-digest" });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toMatch(/exactly one/i);
    const neither = dispatchTarget({});
    expect(neither.ok).toBe(false);
    if (!neither.ok) expect(neither.error).toMatch(/exactly one/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Two movements, one performance — the edge carries SEALED OUTPUTS, and provenance reaches back
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("runChart — a typed edge carries movement A's sealed output into movement B's entry chair", () => {
  it("runs both movements and stamps B's provenance with A's content_sha", async () => {
    const b = bench();
    const c = counting();
    const res = await runChart(plan(lineChart()), {}, deps(b, c.invoke));

    expect(res.status).toBe("complete");
    expect(c.calls).toEqual({ scout: 1, reader: 1 });
    expect(res.movements.map((m) => m.movement_id)).toEqual(["sense", "read"]);

    const sensed = res.movements[0]!.result!.outputs;
    const read = res.movements[1]!.result!.outputs;
    expect(sensed).toHaveLength(1);
    expect(read).toHaveLength(1);

    // THE CLAIM: B's output was derived from A's, and says so in the chain the engine stamps.
    expect(read[0]!.input_shas, "the edge is a provenance edge, not a copy").toContain(sensed[0]!.content_sha);
    expect(read[0]!.input_refs).toContain(sensed[0]!.id);
    expect(b.outputs.get(read[0]!.input_refs[0]!)?.gig_id, "the predecessor resolves — across the movement boundary").toBe(sensed[0]!.gig_id);

    // and the sink actually SAW the record (not a payload copy of it)
    expect(res.movements[1]!.result!.seeded_from?.map((s) => s.content_sha)).toEqual([sensed[0]!.content_sha]);
  });

  it("does NOT fold A's outputs into B's own manifest — each movement's row describes its own work", async () => {
    const b = bench();
    const res = await runChart(plan(lineChart()), {}, deps(b, counting().invoke));
    const rows = b.ledger.query({ kind: "gig" }) as GigLedgerEntry[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.standard_slug, r.movement_id, r.chart_slug])).toEqual([
      ["look", "sense", "look-then-digest"], ["digest", "read", "look-then-digest"],
    ]);
    expect(rows.map((r) => r.output_hashes.length), "one sealed output per movement").toEqual([1, 1]);
    expect(new Set(rows.map((r) => r.entry_id)).size, "two movements are two rows, not one row twice").toBe(2);
  });

  it("folds chart_hash into run_fingerprint — the same work under a different arrangement is a different run", async () => {
    const runOnce = async (chart: Record<string, unknown>): Promise<string> => {
      const b = bench();
      const res = await runChart(plan(chart), {}, deps(b, counting().invoke));
      return res.movements[1]!.result!.run_fingerprint;
    };
    const a = await runOnce(lineChart());
    const renamed = await runOnce({ ...lineChart(),
      movements: [{ movement_id: "sense2", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest" }],
      edges: [{ from_movement: "sense2", to_movement: "read", output_type: "Signal" }] });
    expect(renamed, "the outputs are byte-identical; only the arrangement moved").not.toBe(a);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Checkpoints and resume ACROSS a movement boundary
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("runChart — resume spans movements", () => {
  it("a failure in movement B does not re-invoke movement A's chairs on resume", async () => {
    const b = bench();
    const first = counting({ failOn: { agent: "reader", times: 1 } });
    await expect(runChart(plan(lineChart()), {}, deps(b, first.invoke))).rejects.toThrow();
    expect(first.calls).toEqual({ scout: 1, reader: 1 });

    const second = counting();
    const res = await runChart(plan(lineChart()), {}, deps(b, second.invoke, { resume_from: GIG }));
    expect(res.status).toBe("complete");
    expect(second.calls, "movement A was sealed already — re-running it is the whole bug").toEqual({ reader: 1 });
    expect(res.resumed?.movements).toEqual(["sense"]);

    // The restored movement's sealed output is still the edge's carrier: B's provenance reaches it.
    const read = res.movements[1]!.result!.outputs[0]!;
    const sensed = b.outputs.all().find((o) => o.domain_type === "Signal")!;
    expect(read.input_shas).toContain(sensed.content_sha);
  });

  it("records each movement's completion in a chart checkpoint, and clears it when the chart completes", async () => {
    const b = bench();
    const failing = counting({ failOn: { agent: "reader", times: 1 } });
    await expect(runChart(plan(lineChart()), {}, deps(b, failing.invoke))).rejects.toThrow();

    const cp = b.checkpoints.read(chartCheckpointId(GIG)) as GigCheckpoint;
    expect(cp, "a chart that died mid-performance must be resumable").toBeTruthy();
    expect(cp.roles.map((r) => [r.role, r.movement_id])).toEqual([["sense", "sense"]]);
    expect(cp.identity.genome_hash, "the chart's identity is its chart_hash").toBe(plan(lineChart()).chart_hash);

    const res = await runChart(plan(lineChart()), {}, deps(b, counting().invoke, { resume_from: GIG }));
    expect(res.status).toBe("complete");
    expect(b.checkpoints.read(chartCheckpointId(GIG)), "a finished performance has nothing to resume").toBeUndefined();
  });

  it("refuses a resume into a MOVED arrangement rather than splicing two charts", async () => {
    const b = bench();
    await expect(runChart(plan(lineChart()), {}, deps(b, counting({ failOn: { agent: "reader", times: 1 } }).invoke))).rejects.toThrow();
    // Same movements, different arrangement: an extra gate moves chart_hash.
    const moved = plan({ ...lineChart(), approval_gates: [{ gate_id: "g", after_movement: "sense", before_movement: "read", chair: "producer" }] });
    await expect(runChart(moved, {}, deps(b, counting().invoke, { resume_from: GIG, approvals: { g: JUDGMENT } })))
      .rejects.toThrow(/ResumeRefused/);
  });

  it("two movements each declaring a 'reviewer' chair cannot collide on resume", () => {
    // The composite key is (chart_slug, movement_id, role). Same role name, two movements, two keys.
    expect(checkpointRoleKey("chart", "m1", "reviewer")).not.toBe(checkpointRoleKey("chart", "m2", "reviewer"));
    expect(checkpointRoleKey("chart", "m1", "reviewer")).toBe(checkpointRoleKey("chart", "m1", "reviewer"));
    // And a legacy row with no movement_id reads as (standard_slug, role) — see the migration note.
    expect(checkpointRoleKey("look", undefined, "r1")).toBe(checkpointRoleKey("look", "look", "r1"));
  });

  it("…and does not collide in a REAL two-movement run (the spec's own falsifier)", async () => {
    // Both standards declare a chair literally named `reviewer`. If the two shared a checkpoint
    // namespace, the resume below would restore movement A's Signal into movement B's `reviewer`
    // seat, skip its chair, and the performance would "complete" having sealed no Interpretation.
    const chart = {
      slug: "reviewers",
      movements: [{ movement_id: "first", standard_slug: "look-rev" }, { movement_id: "second", standard_slug: "digest-rev" }],
      edges: [{ from_movement: "first", to_movement: "second", output_type: "Signal" }],
    };
    const b = bench();
    await expect(runChart(plan(chart), {}, deps(b, counting({ failOn: { agent: "reader", times: 1 } }).invoke))).rejects.toThrow();

    const second = counting();
    const res = await runChart(plan(chart), {}, deps(b, second.invoke, { resume_from: GIG }));
    expect(res.status).toBe("complete");
    expect(second.calls, "the second movement's `reviewer` is a different seat from the first's").toEqual({ reader: 1 });
    expect(res.movements[1]!.result!.outputs.map((o) => o.domain_type)).toEqual(["Interpretation"]);
  });

  it("refuses a resume of a performance nothing was ever recorded for", async () => {
    const b = bench();
    await expect(runChart(plan(lineChart()), {}, deps(b, counting().invoke, { resume_from: GIG })))
      .rejects.toThrow(/ResumeRefused/);
  });

  it("stamps movement_id on each CheckpointRole a movement writes", async () => {
    // Read INSIDE an unfinished movement: a movement that COMPLETES drops its own checkpoint (there
    // is nothing left in it to resume — the chart checkpoint is what records its completion), so the
    // movement-scoped rows are only observable while that movement is still mid-performance.
    const chart = { ...lineChart(), movements: [
      { movement_id: "sense", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest-deep" },
    ] };
    const b = bench();
    await expect(runChart(plan(chart), {}, deps(b, counting({ failOn: { agent: "judge", times: 1 } }).invoke))).rejects.toThrow();

    const p = plan(chart);
    const movementCp = b.checkpoints.read(movementCheckpointId(p, GIG, "read")) as GigCheckpoint;
    expect(movementCp, "the movement that died mid-way banked the chair that succeeded").toBeTruthy();
    expect(movementCp.roles.map((r) => [r.role, r.movement_id])).toEqual([["r2", "read"]]);
  });

  it("keys the reuse cache on movement_id, so one standard twice does not share entries (edge case C)", () => {
    const base: ReuseKeyInput = {
      standard_slug: "look", phase: "p1", chair: { role: "r1" }, agent: { slug: "scout" }, skills: [],
      input_shas: ["a"], gig_input_sha: "g", model_version: "m", depth: "", output_types: ["Signal"],
      canonical_form_version: "1.1",
    };
    const first = reuseCacheKey({ ...base, chart_slug: "twice", movement_id: "first" });
    const second = reuseCacheKey({ ...base, chart_slug: "twice", movement_id: "second" });
    expect(first).not.toBe(second);
    // A run with no chart context keys EXACTLY as it did before charts existed.
    expect(reuseCacheKey(base)).toBe(reuseCacheKey({ ...base, chart_slug: undefined, movement_id: undefined }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Approval gates at the arrangement level
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("runChart — a gate between movements parks the performance", () => {
  const gated = () => ({ ...lineChart(), approval_gates: [{ gate_id: "proceed", after_movement: "sense", before_movement: "read", chair: "producer", prompt: "carry on?" }] });

  it("parks BEFORE spawning the gated movement — nothing hollow sealed, no model spent", async () => {
    const b = bench();
    const c = counting();
    const res = await runChart(plan(gated()), {}, deps(b, c.invoke));

    expect(res.status).toBe("awaiting_approval");
    expect(res.awaiting).toEqual({ gate_id: "proceed", movement_id: "read", chair: "producer" });
    expect(c.calls, "movement A played; the gated movement did not").toEqual({ scout: 1 });
    expect(res.movements.map((m) => m.status)).toEqual(["complete", "awaiting_approval"]);
  });

  it("drains an awaiting_approval header, exactly as an in-standard human chair does", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 201 }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    process.env["COLTRANE_DRAIN_URL"] = "https://drain.example";
    process.env["COLTRANE_DRAIN_KEY"] = "cdk_test";
    process.env["COLTRANE_STORE_ANON"] = "anon_test";
    try {
      await runChart(plan(gated()), {}, deps(bench(), counting().invoke));
      const bodies = fetchMock.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ""));
      expect(bodies.some((body) => body.includes("awaiting_approval")), "the queue row must say a person is the blocker").toBe(true);
    } finally {
      delete process.env["COLTRANE_DRAIN_URL"];
      delete process.env["COLTRANE_DRAIN_KEY"];
      delete process.env["COLTRANE_STORE_ANON"];
      vi.unstubAllGlobals();
    }
  });

  it("a movement that parks at its OWN human chair parks the performance — and says it was a chair, not a gate", async () => {
    // The chart has no more right to run past a person than the standard does. And the reply names
    // the office it is waiting on: a within-movement chair is answered by approvals[role], an
    // arrangement gate by approvals[gate_id], so calling one the other would misdirect the approver.
    const chart = { slug: "human-first", movements: [
      { movement_id: "sense", standard_slug: "look-approve" }, { movement_id: "read", standard_slug: "digest" },
    ], edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }] };
    const b = bench();
    const first = counting();
    const parked = await runChart(plan(chart), {}, deps(b, first.invoke));
    expect(parked.status).toBe("awaiting_approval");
    expect(parked.awaiting).toEqual({ movement_id: "sense", chair: "governor", phase: "p2" });
    expect(parked.awaiting).not.toHaveProperty("gate_id");
    expect(first.calls).toEqual({ scout: 1 });

    const second = counting();
    const res = await runChart(plan(chart), {}, deps(b, second.invoke, {
      resume_from: GIG, approvals: { governor: JUDGMENT }, approved_by: "eugene",
    }));
    expect(res.status).toBe("complete");
    expect(second.calls, "the sealed scan is restored, not re-derived").toEqual({ reader: 1 });
  });

  it("the approval SEALS through the same gate as every record, then the performance continues", async () => {
    const b = bench();
    await runChart(plan(gated()), {}, deps(b, counting().invoke)); // park

    const second = counting();
    const res = await runChart(plan(gated()), {}, deps(b, second.invoke, {
      resume_from: GIG, approvals: { proceed: JUDGMENT }, approved_by: "eugene",
    }));

    expect(res.status).toBe("complete");
    expect(second.calls, "the parked movement runs; the played one does not").toEqual({ reader: 1 });

    const approval = b.outputs.all().find((o) => o.agent_slug === "eugene");
    expect(approval, "a gate's yes is a sealed output, not a message").toBeTruthy();
    expect(approval!.domain_type).toBe("Judgment");
    expect(approval!.from_role).toBe("producer");
    // it approved something specific: the sealed output of the movement it gates
    const sensed = b.outputs.all().find((o) => o.domain_type === "Signal")!;
    expect(approval!.input_shas).toContain(sensed.content_sha);
    expect(res.gates_approved).toEqual([{ gate_id: "proceed", chair: "producer", approved_by: "eugene", output_id: approval!.id }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The budget envelope — detected at the movement boundary, before any inference
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("runChart — a gate is answered ONCE per performance", () => {
  const gatedDeep = () => ({
    slug: "gated-deep",
    movements: [{ movement_id: "sense", standard_slug: "look" }, { movement_id: "read", standard_slug: "digest-deep" }],
    edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
    approval_gates: [{ gate_id: "proceed", after_movement: "sense", before_movement: "read", chair: "producer" }],
  });

  it("a second resume restores the sealed yes instead of asking for it again", async () => {
    const b = bench();
    await runChart(plan(gatedDeep()), {}, deps(b, counting().invoke)); // park at the gate

    // Approve — and die inside the gated movement, so the performance is resumed a second time.
    await expect(runChart(plan(gatedDeep()), {}, deps(b, counting({ failOn: { agent: "judge", times: 1 } }).invoke, {
      resume_from: GIG, approvals: { proceed: JUDGMENT }, approved_by: "eugene",
    }))).rejects.toThrow();
    expect(b.outputs.all().filter((o) => o.from_role === "producer")).toHaveLength(1);

    // Resume WITHOUT re-supplying the approval: the gate is already answered and sealed.
    const res = await runChart(plan(gatedDeep()), {}, deps(b, counting().invoke, { resume_from: GIG }));
    expect(res.status).toBe("complete");
    expect(b.outputs.all().filter((o) => o.from_role === "producer"), "one decision, one record").toHaveLength(1);
    expect(res.gates_approved).toEqual([{ gate_id: "proceed", chair: "producer", approved_by: "eugene", output_id: expect.any(String) }]);
  });
});

describe("runChart — the envelope is checked at the movement boundary (edge case B)", () => {
  const capped = () => ({ ...lineChart(), budget_envelope: { total_usd: 0.1 } });

  it("does not spawn the next movement when the envelope is already spent", async () => {
    const b = bench();
    const c = counting({ usd: { scout: 0.42 } });
    const res = await runChart(plan(capped()), {}, deps(b, c.invoke));

    expect(res.status).toBe("budget_exhausted");
    expect(c.calls, "the boundary is the last cheap place to stop — B never started").toEqual({ scout: 1 });
    expect(res.budget).toMatchObject({ total_usd: 0.1, spent_usd: 0.42, exhausted_at_movement: "read" });
    expect(res.movements[1]!.status).toBe("budget_exhausted");
  });

  it("a resumed chart reads prior_budget_state.spent_usd and refuses at the boundary again", async () => {
    const b = bench();
    await runChart(plan(capped()), {}, deps(b, counting({ usd: { scout: 0.42 } }).invoke));

    const cp = b.checkpoints.read(chartCheckpointId(GIG)) as GigCheckpoint;
    expect(cp.prior_budget_state?.spent_usd, "the cumulative spend rides on the checkpoint").toBeCloseTo(0.42);

    const second = counting();
    const res = await runChart(plan(capped()), {}, deps(b, second.invoke, { resume_from: GIG }));
    expect(res.status).toBe("budget_exhausted");
    expect(second.calls, "no inference is spent to discover a spend that already happened").toEqual({});
  });

  it("a performance inside its envelope completes and reports what it spent", async () => {
    const b = bench();
    const res = await runChart(plan({ ...lineChart(), budget_envelope: { total_usd: 5 } }), {}, deps(b, counting({ usd: { scout: 0.4, reader: 0.6 } }).invoke));
    expect(res.status).toBe("complete");
    expect(res.spent_usd).toBeCloseTo(1.0);
    expect(res.budget).toMatchObject({ total_usd: 5 });
  });
});
