// GIG_MONITOR AND THE PERFORMANCE ROOT — the same defect `cross_movement_trace.test.ts` closed
// for `output_trace`, still open at a call site that fix did not reach.
//
// A movement runs under its OWN gig id: `<performance>.m.<movement_id>` (src/chart.ts
// `movementGigId`, minted by `composeMovementGigId`). src/outputs.ts:142-147 is explicit that
// `performanceRoot` / `movementOfGigId` are "the ONE owner of that scheme", and that a second
// copy of the separator "is exactly the drift that would let the two disagree about what one
// performance is".
//
// `gig_monitor` holds that second copy, implicitly, by comparing raw ids:
//
//     const outs = deps.outputs.all().filter((o) => o.gig_id === gid);   // server.ts:1214, :1250
//
// Ask it about a CHART's gig id and the filter can never match, because every record was sealed
// under a movement id. Both branches are affected, and the fallback branch (a gig not in the live
// map — a prior server lifetime, or any synchronously-completed run) is the damaging one: it
// derives `status` and `phases_complete` FROM that same empty list, so a chart that ran and sealed
// outputs reports `status: "unknown"` and `phases_complete: 0`. That is not a missing convenience
// field; it is a wrong answer about whether work happened.
//
// Observed live, on a healthy running chart gig, before this file existed: `outputs_count: 2`
// printed next to `outputs_so_far: []`, with `source_gig_id` naming `<gig>.m.review-the-red` in
// the same payload — the evidence for the bug sitting beside the symptom.
//
// RED-first: written against an engine whose gig_monitor compares raw gig ids.
import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/registry.js";
import { createOutputStore, composeMovementGigId, type OutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";

const PERFORMANCE = "11111111-2222-3333-4444-555555555555";
const MOVEMENT = "review-the-red";
const MOVEMENT_GIG = composeMovementGigId(PERFORMANCE, MOVEMENT);

/** A store holding one record sealed under a MOVEMENT's gig id, as every chart run produces. */
function storeWithMovementOutput(): OutputStore {
  const registry = createRegistry();
  const outputs = createOutputStore(registry);
  outputs.write({
    core_type: "Interpretation",
    domain_type: "Interpretation",
    domain: "demo",
    gig_id: MOVEMENT_GIG,
    agent_slug: "john",
    from_role: "read-the-substrate-laws",
    phase: "read-the-red",
    primitive: "INTERPRET",
    data: { claims: [{ claim: "a movement's output belongs to its performance" }] },
  });
  return outputs;
}

const depsFor = (outputs: OutputStore): ServerDeps =>
  ({ outputs, ledger: new MemoryLedger() }) as unknown as ServerDeps;

describe("gig_monitor resolves a chart gig to its movements' outputs", () => {
  // THE CORE LAW. The performance's id is what an operator has — it is what `gig_dispatch`
  // returned — and asking about it must reach the work its movements did.
  it("lists a movement's sealed output when asked about the performance", async () => {
    const outputs = storeWithMovementOutput();
    const r = await dispatchTool("gig_monitor", { gig_id: PERFORMANCE }, depsFor(outputs));
    const data = (r as { data: { outputs_so_far: readonly { gig_id: string }[] } }).data;
    // Non-vacuity: the store really does hold the record, so an empty list is the tool's answer
    // and not an empty fixture.
    expect(outputs.all(), "the fixture must hold one sealed record").toHaveLength(1);
    expect(data.outputs_so_far, "a performance reaches its movements' work").toHaveLength(1);
    expect(data.outputs_so_far[0]!.gig_id).toBe(MOVEMENT_GIG);
  });

  // THE DAMAGING HALF. `status` and `phases_complete` are DERIVED from that filter on the
  // non-live path, so the empty list does not merely omit information — it asserts, wrongly,
  // that nothing happened.
  it("does not report a performance that sealed outputs as unknown and empty", async () => {
    const r = await dispatchTool("gig_monitor", { gig_id: PERFORMANCE }, depsFor(storeWithMovementOutput()));
    const data = (r as { data: { status: string; phases_complete: number } }).data;
    expect(data.status, "a gig whose movement sealed output is not 'unknown'").not.toBe("unknown");
    expect(data.phases_complete, "work happened, and the count must say so").toBeGreaterThan(0);
  });

  // Asking about the MOVEMENT directly must keep working — the movement id is its own root
  // (`performanceRoot` returns a plain id unchanged), so this path is unmoved by the fix.
  it("still answers when asked about the movement's own id", async () => {
    const r = await dispatchTool("gig_monitor", { gig_id: MOVEMENT_GIG }, depsFor(storeWithMovementOutput()));
    const data = (r as { data: { outputs_so_far: readonly unknown[] } }).data;
    expect(data.outputs_so_far, "a movement id still names its own records").toHaveLength(1);
  });

  // THE BOUND, inherited from cross_movement_trace.test.ts law 5: the rule is "same performance",
  // never "any id this store can resolve". A different performance must not bleed in — otherwise
  // the fix would trade a false negative for a false positive, which is strictly worse in an
  // audit surface.
  it("does not reach into a different performance", async () => {
    const outputs = storeWithMovementOutput();
    const other = "99999999-8888-7777-6666-555555555555";
    const r = await dispatchTool("gig_monitor", { gig_id: other }, depsFor(outputs));
    const data = (r as { data: { outputs_so_far: readonly unknown[] } }).data;
    expect(data.outputs_so_far, "one performance's records stay its own").toHaveLength(0);
  });

  // A prefix is not a root. `<uuid>` and `<uuid>-extra` are different performances, and a fix
  // written as `startsWith(gid)` would conflate them. The infix carries dots on both sides
  // precisely so this cannot happen (src/outputs.ts:149-151); this law holds the fix to it.
  it("treats a shared prefix as a different performance, not a parent", async () => {
    const outputs = storeWithMovementOutput();
    const prefix = PERFORMANCE.slice(0, 8);
    const r = await dispatchTool("gig_monitor", { gig_id: prefix }, depsFor(outputs));
    const data = (r as { data: { outputs_so_far: readonly unknown[] } }).data;
    expect(data.outputs_so_far, "a prefix of a uuid is not that uuid's performance").toHaveLength(0);
  });
});
