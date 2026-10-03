// R5.1 — A RESUMED GIG, CLAIMED AGAIN ELSEWHERE, DOES NOT RE-RUN ITS OWN WORK.
// (docs/specs/gig-runs-once.red-spec.json)
//
// G4h lets a new gig N resume a closed gig O: N runs under its own id and takes O's seals by
// reference. E6 lets a gig re-claimed on a fresh box finish from its OWN drained seals. The two meet
// here: N resumes O, seals chairs of its own, and then its box dies. The store hands N to a fresh
// box with no checkpoint, still carrying `resumes: O`.
//
// Two sets of seals now belong to N's run. O's are taken by reference; N's own were sealed and
// drained under N. Today workOnce rebuilds from ONE gig only, `resumes ?? claim.gig_id`, so the
// fresh box sees O's seals, never N's. It pays again for every chair N already sealed.
//
// The law: the rebuild takes O's seals (by reference) AND N's drained seals, invokes only the chairs
// sealed in neither, and writes nothing under O.
//
// The box "dies" as a lease loss mid-chair: the renew is refused, the run ends `abandoned`, nothing
// terminal is written, and N stays open in the store for the next claim.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, settle, GIG_ID } from "./gig_runs_once_fixtures.js";

const O = GIG_ID;
const N = "13131313-2424-3535-4646-575757575757";
type Beat = () => Promise<unknown>;

let env: ReturnType<typeof hostedEnv>;
const roots: string[] = [];
afterEach(() => {
  env?.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A signal whose bytes name its phase, so each chair's seal has its own content_sha. */
const answer = (phase: string) => ({ id: `sig-${phase}`, source: "test", data: { seen: phase }, completeness: 1, acquisition_cost: 0 });

/** Run one workOnce on its OWN fresh state root (a separate box). */
async function onFreshBox(deps: WorkOnceDeps): Promise<Awaited<ReturnType<typeof workOnce>>> {
  const root = mkdtempSync(join(tmpdir(), "coltrane-r5-box-"));
  roots.push(root);
  const saved = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = root;
  try {
    return await workOnce(venueCtx(), deps);
  } finally {
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = saved;
    await settle();
  }
}

describe("R5.1 — a resumed gig re-claimed on a fresh box pays only for what neither gig sealed", () => {
  it("R5.1 N resumes closed O, seals its own chair, loses its box; the fresh re-claim invokes only the chair sealed in neither, and writes nothing under O", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("three-chair-v0") });

    // Box A: O seals `scan`, then `rescan` fails. O is closed (failed).
    const a = await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => {
        if (ctx.phase === "rescan") throw new Error("rescan broke");
        return answer(ctx.phase);
      }) as unknown as AgentInvoker,
    } as WorkOnceDeps);
    expect(a.claimed && a.status, "precondition: O ends failed").toBe("failed");
    const oScan = store.outputs.find((o) => o["gig_id"] === O && o["phase"] === "scan");
    expect(oScan, "precondition: O's scan is in the sink").toBeDefined();

    // Box B: N resumes O, seals `rescan` (drained under N), then loses its lease inside `final`.
    store.set({
      claim: claimFor("three-chair-v0", { gig_id: N, resumes: O }),
      renew: () => new Response(JSON.stringify({ code: "42501", message: "lease not held by this instance" }), { status: 403 }),
    });
    const beats: Beat[] = [];
    const phasesB: string[] = [];
    const b = await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => {
        phasesB.push(ctx.phase);
        if (ctx.phase === "final") {
          for (const beat of beats) await beat().catch(() => undefined);
          throw new Error("the box is going down");
        }
        return answer(ctx.phase);
      }) as unknown as AgentInvoker,
      scheduleHeartbeat: (_ms: number, beat: Beat) => { beats.push(beat); return () => undefined; },
    } as unknown as WorkOnceDeps);
    expect(phasesB, "precondition: B took O's scan by reference and ran rescan, then final").toEqual(["rescan", "final"]);
    expect(b.claimed && b.status, "precondition: B's box died (lease lost), leaving N open").toBe("abandoned");
    const nRescan = store.outputs.find((o) => o["gig_id"] === N && o["phase"] === "rescan");
    expect(nRescan, "precondition: N's own rescan is in the sink").toBeDefined();

    // Box C: a fresh box, no checkpoint, re-claims N (still carrying resumes: O).
    store.set({ renew: () => new Response(JSON.stringify(new Date(Date.now() + 3_600_000).toISOString()), { status: 200 }) });
    const callsBefore = store.calls.length;
    const phasesC: string[] = [];
    const lines: string[] = [];
    const c = await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => { phasesC.push(ctx.phase); return answer(ctx.phase); }) as unknown as AgentInvoker,
      log: (l: string) => lines.push(l),
    } as WorkOnceDeps);

    expect(c.claimed && c.gig_id).toBe(N);
    expect(phasesC, `the fresh box paid again for a chair N already sealed. It rebuilt from O alone, never from N's own drained seals:\n${lines.join("\n")}`).toEqual(["final"]);
    expect(c.claimed && c.status, `N must complete:\n${lines.join("\n")}`).toBe("complete");

    const cCalls = store.calls.slice(callsBefore);
    const underO = cCalls.filter((x) =>
      (x.host === "drain" && x.path === "/rest/v1/coltrane_gigs" && x.body["id"] === O) ||
      (x.host === "drain" && x.path === "/rest/v1/coltrane_outputs" && x.body["gig_id"] === O) ||
      (x.host === "drain" && x.path.endsWith("/coltrane_drain_release") && x.body["p_gig_id"] === O) ||
      (x.host === "store" && x.path.endsWith("/coltrane_mcp_gig_fail") && x.body["p_gig"] === O));
    expect(underO.map((x) => x.path), "the re-claim wrote under the CLOSED gig's id").toEqual([]);
    const drainedByC = cCalls.filter((x) => x.host === "drain" && x.path === "/rest/v1/coltrane_outputs").map((x) => x.body["phase"]);
    expect(drainedByC, "the re-claim re-sealed (drained again) work that was already in the sink").toEqual(["final"]);
    const final = store.outputs.find((o) => o["gig_id"] === N && o["phase"] === "final");
    expect(final?.["input_shas"], "the final chair's provenance does not point at N's own rescan").toContain(nRescan!["content_sha"]);
  }, 30_000);
});
