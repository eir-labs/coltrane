// G4 (hosted half): A CLAIM THAT RESUMES A CLOSED GIG RUNS UNDER ITS OWN ID. (docs/specs/gig-runs-once.red-spec.json)
//
// On the hosted path, gig_dispatch({resume_gig_id}) queues through deps.queueGig. The STORE creates
// the new row, gives it its own id and lease, and, with eir-labs/coltrane-ui #250, hands back
// `resumes: <old id | null>` on the claim. The engine has no field for it today:
//   * ClaimedGig (src/worker.ts) does not declare it;
//   * workOnce resumes only from a checkpoint keyed by claim.gig_id;
//   * rebuildFromDrain asks the sink about claim.gig_id.
// So the link is dropped and the new gig runs COLD, paying again for every chair the closed gig
// already sealed.
//
// Founder ruling (Eugene): "what's closed is closed. can refer to the sealed outputs on input if
// needed but reopening doesn't smell right."
//
// The law: when a claim carries `resumes: <old id>`, workOnce
//   * runs under the CLAIM's own id;
//   * fetches the old gig's sealed outputs through the drain (coltrane_mcp_gig_outputs for the old id);
//   * uses them as INPUTS BY REFERENCE: their content_sha appears in the new outputs' input_shas, and
//     they are never re-sealed;
//   * invokes no chair whose output the old gig already sealed;
//   * writes nothing under the old id: no header, no output row, no gig_fail, no release.
//
// The closed gig is produced END TO END through the same stateful store: worker A runs it and it
// FAILS at its second chair, after the first chair's output drained and was acknowledged.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, GIG_ID,
} from "./gig_runs_once_fixtures.js";

const OLD = GIG_ID;
const NEW = "12121212-3434-5656-7878-909090909090";

let env: ReturnType<typeof hostedEnv>;
const extraRoots: string[] = [];
afterEach(() => {
  env?.cleanup();
  for (const r of extraRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("G4 hosted: a claim carrying `resumes` runs under its own id, the closed gig's seals as inputs", () => {
  it("G4h a claim with `resumes: <old id>` invokes only the unsealed chair, cites the old seal in input_shas, never re-seals it, and writes nothing under the old id", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0") });

    // Worker A, on its own state root: scan seals and drains, then rescan FAILS. The old gig is closed.
    const rootA = mkdtempSync(join(tmpdir(), "coltrane-claim-resumes-A-"));
    extraRoots.push(rootA);
    const rootB = process.env["COLTRANE_WORKER_CHECKPOINTS"];
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = rootA;
    const invokeA = vi.fn(async (ctx: AgentInvocationContext) => {
      if (ctx.phase === "rescan") throw new Error("rescan broke");
      return sealableSignal;
    });
    try {
      const a = await workOnce(venueCtx(), { makeInvoke: () => invokeA as unknown as AgentInvoker } as WorkOnceDeps);
      expect(a.claimed && a.status, "precondition: the old gig ends failed").toBe("failed");
    } finally {
      process.env["COLTRANE_WORKER_CHECKPOINTS"] = rootB;
    }
    await settle();
    const oldScan = store.outputs.find((o) => o["gig_id"] === OLD);
    expect(oldScan, "precondition: the old gig's scan output is in the sink").toBeDefined();

    // The resume, dispatched and queued: a NEW row, with its own id, carrying `resumes`.
    store.set({ claim: claimFor("two-chair-v0", { gig_id: NEW, resumes: OLD }) });
    const callsBefore = store.calls.length;
    const phases: string[] = [];
    const invokeB = vi.fn(async (ctx: AgentInvocationContext) => { phases.push(ctx.phase); return sealableSignal; });
    const lines: string[] = [];
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invokeB as unknown as AgentInvoker, log: (l: string) => lines.push(l),
    } as WorkOnceDeps);
    await settle();

    expect(res.claimed && res.gig_id, "the run must be the CLAIM's own gig").toBe(NEW);
    expect(res.claimed && res.status, `the resumed gig must complete:\n${lines.join("\n")}`).toBe("complete");
    expect(phases, `a chair the closed gig already sealed was paid for again, which means \`resumes\` was ignored and the gig ran cold:\n${lines.join("\n")}`).toEqual(["rescan"]);

    const second = store.calls.slice(callsBefore);
    expect(second.some((c) => c.host === "store" && c.path.endsWith("/coltrane_mcp_gig_outputs") && c.body["p_gig"] === OLD),
      "the closed gig's seals were never fetched through the drain").toBe(true);
    const writesUnderOld = second.filter((c) =>
      (c.host === "drain" && c.path === "/rest/v1/coltrane_gigs" && c.body["id"] === OLD) ||
      (c.host === "drain" && c.path === "/rest/v1/coltrane_outputs" && c.body["gig_id"] === OLD) ||
      (c.host === "drain" && c.path.endsWith("/coltrane_drain_release") && c.body["p_gig_id"] === OLD) ||
      (c.host === "store" && c.path.endsWith("/coltrane_mcp_gig_fail") && c.body["p_gig"] === OLD));
    expect(writesUnderOld.map((c) => c.path), "the resuming worker wrote under the CLOSED gig's id").toEqual([]);

    // What's closed is closed: the old scan enters by reference and is never re-sealed.
    const newRows = store.outputs.filter((o) => o["gig_id"] === NEW);
    expect(newRows.filter((o) => o["content_sha"] === oldScan!["content_sha"] || o["id"] === oldScan!["id"]).length,
      "the closed gig's scan was RE-SEALED as the new gig's own work").toBe(0);
    expect(sealedLocally(env.stateRoot, NEW).filter((o) => o["phase"] === "scan").length,
      "the closed gig's scan was re-sealed locally under the new gig").toBe(0);
    const rescan = newRows.find((o) => o["phase"] === "rescan");
    expect(rescan, "the new gig sealed no rescan").toBeDefined();
    expect(rescan!["input_shas"], "the new rescan's provenance does not point at the closed gig's seal").toContain(oldScan!["content_sha"]);
  }, 30_000);
});
