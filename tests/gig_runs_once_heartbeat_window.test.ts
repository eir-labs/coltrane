// G1 — THE HEARTBEAT HOLDS THE LEASE UNTIL THE STORE HAS THE OUTCOME. (docs/specs/gig-runs-once.red-spec.json)
//
// E3 arms a heartbeat while chairs run. The lease matters just as much AFTER the last chair: sealing,
// the output acknowledgements (E9) and the terminal header's retries (E2) all happen while this
// worker still claims to hold the row. A heartbeat that is disarmed "because the outcome is decided"
// leaves exactly that window unguarded. If the lease lapses there, the store hands the row to a
// second worker while the first one is still telling the store how the gig ended.
//
// The ruling (conductor, G1): the heartbeat stays armed until the terminal header has been
// acknowledged or its retries are exhausted, and only then is the stop called. A renew refused inside
// that window is a lost lease like any other (E4): the terminal write is suppressed, because the row
// belongs to someone else now.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, lateAck, settle, TERMINAL,
} from "./gig_runs_once_fixtures.js";

type Beat = () => Promise<unknown>;
interface Scheduled { ms: number; beat: Beat; stopped: boolean; stoppedWhenAcked?: boolean }

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("G1 — the heartbeat stays armed through sealing, output acks and the terminal header", () => {
  it("G1a the heartbeat's stop is called only AFTER the terminal header was acknowledged", async () => {
    env = hostedEnv();
    const ack = { done: false };
    hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "completed" ? lateAck(ack, 80) : undefined),
    });
    const scheduled: Scheduled[] = [];
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker,
      scheduleHeartbeat: (ms: number, beat: Beat) => {
        const s: Scheduled = { ms, beat, stopped: false };
        scheduled.push(s);
        return () => { s.stopped = true; s.stoppedWhenAcked ??= ack.done; };
      },
    } as unknown as WorkOnceDeps);
    expect(res.claimed && res.status).toBe("complete");
    expect(scheduled.length, "no heartbeat was armed at all (E3 first)").toBe(1);
    expect(scheduled[0]!.stopped, "the heartbeat was never stopped").toBe(true);
    expect(scheduled[0]!.stoppedWhenAcked,
      "the heartbeat was disarmed while the terminal header was still unacknowledged, which left the lease unguarded").toBe(true);
  });

  it("G1b a renew refused AFTER the last chair but before the completion is acknowledged suppresses the terminal write", async () => {
    env = hostedEnv();
    const scheduled: Scheduled[] = [];
    let beatFiredAfterChairs = false;
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      renew: () => new Response(JSON.stringify({ code: "42501", message: "lease not held by this instance" }), { status: 403 }),
      // Hold the output row's acknowledgement back. The chairs are finished and the outcome is
      // decided, and this is the window the ruling says the heartbeat still covers. Time passes
      // here, a beat fires, and the store answers that the lease is gone.
      outputs: () => (async () => {
        await settle(60);
        const s = scheduled[0];
        if (s && !s.stopped) { beatFiredAfterChairs = true; await s.beat().catch(() => undefined); }
        return new Response("null", { status: 201 });
      })(),
    });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: (ms: number, beat: Beat) => {
        const s: Scheduled = { ms, beat, stopped: false };
        scheduled.push(s);
        return () => { s.stopped = true; };
      },
    } as unknown as WorkOnceDeps);
    await settle();

    expect(scheduled.length, "no heartbeat was armed at all (E3 first)").toBe(1);
    expect(beatFiredAfterChairs, "the heartbeat was already disarmed while the output was still unacknowledged").toBe(true);
    expect(store.renews().length).toBeGreaterThanOrEqual(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.headers().filter((c) => TERMINAL.has(String(c.body["status"]))).map((c) => c.body["status"]),
      "the lease was lost after the last chair, and the worker still wrote the gig's terminal header").toEqual([]);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "a worker that lost the lease failed the gig").toBe(false);
    expect(store.releases().filter((c) => c.body["p_terminal"] === true), "a worker that lost the lease terminally released the row").toEqual([]);
    expect(res.claimed && res.status, "a run whose lease was lost before its completion was acknowledged is not a completion").not.toBe("complete");
    expect(JSON.stringify(res)).toMatch(/lease/i);
  });
});
