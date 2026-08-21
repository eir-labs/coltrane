// A CHART HOLDS ONE LOCK FOR ITS FULL LIFETIME — never per-movement.
//
// A chart runs its movements sequentially under one background promise. The lock is acquired ONCE
// before the first movement (holder = the chart's own gig_id) and released only when the chart
// promise settles. A per-movement acquire/release would either open a gap between movements where
// a concurrent dispatch could slip in, or DEADLOCK movement 2 against the non-re-entrant lock
// movement 1 still holds. This law pins the single-lock-for-lifetime decision: a concurrent
// same-tree dispatch is refused DURING a movement (here, movement 2), and the tree frees only
// after the whole chart settles.
//
// RED-first: no lock is acquired at chart start, so the concurrent dispatch during movement 2
// proceeds where the contract demands a refusal.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry, createOutputStore, MemoryLedger, composeStandard, type AgentInvoker, type PhaseDef, type Standard } from "../src/index.js";
import { ChartSchema } from "../src/genome_schema.js";
import { testAgent } from "./_support/agents.js";
import { gate, pollSettled, pollUntil } from "./_support/repo_lock_fixtures.js";

// A two-movement chart in a line: `sense` (scout seals a Signal) → `read` (reader interprets it),
// the edge carrying the Signal across the boundary. Bare core types, so the registry needs no
// domain registration.
const scout = testAgent({ slug: "scout", primitives: ["SENSE"], output_types: ["Signal"], domain: "chart-demo" });
const reader = testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["Signal"], output_types: ["Interpretation"], domain: "chart-demo" });

const look = (): Standard => composeStandard({
  slug: "look", domain: "chart-demo", agents: [scout], output_types: ["Signal"],
  phases: [{ name: "p1", chairs: [{ role: "r1", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }] as PhaseDef[],
});
const digest = (): Standard => composeStandard({
  slug: "digest", domain: "chart-demo", agents: [reader], input_types: ["Signal"], output_types: ["Interpretation"],
  phases: [{ name: "p2", chairs: [{ role: "r2", agent_slug: "reader", depends_on: [], input_contract: ["Signal"], output_contract: ["Interpretation"], required_skills: [] }] }] as PhaseDef[],
});
const chartLine = () => ({
  slug: "look-then-digest",
  movements: [
    { movement_id: "sense", standard_slug: "look" },
    { movement_id: "read", standard_slug: "digest" },
  ],
  edges: [{ from_movement: "sense", to_movement: "read", output_type: "Signal" }],
});

function chartDeps(genome_dir: string, invoke: AgentInvoker): ServerDeps {
  const registry = createRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([["look", look()], ["digest", digest()]]),
    agents: new Map([["scout", scout], ["reader", reader]]),
    charts: new Map([["look-then-digest", ChartSchema.parse(chartLine())]]),
    invoke,
    gig_runs: new Map(),
    genome_dir,
  };
}

const bothMovements: AgentInvoker = async (ctx) =>
  ctx.agent.slug === "reader" ? { claims: [{ claim: "read" }] } : { source: "fixture://chart/look" };

describe("chart single-flight — one lock spans every movement of the performance", () => {
  it("refuses a concurrent same-tree dispatch DURING a movement and frees the tree only after the chart settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "coltrane-repo-lock-chart-"));
    const started = gate();
    const released = gate();
    // Movement 1 (scout) seals fast; movement 2 (reader) gates — so when `started` opens the chart
    // is provably PAST movement 1 and inside movement 2, still holding the one lock.
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "reader") { started.open(); await released.promise; return { claims: [{ claim: "read" }] }; }
      return { source: "fixture://chart/look" };
    };
    const dChart = chartDeps(root, invoke);
    const rChart = await dispatchTool("gig_dispatch", { chart_slug: "look-then-digest", input: { Signal: { source: "seed" } } }, dChart);
    expect(rChart.ok, String(rChart.error)).toBe(true);
    const chartGid = (rChart.data as { gig_id: string }).gig_id;

    await started.promise; // movement 2 is in flight — movement 1 already sealed and did NOT release

    const busy = await dispatchTool("gig_dispatch", { chart_slug: "look-then-digest", input: { Signal: { source: "seed" } } }, chartDeps(root, bothMovements));
    expect(busy.ok, "a chart holds ONE lock across every movement — a concurrent same-tree dispatch is refused mid-performance").toBe(false);
    expect(String(busy.error), "the refusal names the chart's own gig_id").toContain(chartGid);

    released.open();
    expect((await pollSettled(dChart, chartGid))["status"]).toBe("complete");

    // The whole chart settled — the tree frees for a fresh performance.
    const dAfter = chartDeps(root, bothMovements);
    const rAfter = await dispatchTool("gig_dispatch", { chart_slug: "look-then-digest", input: { Signal: { source: "seed" } } }, dAfter);
    expect(rAfter.ok, "once the chart settles the tree is free again").toBe(true);
    await pollUntil(dAfter, (rAfter.data as { gig_id: string }).gig_id, (s) => s !== "running");
  });
});
