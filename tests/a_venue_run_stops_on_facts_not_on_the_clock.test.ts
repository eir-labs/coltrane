// A VENUE RUN STOPS ON FACTS, NOT ON THE CLOCK.
// (docs/specs/gig-runs-once.red-spec.json — F1, F2, F3; founder's ruling of 3 Oct 2026)
//
// Measured 3 Oct 2026 on the eir-labs-inc box: gig 02e41dd7 (software-change-pr-v1, seven chairs) had
// sealed six chairs in 23 minutes when the drain's 25-minute run deadline fired and aborted the last,
// the pull-request chair, with the message "This operation was aborted" and no cause named. $5.96 of
// sealed work, no receipt. The deadline was a stand-in for a thirty-minute lease the store had moved to
// sixty on 26 Sep; a number in a comment had drifted from the fact it restated, and nothing between the
// two ever asked whether the run still held its lease or was still sealing chairs.
//
// The ruling: a run is never cut off because time passed. It stops only when a FACT says it must —
// its lease is lost (the store answers that another worker holds it: E4), its lease can no longer be
// SHOWN held (no renewal landed for a whole lease window: F2), its settled spend reached its budget
// (B1), or an abort door was used. Duration is not the ceiling; budget is, and any per-gig time belongs
// to the gig's own voicing and seating, not to the box.
//
// F1: a venue run has no run deadline. With COLTRANE_GIG_TIMEOUT_MS set far below the chair's own
//     duration, and the lease renewing normally, the gig COMPLETES; the worker says in its log that the
//     variable is set and not read, rather than silently ignoring it.
// F2: a lease that cannot be shown held ends the run. Renewals that fail to LAND (503, not a refusal)
//     for a whole HOSTED_LEASE_MS since the last confirmed grant abort the run as LeaseUnverifiable: the
//     in-flight chair's signal is aborted with the cause named, no further chair runs, and nothing
//     terminal is written — the gig may already be another worker's, exactly as for a lost lease.
// F3: the window is measured from the last renewal that LANDED, never from the claim. A run whose
//     renewals land, then fail twice, is still inside its confirmed lease and keeps running.
// F4: the window is measured from the instant the renewal was SENT, not the instant its answer landed.
//     The store grants from receipt; a landed renewal with round trip L confirms a lease already L
//     old. Measured from the response, a slow renewal lets the run outlive the store's lapse by L
//     (the non-author grade at 478a408, note 1: one extra beat on an edge-function cold start).
// F1b: the "set and NOT read" line is emitted only when the variable IS set — a log that fires
//     unconditionally says nothing (the grade's surviving plant M1).
//
// THE CLOCKS ARE INJECTED. WorkOnceDeps.scheduleHeartbeat is the heartbeat seam (the law fires `beat`
// from inside the chair: "time passed while the model worked"); WorkOnceDeps.now is the wall clock the
// lease window is measured on, so an hour passes without sleeping.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle, loadLease, GIG_ID, TERMINAL,
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

const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
/** A renewal that LANDED: the store answers the new lease_until, as coltrane_drain_renew does. */
const landed = () => new Response(JSON.stringify(new Date(Date.now() + 3_600_000).toISOString()), { status: 200, headers: { "content-type": "application/json" } });

let env: ReturnType<typeof hostedEnv>;
afterEach(() => {
  delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
  env?.cleanup();
});

describe("F1 — a venue run has no run deadline", () => {
  it("F1 with COLTRANE_GIG_TIMEOUT_MS far below the chair's duration and the lease renewing, the gig COMPLETES, and the log says the variable is set and not read", async () => {
    env = hostedEnv();
    process.env["COLTRANE_GIG_TIMEOUT_MS"] = "20";
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    const seam = heartbeatSeam();
    const lines: string[] = [];
    // A chair that takes longer than any deadline the environment names, and renews once meanwhile.
    const chair = vi.fn(async (ctx: AgentInvocationContext) => {
      await new Promise((r) => setTimeout(r, 120));
      for (const s of seam.scheduled) await s.beat();
      if (ctx.signal?.aborted) throw new Error(`chair stopped: ${String(ctx.signal.reason)}`);
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => chair as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
      log: (l: string) => { lines.push(l); },
    } as unknown as WorkOnceDeps);
    await settle();

    expect(chair, "precondition: the chair ran").toHaveBeenCalledTimes(1);
    expect(res.claimed && res.status, "a venue run was cut off by a clock: the deadline fired on a chair that was working and whose lease was renewing").toBe("complete");
    expect(store.renews().length, "precondition: the lease renewed while the chair worked").toBe(1);
    const terminal = store.headers().filter((c) => c.body["id"] === GIG_ID && TERMINAL.has(String(c.body["status"])));
    expect(terminal.map((c) => c.body["status"]), "the store must be told `completed`, and only that").toEqual(["completed"]);
    expect(lines.some((l) => /COLTRANE_GIG_TIMEOUT_MS=20 .*NOT read/i.test(l)),
      "the variable was set and the worker neither honoured it nor said so — a silent ignore is a second kind of drift").toBe(true);
  }, 20_000);
});

describe("F2 — a lease that cannot be shown held ends the run", () => {
  it("F2 renewals failing to LAND for a whole lease window abort the run as LeaseUnverifiable: the chair's signal names the cause, no further chair, nothing terminal written, result `abandoned`", async () => {
    env = hostedEnv();
    const { HOSTED_LEASE_MS } = await loadLease();
    const store = hostedStore({ claim: claimFor("two-chair-v0"), renew: () => unavailable() });
    const seam = heartbeatSeam();
    let t = 1_700_000_000_000;
    let reasonInChair = "";
    let beatsBeforeAbort = 0;
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => {
      // Three beats, a third of a lease apart: the first two are "tried again next beat"; at the
      // third a whole lease window has passed since the claim confirmed the lease.
      for (let i = 0; i < 3 && !ctx.signal?.aborted; i++) {
        t += HOSTED_LEASE_MS / 3;
        for (const s of seam.scheduled) await s.beat().catch(() => undefined);
        beatsBeforeAbort++;
      }
      if (ctx.signal?.aborted) {
        reasonInChair = String((ctx.signal.reason as Error)?.message ?? ctx.signal.reason);
        throw new Error(`chair stopped: ${reasonInChair}`);
      }
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
      now: () => t,
    } as unknown as WorkOnceDeps);
    await settle();

    // The drain service client retries a 5xx inside one beat, so the store sees several POSTs per beat;
    // the law counts BEATS (below) and asks only that renewal was genuinely attempted.
    expect(store.renews().length, "precondition: the heartbeat tried to renew").toBeGreaterThanOrEqual(3);
    expect(beatsBeforeAbort, "the run was stopped BEFORE a whole lease window had passed — that is a clock, not a fact").toBe(3);
    expect(reasonInChair, "the chair's signal was not aborted, or the cause was not named").toMatch(/no lease renewal landed for \d+ ms \(a full lease window\)/);
    expect(invoke, "a second chair ran on a gig whose lease cannot be shown held").toHaveBeenCalledTimes(1);
    expect(res.claimed && res.status, "a lease that cannot be shown held is a LeaseLost by evidence: the run ends abandoned").toBe("abandoned");
    expect(String((res as Record<string, unknown>)["error"])).toMatch(/no lease renewal landed/);
    const terminal = store.headers().filter((c) => c.body["id"] === GIG_ID && TERMINAL.has(String(c.body["status"])));
    expect(terminal, "a terminal header was written by a worker that cannot show it holds the gig").toEqual([]);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "the gig was reported failed by a worker that may no longer hold it").toBe(false);
  });
});

describe("F3 — the window is measured from the last renewal that LANDED", () => {
  it("F3 renewals that land, then fail twice, leave the run inside its confirmed lease: it keeps running and completes", async () => {
    env = hostedEnv();
    const { HOSTED_LEASE_MS } = await loadLease();
    let renewCalls = 0;
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      renew: () => (++renewCalls === 1 ? landed() : unavailable()),
    });
    const seam = heartbeatSeam();
    let t = 1_700_000_000_000;
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => {
      // +20 landed (confirmed at +20); +40 failed (20 since confirmed); +60 failed (40 since confirmed):
      // a whole window has passed since the CLAIM but not since the last grant.
      for (let i = 0; i < 3; i++) {
        t += HOSTED_LEASE_MS / 3;
        for (const s of seam.scheduled) await s.beat().catch(() => undefined);
      }
      if (ctx.signal?.aborted) throw new Error(`chair stopped: ${String(ctx.signal.reason)}`);
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
      now: () => t,
    } as unknown as WorkOnceDeps);
    await settle();

    expect(renewCalls, "precondition: renewals were attempted on every beat (a 5xx is retried within a beat, so more POSTs than beats)").toBeGreaterThanOrEqual(3);
    expect(res.claimed && res.status, "the window was measured from the claim, not from the last renewal that landed: a run inside its confirmed lease was stopped").toBe("complete");
  });
});

describe("F4 — the window is measured from the renewal's SEND instant, not its response", () => {
  it("F4 a landed renewal with round-trip latency L confirms a lease L old: a whole window later, measured from the send, the run is abandoned — never one beat past the store's lapse", async () => {
    env = hostedEnv();
    const { HOSTED_LEASE_MS } = await loadLease();
    const LATENCY = 5_000; // a slow landed renewal (an edge-function cold start)
    const CLAIMED_AT = 1_700_000_000_000;
    let t = CLAIMED_AT;
    let renewCalls = 0;
    const store = hostedStore({
      claim: claimFor("two-chair-v0"),
      // The first renewal lands, but slowly: the clock advances LATENCY between send and answer.
      renew: () => { renewCalls++; if (renewCalls === 1) { t += LATENCY; return landed(); } return unavailable(); },
    });
    const seam = heartbeatSeam();
    let beatsBeforeAbort = 0;
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => {
      // Beats fall on ABSOLUTE thirds of the lease from the claim (a real interval timer does not
      // drift by a slow answer). Beat 1 at +20m lands (sent at +20m, answered at +20m+L); beats 2, 3
      // fail; at beat 4 (+80m) a whole window has passed since the SEND of the landed renewal
      // (+20m → +80m), so the run must stop here. Measured from the RESPONSE (+20m+L) the gap is
      // 60m − L, and the run would wait one more beat — one beat past the store's lapse.
      for (let i = 1; i <= 5 && !ctx.signal?.aborted; i++) {
        t = CLAIMED_AT + i * (HOSTED_LEASE_MS / 3);
        for (const s of seam.scheduled) await s.beat().catch(() => undefined);
        if (!ctx.signal?.aborted) beatsBeforeAbort++;
      }
      if (ctx.signal?.aborted) throw new Error(`chair stopped: ${String((ctx.signal.reason as Error)?.message ?? ctx.signal.reason)}`);
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: seam.scheduleHeartbeat,
      now: () => t,
    } as unknown as WorkOnceDeps);
    await settle();

    expect(renewCalls, "precondition: the first renewal landed and the rest failed").toBeGreaterThanOrEqual(4);
    expect(res.claimed && res.status, "the run was not abandoned when the lease could no longer be shown held").toBe("abandoned");
    expect(beatsBeforeAbort, "the window was measured from the RESPONSE of the landed renewal: the run outlived the store's lapse by one beat").toBe(3);
  });
});

describe("F1b — the unread-variable line is said only when the variable is set", () => {
  it("F1b with COLTRANE_GIG_TIMEOUT_MS unset, a venue run logs no 'set and NOT read' line", async () => {
    env = hostedEnv();
    delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
    hostedStore({ claim: claimFor("one-chair-v0") });
    const lines: string[] = [];
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker,
      log: (l: string) => { lines.push(l); },
    } as unknown as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status).toBe("complete");
    expect(lines.some((l) => /NOT read/i.test(l)), "the line fired with nothing set — a log that always speaks says nothing").toBe(false);
  });
});
