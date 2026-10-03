// L4 — WHETHER A GIG IS CLOSED IS THE STORE'S TO SAY. (docs/specs/gig-runs-once.red-spec.json)
//
// Conductor ruling: when a store is present, G4's question ("is this gig closed: failed, aborted,
// completed or cancelled?") is answered by the STORE's status (coltrane_mcp_gig_status, or the
// drain's equivalent), never only by the local checkpoint. Without a store, the local checkpoint
// decides.
//
// Today the gig_dispatch door decides from the checkpoint alone:
// `deps.checkpoints.read(resumeArg)?.ended` (src/server.ts). The checkpoint is not the authority,
// and it is often wrong:
//   * the runtime deliberately writes no `ended` on a LOST LEASE ("the gig is not ours to end").
//     The store later records the gig failed, so the checkpoint still says "not ended";
//   * a gig that failed on another box, or whose checkpoint was reaped, has nothing local that says
//     it ended.
// A checkpoint-only door resumes such a gig UNDER ITS OLD ID. That reopens a closed row, and the
// store's terminal guard answers every write with 23514.
//
// The store seam, parallel to queueGig / approveGig / cancelGig:
//   ServerDeps.gigStatus?: (gig_id) => Promise<string | null | undefined>
// The host wires it to coltrane_mcp_gig_status. Absent means no store, and the checkpoint decides.
//
// The law uses a checkpoint whose `ended` mark is absent, which is exactly what a lost lease leaves
// behind:
//   (a) with no store, the checkpoint decides: a classic resume under the old id;
//   (b) a store answering `awaiting_approval` (not closed): the old id is kept;
//   (c) a store answering `failed`: a NEW gig carrying `resumes: <old id>`, nothing under the old id.
// The same checkpoint, and three answers that differ only in what the store says.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createMemoryCheckpointStore, type CheckpointStore } from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const callT: DomainType = { slug: "call", extends: "Verdict", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };
const NOTE = { t: "hi", source: "fixture://demo/note" };
const CALL = { v: "go", checks: [{ method: "the fixture ran one check", result: "pass" }] };
const chairs: Chair[] = [
  { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] },
  { role: "g", agent_slug: "gate", depends_on: ["s"], input_contract: ["note"], output_contract: ["call"], required_skills: [] },
];
const standard = (): Standard => composeStandard({
  slug: "closed-by-store-demo", domain: "demo",
  agents: [
    testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "gate", primitives: ["VERIFY"], input_types: ["note"], output_types: ["call"], domain: "demo" }),
  ],
  phases: [{ name: "sense", chairs: [chairs[0]!] } as PhaseDef, { name: "verify", chairs: [chairs[1]!] } as PhaseDef],
});

/** A gig whose first attempt failed at the gate, with its checkpoint's `ended` mark REMOVED (a lost lease's checkpoint). */
async function failedGigUnknownLocally(storeSays: string | undefined): Promise<{ d: ServerDeps; oldId: string; asked: string[] }> {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(callT);
  const std = standard();
  let failGate = true;
  const invoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "gate" && failGate) { failGate = false; throw new Error("stub gate failure"); }
    return ctx.agent.slug === "solo" ? { ...NOTE } : { ...CALL };
  };
  const checkpoints: CheckpointStore = createMemoryCheckpointStore();
  const asked: string[] = [];
  const d = {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(), checkpoints,
    ...(storeSays !== undefined ? { gigStatus: async (gig_id: string) => { asked.push(gig_id); return storeSays; } } : {}),
  } as unknown as ServerDeps;
  const r1 = await dispatchTool("gig_dispatch", { standard_slug: std.slug, input: {}, wait: true }, d);
  expect(r1.ok, "precondition: attempt 1 fails at the gate").toBe(false);
  const oldId = d.outputs.all()[0]!.gig_id;
  const cp = checkpoints.read(oldId);
  expect(cp, "precondition: attempt 1 left a checkpoint").toBeDefined();
  const { ended: _dropped, ...withoutEnded } = cp as unknown as Record<string, unknown>;
  checkpoints.write(withoutEnded as never);
  expect((checkpoints.read(oldId) as unknown as Record<string, unknown>)["ended"], "precondition: the checkpoint does not know the gig ended").toBeUndefined();
  return { d, oldId, asked };
}

const resumeOf = async (d: ServerDeps, oldId: string) => {
  const r = await dispatchTool("gig_dispatch", { standard_slug: "closed-by-store-demo", input: {}, wait: true, resume_gig_id: oldId }, d);
  expect(r.ok, `precondition: the resume succeeds: ${JSON.stringify(r)}`).toBe(true);
  const data = r.data as Record<string, unknown>;
  return { newId: String(data["gig_id"]), resumes: data["resumes"] ?? (data["manifest"] as Record<string, unknown> | undefined)?.["resumes"] };
};

describe("L4 — with a store present, the STORE decides whether a gig is closed", () => {
  it("L4 the same checkpoint (no `ended`): no store → old id; store says awaiting_approval → old id; store says FAILED → a NEW gig carrying `resumes`", async () => {
    // (a) no store: the checkpoint decides, and it does not know the gig ended.
    {
      const { d, oldId } = await failedGigUnknownLocally(undefined);
      const { newId } = await resumeOf(d, oldId);
      expect(newId, "without a store the local checkpoint decides: a classic resume keeps the id").toBe(oldId);
    }
    // (b) a store that says the gig is NOT closed.
    {
      const { d, oldId } = await failedGigUnknownLocally("awaiting_approval");
      const { newId } = await resumeOf(d, oldId);
      expect(newId, "the store says the gig is open, so the resume keeps its id").toBe(oldId);
    }
    // (c) a store that says the gig FAILED, with a checkpoint that does not know it.
    {
      const { d, oldId, asked } = await failedGigUnknownLocally("failed");
      const before = d.outputs.all().filter((o) => o.gig_id === oldId).length;
      const { newId, resumes } = await resumeOf(d, oldId);
      expect(asked, "the door never asked the store whether the gig is closed").toContain(oldId);
      expect(newId, "the store says FAILED, but the door believed the checkpoint and reopened the closed gig under its old id").not.toBe(oldId);
      expect(resumes, "the new gig must say which gig it resumes").toBe(oldId);
      expect(d.outputs.all().filter((o) => o.gig_id === oldId).length, "the resume sealed into the closed gig").toBe(before);
    }
  });
});
