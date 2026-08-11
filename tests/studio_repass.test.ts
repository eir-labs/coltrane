// THE STUDIO RE-PASS — a chart that re-performs a completed standard by re-running only the thin
// seat and re-weaving from seeds, sealing at an approval gate.
//
// The pattern, as an arrangement over the lineage family:
//   m1-pass    (lineage-pass-v1)     — the completed pass. It seals its two SENSES (internal-inventory,
//                                       lineage-hit) as declared outputs, so a re-pass can REUSE them.
//   m2-deepen  (lineage-deepen-v0)   — re-run JUST the thin external seat with a sharper question →
//                                       a fresh lineage-hit. The scouts are not re-run wholesale.
//   m3-reweave (lineage-reweave-v0)  — re-draw the synthesis from the REUSED internal-inventory
//                                       (m1-pass) + BOTH external hits (m1-pass's original and
//                                       m2-deepen's deepened), without re-running any scout.
//
// m3-reweave's entry chair `associate` is seeded ENTIRELY by chart edges: internal-inventory from the
// unchanged seat (m1-pass), and lineage-hit from BOTH m1-pass and m2-deepen. A human gate parks the
// performance before the reweave commits.
//
// RED-first: this file is written against a genome with no lineage-deepen-v0, no lineage-reweave-v0,
// no studio-repass-v0 chart, and a lineage-pass-v1 that does not yet expose its senses. Every
// assertion below is on wiring that does not exist yet, so the file is RED until those land.
//
// Compose-time only — no live agent runs, no claude spawned. Same posture as tests/chart.test.ts.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { composeChart, type ChartPlan } from "../src/chart.js";
import { loadGenome } from "../src/loader.js";
import type { ChartInput } from "../src/genome_schema.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The one loaded genome every case reads — the real files on disk, composed at load. */
const g = loadGenome(REPO);

/** Compose the shipped chart against the real standards/agents, seeded exactly as the loader does. */
function plan(): ChartPlan {
  const chart = g.charts.get("studio-repass-v0");
  const c = composeChart({
    chart: chart as ChartInput,
    standards: g.standards,
    agents: g.agents,
    // A source movement with no incoming edge is seeded by the dispatch payload; both m1-pass and
    // m2-deepen enter on a lineage-question, exactly what the loader supplies via chartEntrySeedTypes.
    payload_types: ["lineage-question"],
  });
  if (!c.ok) throw new Error(`studio-repass-v0 did not compose: ${JSON.stringify(c.violations)}`);
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The R6 resolution — the pass must EXPOSE its senses for a re-pass to reuse them
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("lineage-pass-v1 exposes its senses so a studio re-pass can reuse them", () => {
  it("seals internal-inventory and lineage-hit as declared outputs (R6: an edge names a SEALED type)", () => {
    // An edge asserts the SOURCE movement seals the type it carries. lineage-pass-v1's scouts seal
    // internal-inventory and lineage-hit MID-pass (they are not terminal chairs), so the standard
    // must DECLARE them as outputs for the reuse edges of a re-pass to compose. This is the whole
    // reason a completed pass is reusable rather than opaque.
    const std = g.standards.get("lineage-pass-v1");
    expect(std, "the model standard must still load").toBeTruthy();
    expect(std!.output_types).toEqual(
      expect.arrayContaining(["lineage-record", "lineage-verdict", "internal-inventory", "lineage-hit"]),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The two new standards
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("the re-pass standards load and mirror the lineage family", () => {
  it("lineage-deepen-v0 is the thin external seat, re-run with a sharper question", () => {
    const std = g.standards.get("lineage-deepen-v0");
    expect(std, "lineage-deepen-v0 must load").toBeTruthy();
    expect(std!.domain).toBe("lineage");
    expect(std!.input_types).toEqual(["lineage-question"]);
    expect(std!.output_types).toEqual(["lineage-hit"]);
    // ONE phase, ONE chair — just the external scout, nothing else.
    expect(std!.phases).toHaveLength(1);
    const chairs = std!.phases.flatMap((p) => p.chairs);
    expect(chairs).toHaveLength(1);
    expect(chairs[0]!.role).toBe("identify-external");
    expect(chairs[0]!.agent_slug).toBe("lineage-scout-external");
    expect(chairs[0]!.output_contract).toEqual(["lineage-hit"]);
  });

  it("lineage-reweave-v0 re-weaves from seeds — associate is an ENTRY chair fed by edges", () => {
    const std = g.standards.get("lineage-reweave-v0");
    expect(std, "lineage-reweave-v0 must load").toBeTruthy();
    expect(std!.domain).toBe("lineage");
    // The two senses enter from OUTSIDE the standard (the chart's edges), not from re-running scouts.
    expect(std!.input_types).toEqual(expect.arrayContaining(["lineage-hit", "internal-inventory"]));
    expect(std!.output_types).toEqual(["lineage-record"]);

    const byRole = new Map(std!.phases.flatMap((p) => p.chairs).map((c) => [c.role, c]));
    const associate = byRole.get("associate");
    expect(associate, "the associate chair must exist").toBeTruthy();
    // ENTRY chair: depends_on [] so the chart seeds it, consuming both senses, sealing the lineage-map.
    expect(associate!.depends_on).toEqual([]);
    expect(associate!.agent_slug).toBe("lineage-weaver");
    expect(associate!.input_contract).toEqual(expect.arrayContaining(["lineage-hit", "internal-inventory"]));
    expect(associate!.output_contract).toEqual(["lineage-map"]);

    const assess = byRole.get("assess");
    expect(assess!.depends_on).toEqual(["associate"]);
    expect(assess!.agent_slug).toBe("lineage-weaver");
    expect(assess!.output_contract).toEqual(["alignment-plan"]);

    const compose = byRole.get("compose");
    expect(compose!.depends_on).toEqual(expect.arrayContaining(["associate", "assess"]));
    expect(compose!.agent_slug).toBe("lineage-scribe");
    expect(compose!.output_contract).toEqual(["lineage-record"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The arrangement — it composes, its entry chair is seeded, its gate is placed
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("studio-repass-v0 — the arrangement composes and wires the re-pass pattern", () => {
  it("(a) the chart loads and composes without refusal", () => {
    expect(g.load_errors.filter((e) => e.kind === "chart" || e.kind === "venue")).toEqual([]);
    expect(g.charts.has("studio-repass-v0"), "the shipped chart must load").toBe(true);
    const p = plan();
    expect(p.chart_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.order).toContain("m1-pass");
    expect(p.order).toContain("m2-deepen");
    expect(p.order).toContain("m3-reweave");
    // m3-reweave is the synthesis: every seeding movement precedes it.
    expect(p.order.indexOf("m3-reweave")).toBeGreaterThan(p.order.indexOf("m1-pass"));
    expect(p.order.indexOf("m3-reweave")).toBeGreaterThan(p.order.indexOf("m2-deepen"));
    expect(p.movements.map((m) => m.standard.slug)).toEqual(
      expect.arrayContaining(["lineage-pass-v1", "lineage-deepen-v0", "lineage-reweave-v0"]),
    );
  });

  it("(b) m3-reweave's entry chair has its required slots satisfied by the incoming edges", () => {
    const p = plan();
    // The hard edges that seed m3-reweave, by (source, type).
    const into = p.edges_classified.filter((e) => e.to_movement === "m3-reweave");
    const hard = into.filter((e) => e.kind === "hard");

    // internal-inventory — the UNCHANGED seat — comes from m1-pass, and ONLY from m1-pass.
    const invEdges = hard.filter((e) => e.output_type === "internal-inventory");
    expect(invEdges.map((e) => e.from_movement)).toEqual(["m1-pass"]);

    // lineage-hit is fed by BOTH the original pass and the deepened seat.
    const hitSources = hard.filter((e) => e.output_type === "lineage-hit").map((e) => e.from_movement).sort();
    expect(hitSources).toEqual(["m1-pass", "m2-deepen"]);

    // Every required input slot of the associate entry chair is covered by a hard edge — the reweave
    // is seeded entirely from reused + new outputs, with no scout re-run.
    const associate = g.standards
      .get("lineage-reweave-v0")!
      .phases.flatMap((ph) => ph.chairs)
      .find((c) => c.role === "associate")!;
    const carried = new Set(hard.map((e) => e.output_type));
    for (const need of associate.input_contract) {
      expect(carried.has(need), `entry slot "${need}" must be seeded by an incoming hard edge`).toBe(true);
    }
  });

  it("(c) an approval gate seals the re-pass before the reweave commits", () => {
    const p = plan();
    const gate = p.chart.approval_gates.find((x) => x.gate_id === "lineage-repass-approval");
    expect(gate, "the arrangement carries its approval gate").toBeTruthy();
    // The gate orders two real movements (composeChart requires before_movement — a gate is an
    // ordering as much as an approval), and it parks the performance before the reweave is spent.
    expect(gate!.before_movement).toBe("m3-reweave");
    expect(p.order.indexOf(gate!.before_movement)).toBeGreaterThan(p.order.indexOf(gate!.after_movement));
  });
});
