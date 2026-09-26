// E7 — ONLY THE LEASE HOLDER MAY COMPLETE A LOCAL GIG. (docs/specs/gig-runs-once.red-spec.json)
//
// The file-backed queue (src/local_queue.ts) checks the holder on heartbeat, park and fail — "so a
// stale worker cannot terminate a gig that has already been reaped and handed to someone else" — and
// NOT on complete(). So the worker whose lease lapsed, and whose gig the reaper handed to a second
// worker, can still complete it: its output becomes THE gig's output and the row moves to done/ under
// the new holder, who is still running it. Two runs, and the one that won is the one that lost the
// lease. The hosted store is adding the same guard to its terminal writes; the local sibling must
// agree with it about what a lease means.
import { describe, it, expect, afterAll } from "vitest";
import { loadLocalQueue, freshRoot, cleanupRoots } from "./spec_local_queue_fixtures.js";

afterAll(cleanupRoots);
const LEASE_MS = 1000;

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("E7 — the local queue refuses a completion from a worker that does not hold the lease", () => {
  it("E7 a stale worker (lease lapsed, gig reaped and re-claimed) cannot complete it; the new holder still can", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    expect(await q.claim("w1")).not.toBeNull();
    clock.advance(LEASE_MS + 1);
    expect(q.reap().requeued).toContain(gig_id);
    expect((await q.claim("w2"))?.gig_id).toBe(gig_id);

    const stale = await q.complete("w1", gig_id, { verdict: "from the worker that lost the lease" }).then(
      () => "accepted",
      () => "refused",
    );
    expect(stale, "complete() accepted a seal from a worker that no longer holds the lease").toBe("refused");
    const view = q.list().find((v) => v.gig_id === gig_id)!;
    expect(view.state, "the stale completion moved the row out from under its live holder").toBe("claimed");
    expect(view.holder).toBe("w2");
    expect(view.content_sha, "the stale worker's output was recorded as the gig's").toBeUndefined();

    // Non-vacuity: the refusal is about WHO, not a complete() that refuses everything.
    const sealed = await q.complete("w2", gig_id, { verdict: "from the holder" });
    expect(sealed.duplicated).toBe(false);
    expect(q.list().find((v) => v.gig_id === gig_id)!.state).toBe("complete");
  });

  it("E7 a stale holder cannot complete a row that was REQUEUED (lease lapsed and reaped, not yet re-claimed)", async () => {
    // A row back in queued/ still carries its stale lease record, so a holder-name check alone
    // admits its old holder. Only the state-directory half of the check (the row must be in claimed/
    // or done/) refuses it. Without that half, the old holder's output becomes the gig's while the
    // row sits in the queue for the next worker to run again.
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    expect(await q.claim("w1")).not.toBeNull();
    clock.advance(LEASE_MS + 1);
    expect(q.reap().requeued, "precondition: the lapsed claim went back to the queue").toContain(gig_id);
    expect(q.list().find((v) => v.gig_id === gig_id)!.state).toBe("queued");

    const stale = await q.complete("w1", gig_id, { verdict: "from the lapsed holder" }).then(() => "accepted", () => "refused");
    expect(stale, "complete() accepted a seal from the lapsed holder of a REQUEUED row").toBe("refused");
    const view = q.list().find((v) => v.gig_id === gig_id)!;
    expect(view.state, "the stale completion moved a queued row out of the queue").toBe("queued");
    expect(view.content_sha, "the stale holder's output was recorded as the gig's").toBeUndefined();
  });

  it("E7 a worker that never held the gig cannot complete it", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const outcome = await q.complete("intruder", gig_id, { verdict: "x" }).then(() => "accepted", () => "refused");
    expect(outcome, "complete() accepted a seal from a worker that never held the lease").toBe("refused");
    expect(q.list().find((v) => v.gig_id === gig_id)!.state).toBe("claimed");
  });
});
