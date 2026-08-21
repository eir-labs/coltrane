// A PARKED GIG RETAINS THE TREE — awaiting_approval is NOT terminal.
//
// A gig parked on a human chair holds uncommitted work in the working tree: the model chairs
// before the gate already ran and left changes on disk, and the gig will continue from that exact
// tree when it is approved. So it must KEEP the lock while parked — release is gated on status,
// and awaiting_approval is deliberately excluded from the terminal set.
//
// The consequence, encoded here as law: while parked, a DIFFERENT dispatch against the same tree
// is refused (naming the parked holder), but the holder's OWN resume (same gig_id, carrying the
// approval) re-enters — a gig must be able to approve itself out of the park it is holding, or the
// park law would wedge the repo forever. Completing that resume reaches a terminal state and frees
// the tree.
//
// RED-first: no lock exists, so the concurrent dispatch during the parked window proceeds where
// the contract demands a refusal.
import { describe, it, expect, vi } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger, composeStandard, defineAgent, type PhaseDef, type AgentInvoker } from "../src/index.js";
import { createMemoryCheckpointStore } from "../src/reuse.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { freshGenomeDir, pollUntil } from "./_support/repo_lock_fixtures.js";

const scout = defineAgent({
  slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"],
  domain: "test", identity: "you are scout", method: "1. look 2. report 3. stop",
  constraints: [], behavioral_primitives: ["explorer", "critic"],
});
const HUMAN_CHAIR = {
  role: "approve", human: true, agent_slug: "", depends_on: ["scan"],
  input_contract: [], output_contract: ["Judgment"], optional_outputs: [], required_skills: [],
};
const parkStandard = () => composeStandard({
  slug: "sense-then-approve", domain: "test", agents: [scout],
  phases: [
    { name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] },
    { name: "approve", chairs: [HUMAN_CHAIR] },
  ] as PhaseDef[],
});
const SIGNAL = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };
const APPROVAL = {
  id: "approval-1", input_refs: ["sig-1"],
  criteria: ["the scan covers the declared boundary"],
  verdicts: [{ criterion: "the scan covers the declared boundary", verdict: "approved" }],
  reasoning_chain: ["reviewed the sealed scan; boundary matches the dispatch payload"],
};

/** Deps that park at the human chair. A shared memory checkpoint store lets the SAME deps resume
 *  the gig it parked (the park writes a checkpoint; the resume restores the chairs already paid for). */
function parkDeps(genome_dir: string): ServerDeps {
  const registry = createRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([["sense-then-approve", parkStandard()]]),
    invoke: vi.fn(async () => SIGNAL) as unknown as AgentInvoker,
    gig_runs: new Map(),
    checkpoints: createMemoryCheckpointStore(),
    genome_dir,
  };
}
const dispatch = (deps: ServerDeps, args: Record<string, unknown> = {}) =>
  dispatchTool("gig_dispatch", { standard_slug: "sense-then-approve", input: {}, ...args }, deps);

describe("parked-gig retention — awaiting_approval keeps the tree until a terminal resume frees it", () => {
  it("refuses a concurrent same-tree dispatch while parked, admits the holder's own resume, then frees the tree", async () => {
    const root = freshGenomeDir();
    const dA = parkDeps(root);
    const rA = await dispatch(dA);
    const gidA = (rA.data as { gig_id: string }).gig_id;
    const parked = await pollUntil(dA, gidA, (s) => s === "awaiting_approval");
    expect(parked["status"], "the gig parks at the human chair — not terminal, tree still in use").toBe("awaiting_approval");

    // A DIFFERENT gig against the same tree is refused — the parked gig retains it.
    const other = await dispatch(parkDeps(root));
    expect(other.ok, "a parked gig retains the tree — a concurrent dispatch is refused").toBe(false);
    expect(String(other.error), "the refusal names the PARKED holder").toContain(gidA);

    // The holder's OWN resume (same gig_id, with the approval) re-enters the tree it holds.
    const resume = await dispatch(dA, { resume_gig_id: gidA, approvals: { approve: APPROVAL }, approved_by: "eugene" });
    expect(resume.ok, "the holder may re-acquire its own lock to resume the parked gig — otherwise the park wedges the repo").toBe(true);
    expect((await pollUntil(dA, gidA, (s) => s !== "running" && s !== "awaiting_approval"))["status"]).toBe("complete");

    // Terminal at last — the tree frees for a new dispatch.
    const dAfter = parkDeps(root);
    const rAfter = await dispatch(dAfter);
    expect(rAfter.ok, "a completed gig releases the tree").toBe(true);
    await pollUntil(dAfter, (rAfter.data as { gig_id: string }).gig_id, (s) => s === "awaiting_approval");
  });
});
