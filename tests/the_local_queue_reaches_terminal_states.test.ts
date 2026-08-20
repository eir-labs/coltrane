// RED-first — a gig that FINISHED must be able to say so. Today it cannot, and the cost is a
// COMPLETED GIG RUNNING TWICE.
//
// THE SHAPE OF THE DEFECT. `openLocalQueue` declares six directories and maps each to a state:
//
//   dirsByState = [queued, claimed, parked→awaiting_approval, done→complete, failed, cancelled]
//
// Every verb writes into queued/, claimed/, parked/ or cancelled/. NOTHING EVER WRITES INTO done/ OR
// failed/. Two of the six states are unreachable — `list()` cannot return them, not because they were
// forbidden but because no transition arrives. That is this repo's own north star exactly: "a
// collector nothing calls… every one of those passed CI, because a test proves a mechanism WORKS and
// nothing was asking whether it is REACHED."
//
// WHY IT IS NOT COSMETIC. `complete()` records the seal IN PLACE and leaves the row in claimed/, with
// a deliberate comment saying a lapsed lease may then let a second worker re-run it, where the
// recorded content_sha will dedup the seal. The dedup is real — but it protects the LEDGER, not the
// WORK. `reap()` scans claimed/ and requeues anything whose lease has lapsed, and it has no idea the
// row is finished. So:
//
//     complete() → row stays in claimed/ → lease lapses → reap() requeues it → A WORKER RUNS THE
//     WHOLE GIG AGAIN — real model spend, real side effects, a second PR — and only THEN discovers
//     at the seal that the output already exists.
//
// "At-least-once with idempotent effect" is a fair contract for a SEAL. It is not a fair contract for
// an EXECUTION that opens pull requests and bills for inference. The seal being idempotent is what
// made this invisible: the ledger looks right afterwards.
//
// 34 laws cover this queue and none caught it, because each one tests a single verb in isolation.
// This defect lives in the JOIN between two correct verbs — complete() and reap() — which is the
// class the north star names: "what fails is the join between a mechanism and its caller."
//
// Laws T4/T5 are the non-vacuity controls: reap must still do its actual job (requeue a genuinely
// lapsed IN-FLIGHT claim) and the states that already worked must keep working. A fix that made
// reap() timid would pass T1–T3 and break the crash-recovery this queue exists for.
import { describe, it, expect, afterAll } from "vitest";
import { loadLocalQueue, freshRoot, cleanupRoots } from "./spec_local_queue_fixtures.js";

afterAll(cleanupRoots);

const LEASE_MS = 1000;
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("a finished gig can say so — the terminal states are reachable", () => {
  it("T1 — a COMPLETED gig is reported `complete`, not `claimed` forever", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.complete("w1", gig_id, { verdict: "pass" });

    const view = q.list().find((v) => v.gig_id === gig_id);
    expect(view, "the completed gig must still be listed").toBeDefined();
    // Before the fix this reads "claimed" — an operator running `coltrane work` sees a finished gig
    // as permanently in flight, and `done/` stays empty forever.
    expect(view!.state).toBe("complete");
  });

  it("T2 — reap() NEVER requeues a completed gig: the work does not run twice", async () => {
    // THE BUG THIS FILE EXISTS FOR (#465). The seal dedups; the RUN does not.
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.complete("w1", gig_id, { verdict: "pass" });

    clock.advance(LEASE_MS * 5); // the lease lapses long after the work finished
    const swept = q.reap();

    expect(swept.requeued, "a finished gig must never return to the queue").not.toContain(gig_id);
    expect(await q.claim("w2"), "and no worker may pick it up again").toBeNull();
  });

  it("T3 — a completed gig is not claimable, lease or no lease", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.complete("w1", gig_id, { verdict: "pass" });
    expect(await q.claim("w2")).toBeNull();
  });

  // ── NON-VACUITY CONTROLS ──────────────────────────────────────────────────────────────────────
  it("T4 — reap() STILL requeues a genuinely lapsed in-flight claim (crash recovery intact)", async () => {
    // The whole reason reap() exists. A fix that simply made it skip more rows would pass T1–T3 and
    // silently destroy the recovery this queue is for.
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1"); // claimed, never completed — the worker died
    clock.advance(LEASE_MS * 5);

    expect(q.reap().requeued, "an abandoned claim must come back").toContain(gig_id);
    const again = await q.claim("w2");
    expect(again?.gig_id).toBe(gig_id);
  });

  it("T5 — a FRESH claim is still never reaped, and park/cancel still land where they did", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const a = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    expect(q.reap().kept, "a live lease is untouched").toBe(1);

    await q.park("w1", a.gig_id);
    expect(q.list().find((v) => v.gig_id === a.gig_id)!.state).toBe("awaiting_approval");

    const b = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.cancel({ gig_id: b.gig_id });
    expect(q.list().find((v) => v.gig_id === b.gig_id)!.state).toBe("cancelled");
  });
});

describe("a failed gig is recorded, not left leased", () => {
  it("T6 — fail() is terminal: the row leaves claimed/, reads `failed`, and is never re-handed out", async () => {
    // There was no fail() at all. A local run that threw had nowhere to say so, so the row sat in
    // claimed/ until its lease lapsed and reap() handed the SAME doomed gig to the next worker — a
    // retry-a-poisoned-gig loop the hosted path avoids by recording the failure. `failed/` was a
    // declared state nothing could reach.
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");

    expect(await q.fail("w1", gig_id, "the standard threw")).toBe(true);
    expect(q.list().find((v) => v.gig_id === gig_id)!.state).toBe("failed");

    clock.advance(LEASE_MS * 5);
    expect(q.reap().requeued).not.toContain(gig_id);
    expect(await q.claim("w2"), "a failed gig is not re-handed to the next worker").toBeNull();
  });

  it("T7 — only the lease HOLDER may fail a gig", async () => {
    // The same check park() makes. Without it a stale worker could terminate a gig that had already
    // been reaped and handed to someone else — killing live work it no longer owns.
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    expect(await q.fail("w2", gig_id, "not mine to fail")).toBe(false);
    expect(q.list().find((v) => v.gig_id === gig_id)!.state).toBe("claimed");
  });
});
