// G4 (engine half) — A COLD RUN AFTER A REFUSED EXPLICIT RESUME IS A NEW GIG. (docs/specs/gig-runs-once.red-spec.json)
//
// WHERE AN EXPLICIT RESUME IS REQUESTED TODAY. There are two doors:
//   1. gig_dispatch({ resume_gig_id }) on the MCP surface (src/server.ts, `resumeArg`), which is
//      also what `coltrane dispatch --resume <id>` sends (src/cli.ts). On ResumeRefused this door
//      REFUSES and runs nothing: `{ ok:false, data:{ resume_refused, drift } }`, already pinned by
//      tests/resume_reuse_dispatch.test.ts ("a refused resume comes back as a refusal ... not as a
//      silent cold run"). No cold run follows a refused resume there, so it neither re-opens the old
//      gig nor needs a new one. G4 holds at that door today and is not restated here.
//   2. gig_approve: the approval writes the verdict onto the parked row and re-queues it, and the
//      drain's re-claim hands the approvals back on the claim. That approval IS the explicit request
//      to resume the parked gig. At this door, workOnce falls back to a COLD run on ResumeRefused
//      (src/worker.ts, `resume refused for … — running it COLD`) UNDER THE OLD GIG'S ID. The old
//      gig is re-opened, and its sealed outputs and the cold run's outputs end up interleaved under
//      one id, which output_trace then reports as one run.
//
// Ruling (conductor, G4): the cold run writes a NEW gig carrying `resumes: <old id>` and never
// re-opens the old one. This law drives door 2, the only place in the engine where a cold run
// follows a refused resume.
//
// Scenario: the gig parks at its human chair (a model chair already sealed). The approval re-queues
// it with a CHANGED payload, so the resume gate refuses (gig_input_sha moved) and the run goes cold.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, VERDICT, GIG_ID,
} from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

const resumesOf = (body: Record<string, unknown>): unknown =>
  body["resumes"] ?? (body["manifest"] as Record<string, unknown> | undefined)?.["resumes"];

describe("G4 — a cold run after a refused, explicitly requested resume is a new gig", () => {
  it("G4 an APPROVED re-claim whose resume is refused runs cold as a NEW gig carrying `resumes: <old id>`, and never re-opens the old one", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("scan-then-approve-v0") });
    const invoke = vi.fn(async () => sealableSignal);
    const deps = { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps;

    const parked = await workOnce(venueCtx(), deps);
    expect(parked.claimed && parked.status, "precondition: the gig parks at its human chair").toBe("awaiting_approval");
    await settle();
    const oldSealed = sealedLocally(env.stateRoot, GIG_ID).length;
    const callsBefore = store.calls.length;

    // The approval re-queues the row, and the payload has moved, so the resume will be refused.
    store.set({
      claim: claimFor("scan-then-approve-v0", {
        input: { subject: "a different wire" },
        approvals: { approve: { verdict: VERDICT, approved_by: "eugene" } },
      }),
    });
    const lines: string[] = [];
    const res = await workOnce(venueCtx(), { ...deps, log: (l: string) => lines.push(l) } as WorkOnceDeps);
    await settle();
    expect(invoke, `precondition: the refused resume ran COLD (the model chair ran again):\n${lines.join("\n")}`).toHaveBeenCalledTimes(2);

    const second = store.calls.slice(callsBefore);
    const headers = second.filter((c) => c.host === "drain" && c.path === "/rest/v1/coltrane_gigs");
    const linked = headers.filter((c) => resumesOf(c.body) === GIG_ID);
    expect(linked.length, "no header of the cold run says which gig it resumes (`resumes: <old id>`)").toBeGreaterThan(0);
    const newId = String(linked[0]!.body["id"]);
    expect(newId, "the cold run re-used the OLD gig's id: it re-opened the gig it was refused permission to resume").not.toBe(GIG_ID);

    expect(headers.filter((c) => c.body["id"] === GIG_ID && ["running", "completed"].includes(String(c.body["status"]))).map((c) => c.body["status"]),
      "the cold run wrote running/completed headers onto the OLD gig").toEqual([]);
    expect(second.filter((c) => c.host === "drain" && c.path === "/rest/v1/coltrane_outputs" && c.body["gig_id"] === GIG_ID).length,
      "the cold run drained its outputs under the OLD gig's id").toBe(0);
    expect(sealedLocally(env.stateRoot, GIG_ID).length, "the cold run sealed into the OLD gig").toBe(oldSealed);
    expect(sealedLocally(env.stateRoot, newId).length, "the cold run's outputs belong to the NEW gig").toBeGreaterThan(0);
    expect(JSON.stringify(res), "the result must name the new gig").toContain(newId);
  }, 20_000);
});
