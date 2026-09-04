// RED — LAWS 2-6 of WI-3: the standing loop. One claim held, a reflex that cannot reach a model,
// a wake that must answer, a cursor that only moves behind a seal, and a redeploy that HANDS the
// seat over instead of racing for it.
import { describe, it, expect } from "vitest";
import {
  loadReside,
  recordingDeps,
  leaseClaim,
  msg,
  simClock,
  type ResideModule,
  type ResideDeps,
} from "./spec_reside_loop_fixtures.js";
import { loadResidency } from "./spec_reside_fixtures.js";

describe("LAW 2 — deps.claim is called once and HELD", () => {
  it("a second boot on the same instance does not claim again", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);

    const first = await r.boot();
    expect(first.ok).toBe(true);
    await r.boot();

    // TWO BOXES READING THE SAME ORDERS BOTH DISPATCH (plan, seam 3). The instance holds its seat;
    // it does not re-enter the claim door because someone called boot twice.
    expect(calls.claim, "reside claimed a second time instead of holding the seat it has").toBe(1);
  });

  it("a claim that returns null is 'nothing claimable' — not an error, and not a seat", async () => {
    const R: ResideModule = await loadReside();
    // Counted HERE, not on the recorder: overriding `claim` replaces the closure that counts, and a
    // law that asserted the recorder's zero would have been measuring its own stub.
    let claims = 0;
    const { deps } = recordingDeps({ claim: async () => { claims += 1; return null; } });
    const r = R.createResidency({ residency: "any" }, deps);
    const booted = await r.boot();
    expect(booted.ok, "an empty roster seated a residency anyway").toBe(false);
    if (!booted.ok) expect(booted.refusal).toBe("nothing_claimable");
    expect(claims, "the claim door was not entered").toBe(1);
  });
});

describe("LAW 3 — the reflex acks with NO model on the path", () => {
  it("an inbound message is acked and the cortex is never invoked", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();

    const ack = r.onInbound(msg("m1", 1));
    expect(ack.acked).toBe(true);
    expect(calls.cortex, "the reflex path reached a model — that is the one thing it may not do")
      .toBe(0);
    expect(r.inbox.map((m) => m.id), "the message was acked but never appended to the inbox")
      .toContain("m1");
  });

  it("onInbound is SYNCHRONOUS by construction — a path that cannot await cannot reach a model", async () => {
    const R: ResideModule = await loadReside();
    const { deps } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const ack: unknown = r.onInbound(msg("m1", 1));
    // The structural half of law 3. An async ack could quietly grow an `await cortex(...)` later
    // and every behavioural assertion above would still pass.
    expect(ack, "onInbound returned a thenable — the reflex can reach a model").not.toHaveProperty("then");
  });

  it("the ack lands inside the reflex budget under a SimClock", async () => {
    const R: ResideModule = await loadReside();
    const Res = await loadResidency();
    const clock = simClock();
    const { deps } = recordingDeps({ clock });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    const ack = r.onInbound(msg("m1", 1));
    expect(ack.elapsed_ticks).toBeLessThanOrEqual(Res.REFLEX_BUDGET_TICKS);
  });

  it("a message is acked even while the cortex is dead", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps({
      cortex: async () => { throw new Error("cortex is down"); },
    });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    // An UNACKED message means the listener is down — a pager fact. A busy or dead cortex is not
    // the listener, and must not be able to silence it.
    const ack = r.onInbound(msg("m1", 1));
    expect(ack.acked).toBe(true);
    expect(calls.cortex).toBe(0);
  });
});

describe("LAW 4 — a wake that produces no utterance is a REFUSAL", () => {
  async function wakeWith(turn: Record<string, unknown>): Promise<{ R: ResideModule; res: Awaited<ReturnType<ReturnType<ResideModule["createResidency"]>["wake"]>>; calls: ReturnType<typeof recordingDeps>["calls"] }> {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps({ cortex: async () => turn as never });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    r.onInbound(msg("m1", 1));
    return { R, res: await r.wake(), calls };
  }

  it("a turn with no utterance refuses 'silent_wake' rather than returning quietly", async () => {
    const { res } = await wakeWith({ utterance: null });
    expect(res.ok, "the wake consumed a message and answered nobody").toBe(false);
    if (!res.ok) expect(res.refusal).toBe("silent_wake");
  });

  it("a silent wake seals nothing and moves no cursor", async () => {
    const { calls } = await wakeWith({ utterance: null });
    // Fail CLOSED: a refused wake that had already advanced the cursor would drop the message it
    // failed to answer, and the loss would be invisible.
    expect(calls.cursorAdvance.length, "a refused wake advanced the cursor anyway").toBe(0);
    expect(calls.say.length).toBe(0);
  });

  it("a wake that DOES answer utters on the channel and succeeds", async () => {
    const { res, calls } = await wakeWith({ utterance: { channel_id: "chan.parlor", text: "answered" } });
    expect(res.ok).toBe(true);
    expect(calls.say.length, "the residency's voice is the channel; a wake that answers must utter")
      .toBe(1);
  });
});

describe("LAW 5 — the cursor moves only behind a seal, and never backwards", () => {
  it("cursorAdvance happens AFTER the seal, never before", async () => {
    const R: ResideModule = await loadReside();
    const { deps, tape } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    r.onInbound(msg("m1", 1));
    const res = await r.wake();
    expect(res.ok).toBe(true);

    const sealAt = tape.indexOf("sealOutput");
    const cursorAt = tape.findIndex((t) => t.startsWith("cursorAdvance"));
    expect(sealAt, "nothing was sealed on a successful wake").toBeGreaterThanOrEqual(0);
    expect(cursorAt, "the cursor never advanced on a successful wake").toBeGreaterThanOrEqual(0);
    // SEQUENCE, not occurrence. Both happening is not the law; the ORDER is the law.
    expect(cursorAt, "the cursor moved before the seal that earns it").toBeGreaterThan(sealAt);
  });

  it("a cursor that would move backwards is refused 'cursor_without_seal'", async () => {
    const R: ResideModule = await loadReside();
    // A claim resuming at cursor 5; a wake that would write 3 is a regression, not an advance.
    const { deps, calls } = recordingDeps({
      claim: async () => leaseClaim({ cursor: 5 }),
      cortex: async () => ({ utterance: { channel_id: "chan.parlor", text: "answered" }, sealed_output_sha: "sha-0" }),
    });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    r.onInbound(msg("m-old", 1));
    await r.wake();
    for (const call of calls.cursorAdvance) {
      expect(Number(call[1]), "the cursor was moved to a smaller value than the seat resumed at")
        .toBeGreaterThanOrEqual(5);
    }
  });
});

describe("LAW 6 — SIGTERM hands the seat over; it does not race for it", () => {
  it("SIGTERM calls release(id,'hibernated') exactly once", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    const booted = await r.boot();
    expect(booted.ok).toBe(true);

    await r.shutdown("SIGTERM");
    expect(calls.release.length, "a redeploy raced for the seat instead of handing it over").toBe(1);
    expect(calls.release[0]?.[1]).toBe("hibernated");
  });

  it("a second signal does not release twice", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.shutdown("SIGTERM");
    await r.shutdown("SIGINT");
    expect(calls.release.length).toBe(1);
  });

  it("the lease is NOT renewed after release", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.shutdown("SIGTERM");
    const beats = calls.heartbeat;
    await r.beat();
    // Renewing after handing the seat back is how two boxes come to believe they hold it.
    expect(calls.heartbeat, "the lease was renewed after the seat was released").toBe(beats);
  });

  it("SIGINT releases hibernated too — the session and cursor are already in the store", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps();
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.shutdown("SIGINT");
    expect(calls.release[0]?.[1]).toBe("hibernated");
  });

  it("shutdown before a successful boot releases nothing — there is no seat to hand over", async () => {
    const R: ResideModule = await loadReside();
    const { deps, calls } = recordingDeps({ claim: async () => null });
    const r = R.createResidency({ residency: "any" }, deps);
    await r.boot();
    await r.shutdown("SIGTERM");
    expect(calls.release.length, "released a seat it never held").toBe(0);
  });
});

// A guard on the seam itself: every member of ResideDeps that a law drives must be optional in the
// type AND named in a refusal when absent, or "no_backend names the seam" is unenforceable.
describe("the deps seam is injected, never imported", () => {
  it("createResidency takes its backends as an argument", async () => {
    const R: ResideModule = await loadReside();
    const empty: ResideDeps = {};
    const r = R.createResidency({ residency: "any" }, empty);
    const booted = await r.boot();
    expect(booted.ok).toBe(false);
    if (!booted.ok) {
      expect(booted.refusal).toBe("no_backend");
      expect(booted.seam, "an entirely unwired deployment did not name a seam").toBeTruthy();
    }
  });
});
