// E3 + E4 — A WORKER HOLDS ITS LEASE BY RENEWING IT, AND STOPS THE MOMENT IT LOSES IT.
// (docs/specs/gig-runs-once.red-spec.json)
//
// The store leases a claimed row for HOSTED_LEASE_MS and hands it to the next claimer when the lease
// expires. src/worker.ts has no heartbeat at all, so a gig that runs longer than the lease is
// silently re-claimed WHILE IT IS STILL RUNNING: two workers, one gig, two payments, and whichever
// finishes second overwrites the first. The run timeout (drainTimeoutMs, src/run_deps.ts) was meant
// to keep one gig under one lease, and its comment still believes the lease is thirty minutes.
//
// E3: while a gig runs, the worker renews through the drain service (coltrane_drain_renew, carrying
//     the claim's instance and gig id) every HOSTED_LEASE_MS / 3.
// E4: a renewal the store REFUSES (403 / 42501 — the lease is someone else's now) aborts the run:
//     no further chair, nothing further drained, and no terminal write by a worker that no longer
//     holds the row — the new holder owns the gig's truth.
//
// THE CLOCK IS INJECTED. WorkOnceDeps.scheduleHeartbeat(intervalMs, beat) => stop is the seam: the
// default arms a real (unref'd) interval; these laws capture the interval and fire `beat` from INSIDE
// the chair, which is exactly "time passed while the model was working" with no sleep at all.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, loadLease,
  GIG_ID, INSTANCE, DRAIN_KEY, TERMINAL,
} from "./gig_runs_once_fixtures.js";

type Beat = () => Promise<unknown>;
interface Scheduled { ms: number; beat: Beat; stopped: boolean }

function heartbeatSeam(): { scheduled: Scheduled[]; scheduleHeartbeat(ms: number, beat: Beat): () => void } {
  const scheduled: Scheduled[] = [];
  return {
    scheduled,
    scheduleHeartbeat(ms, beat) {
      const s: Scheduled = { ms, beat, stopped: false };
      scheduled.push(s);
      return () => { s.stopped = true; };
    },
  };
}

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("E3 — the heartbeat renews the lease while the gig runs", () => {
  it("E3 a heartbeat is armed before the first chair, every HOSTED_LEASE_MS/3, and renews with the claim's instance and gig id", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    const seam = heartbeatSeam();
    let armedAtFirstChair = -1;
    const invoke = vi.fn(async () => {
      armedAtFirstChair = seam.scheduled.length;
      // Time passes while the model works: one heartbeat interval elapses mid-chair.
      for (const s of seam.scheduled) await s.beat();
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
    } as unknown as WorkOnceDeps);
    expect(res.claimed && res.status).toBe("complete");

    expect(seam.scheduled.length, "no heartbeat was ever armed — a gig longer than the lease is re-claimed while it runs").toBe(1);
    expect(armedAtFirstChair, "the heartbeat was armed only AFTER the first chair started").toBe(1);
    const renews = store.renews();
    expect(renews.length, "the heartbeat fired but nothing renewed the lease").toBe(1);
    expect(renews[0]!.body["p_instance"], "renew must name the instance that holds the lease").toBe(INSTANCE);
    expect(renews[0]!.body["p_gig_id"], "renew must name the claimed gig").toBe(GIG_ID);
    expect(renews[0]!.headers["Authorization"], "renew speaks with the venue credential").toBe(`Bearer ${DRAIN_KEY}`);
    expect(renews[0]!.headers["X-Coltrane-Instance"]).toBe(INSTANCE);
    expect(seam.scheduled[0]!.stopped, "the heartbeat outlived the gig — a finished worker kept renewing a lease it no longer needs").toBe(true);

    const lease = await loadLease();
    expect(seam.scheduled[0]!.ms, "the heartbeat interval is a third of the ONE lease constant").toBe(lease.HOSTED_LEASE_MS / 3);
    expect(renews[0]!.path, "renew goes to the route the lease module names").toBe(lease.DRAIN_LEASE_ROUTES.renew);
  });

  it("E3 the route constant names the store's RPCs — the one place a store-side rename is changed", async () => {
    const { DRAIN_LEASE_ROUTES } = await loadLease();
    expect(DRAIN_LEASE_ROUTES.renew).toBe("/rest/v1/rpc/coltrane_drain_renew");
    expect(DRAIN_LEASE_ROUTES.release).toBe("/rest/v1/rpc/coltrane_drain_release");
  });
});

describe("E4 — a lost lease stops the run", () => {
  it("E4 a renew answered 403/42501 aborts the gig: no further chair, nothing further sealed or drained, no terminal write", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("two-chair-v0"),
      renew: () => new Response(JSON.stringify({ code: "42501", message: "lease not held by this instance" }), { status: 403 }),
    });
    const seam = heartbeatSeam();
    let renewSeqAtLoss = -1;
    let signalAbortedInChair = false;
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => {
      for (const s of seam.scheduled) await s.beat().catch(() => undefined);
      renewSeqAtLoss = store.renews()[0]?.seq ?? -1;
      // A real invoker honours the run's signal (the claude invoker kills its child on it). This one
      // does too, so the law asks only whether the lease loss REACHED the signal.
      signalAbortedInChair = ctx.signal?.aborted === true;
      if (ctx.signal?.aborted) throw new Error(`chair aborted: ${String(ctx.signal.reason)}`);
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
    } as unknown as WorkOnceDeps);
    await settle();

    expect(seam.scheduled.length, "no heartbeat was armed, so a lost lease could never be noticed").toBe(1);
    expect(renewSeqAtLoss, "the heartbeat did not call renew").toBeGreaterThanOrEqual(0);
    expect(signalAbortedInChair, "the store said the lease is gone and the run's signal was never aborted").toBe(true);
    expect(invoke, "a second chair ran on a gig this worker no longer holds").toHaveBeenCalledTimes(1);

    const drainedAfter = store.calls.filter((c) => c.seq > renewSeqAtLoss && c.host === "drain" &&
      (c.path === "/rest/v1/coltrane_outputs" || c.path.startsWith("/storage/v1/object/")));
    expect(drainedAfter.map((c) => c.path), "outputs were drained after the lease was lost").toEqual([]);
    expect(sealedLocally(env.stateRoot, GIG_ID), "outputs were sealed after the lease was lost").toEqual([]);

    const terminal = store.headers().filter((c) => TERMINAL.has(String(c.body["status"])));
    expect(terminal.map((c) => c.body["status"]), "a worker that lost the lease wrote the gig's terminal header").toEqual([]);
    expect(store.calls.some((c) => c.host === "store" && c.path.endsWith("/coltrane_mcp_gig_fail")),
      "a worker that lost the lease FAILED a gig another worker now holds").toBe(false);
    expect(store.releases().filter((c) => c.body["p_terminal"] === true), "a worker that lost the lease terminally released the row").toEqual([]);

    expect(res.claimed && res.status, "a run stopped by a lost lease is not a completion").not.toBe("complete");
    expect(JSON.stringify(res), "the result must say WHY it stopped").toMatch(/lease/i);
  });
});
