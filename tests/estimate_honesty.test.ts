// RED — the two fabricated numbers on the accounting surface.
//
//   #238 — health_check hardcodes success_rate: 1.0 and trend: "stable" for ANY entity, with
//          no data behind either. An agent that has failed every dispatch it ever ran reports
//          a 100% success rate — and it *cannot* report otherwise, because failed gigs write
//          no ledger row, so the denominator does not exist. `cost` is an output COUNT.
//          A fabricated measurement presented as a measurement is worse than a missing one:
//          the missing one gets investigated.
//
//   #239 — standard_simulate's estimated_cost is a three-entry hardcoded lookup that never
//          reads the standard it is simulating. Simulating the 6-phase submission-convergence
//          returns three INVENTED phases named sense/process/deliver. The tool CLAUDE.md tells
//          operators to run before spending returns an estimate of a different pipeline.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, standardSimulate,
  type DomainType, type PhaseDef, type Chair, type Standard, type LedgerEntry,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reading: DomainType = { slug: "reading", extends: "Interpretation", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };
const call: DomainType = { slug: "call", extends: "Verdict", domain: "demo", schema: { properties: { d: { type: "string" } } }, required_fields: ["d"] };

const c = (role: string, agent_slug: string, depends_on: string[], input_contract: string[], output_contract: string[]): Chair =>
  ({ role, agent_slug, depends_on, input_contract, output_contract, required_skills: [] });

/** A three-phase standard whose phase names are nothing like sense/process/deliver. */
const realStandard = (): Standard => composeStandard({
  slug: "convergence-lite", domain: "demo",
  agents: [
    testAgent({ slug: "parser", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "blueprinter", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["reading"], domain: "demo" }),
    testAgent({ slug: "gatekeeper", primitives: ["VERIFY"], input_types: ["reading"], output_types: ["call"], domain: "demo" }),
  ],
  phases: [
    { name: "rfp-parse", chairs: [c("p", "parser", [], [], ["note"])] } as PhaseDef,
    { name: "blueprint", chairs: [c("b", "blueprinter", ["p"], ["note"], ["reading"])] } as PhaseDef,
    { name: "gate", chairs: [c("g", "gatekeeper", ["b"], ["reading"], ["call"])] } as PhaseDef,
  ],
});

function makeDeps(withStandard = true): ServerDeps {
  const registry = createRegistry();
  for (const t of [note, reading, call]) registry.registerType(t);
  const std = realStandard();
  return {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    ...(withStandard ? { standards: new Map([[std.slug, std]]) } : {}),
  };
}

function gigRow(over: Partial<Record<string, unknown>> = {}): LedgerEntry {
  return {
    kind: "gig", schema_version: 2, entry_id: String(over["gig_id"] ?? "g"), gig_id: String(over["gig_id"] ?? "g"),
    standard_slug: "convergence-lite", genome_hash: "a".repeat(64), run_fingerprint: "b".repeat(64),
    output_hashes: [], started_at: "2026-05-25T20:00:00.000Z", finished_at: "2026-05-25T20:01:00.000Z",
    ...over,
  } as unknown as LedgerEntry;
}

// ── #238 ────────────────────────────────────────────────────────────────────
describe("#238 — health_check does not fabricate an attestation", () => {
  it("success_rate is not a hardcoded 1.0 for an entity with no history", async () => {
    const r = await dispatchTool("health_check", { slug: "never-run", kind: "agent" }, makeDeps());
    const data = r.data as { success_rate: unknown; success_rate_basis?: string };
    expect(
      data.success_rate,
      "src/server.ts returns the literal 1.0 for ANY entity. An agent that failed every " +
        "dispatch it ever ran reports 100%, and it cannot report otherwise — failed gigs " +
        "write no ledger row, so the data to compute from does not exist.",
    ).toBeNull();
    expect(
      data.success_rate_basis,
      "when a number cannot be computed, the tool must say WHY — a bare null is a gap, a " +
        "labelled null is an answer.",
    ).toBeTruthy();
  });

  it("trend is not unconditionally 'stable'", async () => {
    const r = await dispatchTool("health_check", { slug: "never-run", kind: "agent" }, makeDeps());
    expect((r.data as { trend: unknown }).trend, "trend: 'stable' is asserted with no windowed history behind it").not.toBe("stable");
  });

  it("cost reports real dollars off the ledger, not a row count", async () => {
    const d = makeDeps();
    d.ledger.append(gigRow({ gig_id: "g1", usage: { input_tokens: 10, output_tokens: 5, total_cost_usd: 0.75, by_model: {} } }));
    d.ledger.append(gigRow({ gig_id: "g2", usage: { input_tokens: 10, output_tokens: 5, total_cost_usd: 0.5, by_model: {} } }));

    const r = await dispatchTool("health_check", { slug: "convergence-lite", kind: "standard" }, d);
    const data = r.data as { cost_usd: number; execution_count: number };
    expect(data.execution_count, "sanity: two runs").toBe(2);
    expect(
      data.cost_usd,
      "`cost: output_count` reports 2 for $1.25 of spend. The engine has carried real settled " +
        "spend on the gig row since #195 — the count is a proxy that is now simply wrong.",
    ).toBeCloseTo(1.25, 6);
  });

  it("still counts an agent's outputs (the one honest number it already had)", async () => {
    const d = makeDeps();
    // `note` is Signal-cored: it names where it was acquired. `outputs.write` enforces one
    // substance floor per core on every seal (#227 ruling), so a payload that omits it is
    // refused and there is no output left to count.
    await dispatchTool("output_write", { core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "g1", agent_slug: "parser", data: { t: "x", source: "fixture://demo/note" } }, d);
    const r = await dispatchTool("health_check", { slug: "parser", kind: "agent" }, d);
    expect((r.data as { output_count: number }).output_count).toBe(1);
  });
});

// ── #239 ────────────────────────────────────────────────────────────────────
describe("#239 — standard_simulate reads the standard it is simulating", () => {
  it("returns the standard's REAL phase names, not sense/process/deliver", async () => {
    const r = await dispatchTool("standard_simulate", { standard_slug: "convergence-lite", mock_input: {}, depth: "standard" }, makeDeps());
    expect(r.ok, r.error).toBe(true);
    const names = (r.data as { phases: { name: string }[] }).phases.map((p) => p.name);
    expect(
      names,
      "standardSimulate receives only a SLUG — the genome's standards map is never passed in, " +
        "so it cannot read the standard. KNOWN_PHASES has one entry and everything else falls " +
        "through to three invented phases.",
    ).toEqual(["rfp-parse", "blueprint", "gate"]);
  });

  it("the estimate scales with the standard's real size", () => {
    const one = standardSimulate({
      standard_slug: "x", mock_input: {}, depth: "standard",
      standard: { slug: "x", phases: [{ name: "only", chairs: 1 }] },
    });
    const three = standardSimulate({
      standard_slug: "y", mock_input: {}, depth: "standard",
      standard: { slug: "y", phases: [{ name: "a", chairs: 1 }, { name: "b", chairs: 1 }, { name: "c", chairs: 1 }] },
    });
    expect(three.estimated_cost).toBeGreaterThan(one.estimated_cost);
  });

  it("labels whether the number came from the standard, from history, or from a guess", async () => {
    const guess = standardSimulate({ standard_slug: "unknown-thing", mock_input: {}, depth: "standard" });
    expect(guess.basis, "a number with nothing behind it must not look like a reading").toBe("fallback");

    const structural = await dispatchTool("standard_simulate", { standard_slug: "convergence-lite", mock_input: {}, depth: "standard" }, makeDeps());
    expect((structural.data as { basis: string }).basis).toBe("structural");

    const d = makeDeps();
    d.ledger.append(gigRow({ gig_id: "g1", usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 4.0, by_model: {} } }));
    d.ledger.append(gigRow({ gig_id: "g2", usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 6.0, by_model: {} } }));
    const observed = await dispatchTool("standard_simulate", { standard_slug: "convergence-lite", mock_input: {}, depth: "standard" }, d);
    const od = observed.data as { basis: string; sample_size: number; estimated_cost: number };
    expect(od.basis, "with real runs on the ledger the estimator must use them").toBe("observed");
    expect(od.sample_size).toBe(2);
    expect(od.estimated_cost, "mean of the two observed runs at depth=standard").toBeCloseTo(5.0, 6);
  });

  it("depth still scales the estimate (the multiplier contract is unchanged)", async () => {
    const d = makeDeps();
    const skim = await dispatchTool("standard_simulate", { standard_slug: "convergence-lite", mock_input: {}, depth: "skim" }, d);
    const std = await dispatchTool("standard_simulate", { standard_slug: "convergence-lite", mock_input: {}, depth: "standard" }, d);
    const ratio = (skim.data as { estimated_cost: number }).estimated_cost / (std.data as { estimated_cost: number }).estimated_cost;
    expect(ratio).toBeCloseTo(0.5, 3);
  });
});
