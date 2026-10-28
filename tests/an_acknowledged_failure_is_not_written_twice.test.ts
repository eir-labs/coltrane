// RR-6(b) — drain:the-failure-is-written-once (wiki spec.coltrane.the-red-pass-runs-in-its-room, rev 3 as corrected).
//
// Gig 3243a92c ended refused, and the store recorded it: its act ledger shows `running → failed` at 17:56:11 through the drain
// service's header, with the refusal reason. The worker then sent a SECOND terminal write (coltrane_mcp_gig_fail), which the
// store refused because the gig was no longer running ("only-live-admits: the credential is lapsed" — the lease is not held by a
// finished gig), tried a terminal release that was refused too, and logged "could not record failure … the row is held until its
// lease lapses": false, and it sent two reviewers down the clock path. Once the failed header is acknowledged, nothing further is
// owed: no gig_fail, no release, and the log says the failure landed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, settle, GIG_ID } from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

async function run(header?: Parameters<typeof hostedStore>[0]["header"]) {
  env = hostedEnv();
  const store = hostedStore({ claim: claimFor("one-chair-v0"), header });
  const chair = vi.fn(async () => { throw new Error("gig refused: the chair could not do its work"); });
  const lines: string[] = [];
  const res = await workOnce(venueCtx(), { makeInvoke: () => chair as unknown as AgentInvoker, log: (l: string) => lines.push(l) } as WorkOnceDeps);
  await settle();
  return { res: res as Record<string, unknown>, store, log: lines.join("\n") };
}

describe("RR-6(b) — an acknowledged failure is written once", () => {
  it("plant (3243a92c's shape) — the failed header lands: no coltrane_mcp_gig_fail, no terminal release, and the log says it landed", async () => {
    const d = await run();
    expect(d.res["status"]).toBe("failed");
    expect(d.store.gigs.get(GIG_ID)?.["status"], "precondition: the failed header was acknowledged").toBe("failed");
    expect(d.store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "a second terminal write after the acknowledged header").toBe(false);
    expect(d.store.calls.some((c) => c.path.endsWith("/coltrane_drain_release") && c.body["p_terminal"] === true), "a terminal release after the acknowledged header").toBe(false);
    expect(d.res["acknowledged"]).toBe(true);
    expect(d.log).toMatch(/failed header landed/);
    expect(d.log).not.toMatch(/could not record failure/);
  });

  it("twin, must be KEPT — the failed header is NOT acknowledged: gig_fail is still sent, as the fallback it is", async () => {
    const d = await run((b) => (b["status"] === "failed" ? new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 }) : undefined));
    expect(d.store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "an unacknowledged failure lost its fallback").toBe(true);
  });
});
