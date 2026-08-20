// RED — the lease holds a residency singly, and a fencing token stops a resurrected host from
// double-answering. Closes the pause-resurrection hole the SPEC's row shape leaves open: lease_until
// + heartbeat_at alone cannot stop a GC/VM-paused old host from writing after expiry (Kleppmann,
// "How to do distributed locking"), so the contract ADDS a monotonic fencing/epoch token checked on
// every seal and heartbeat.
//
// Covers I8 (single activation — at most one host holds a residency in a live state) and I9
// (fencing is monotonic — a write below the highest-seen token is rejected stale_fence).
//
// RED because applyResidencyOp / the fence column live in the not-yet-authored src/residency.ts.
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import {
  loadResidency,
  resIn,
  canonicalOp,
  LIVE_STATES,
  type ResidencyModule,
  type ResidencyRecord,
} from "./spec_reside_fixtures.js";

let R: ResidencyModule;
beforeAll(async () => {
  R = await loadResidency();
});

describe("single activation — exactly one host holds a live residency (I8)", () => {
  it("I8 a second claim on a residency already live is refused (compare-and-set fails)", () => {
    // First host claims an unseated seat.
    const unseated = resIn("unseated", { host: null, session_id: null });
    const first = R.applyResidencyOp(unseated, { ...canonicalOp("claim", unseated), host: "box.A" });
    expect(first.ok, "the first claim on an unseated residency should win").toBe(true);
    if (!first.ok) return;
    expect(first.next.host).toBe("box.A");
    // Second host tries to claim the now-live residency — must be refused.
    const second = R.applyResidencyOp(first.next, { ...canonicalOp("claim", first.next), host: "box.B" });
    expect(second.ok, "a second host claimed a residency already held live").toBe(false);
    if (!second.ok) expect(second.reason).toBe("double_activation");
  });

  it("I8 MODEL: no op sequence ever puts a live residency into a host-less grip", () => {
    const claimArb = fc.record({ host: fc.constantFrom("box.A", "box.B", "box.C") });
    fc.assert(
      fc.property(fc.array(claimArb, { maxLength: 12 }), (claims) => {
        let rec = resIn("unseated", { host: null, session_id: null });
        for (const c of claims) {
          const r = R.applyResidencyOp(rec, { ...canonicalOp("claim", rec), host: c.host });
          if (r.ok) rec = r.next;
          // Whoever currently holds it, a live residency has a single host, never a shared/empty grip.
          if (LIVE_STATES.has(rec.status)) {
            expect(rec.host, "a live residency lost its single-host guarantee").not.toBeNull();
          }
        }
      }),
    );
  });
});

describe("fencing is monotonic — a resurrected host cannot double-answer (I9)", () => {
  it("I9 after a write at fence N, a write at fence < N is rejected stale_fence", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1000 }), fc.integer({ min: 1, max: 999 }), (n, delta) => {
        const rec: ResidencyRecord = resIn("listening", { fence: n });
        const lower = n - delta; // strictly below the highest-seen when delta > 0
        fc.pre(lower < n);
        const r = R.applyResidencyOp(rec, { ...canonicalOp("heartbeat", rec), fence: lower });
        expect(r.ok, `a write at fence ${lower} was accepted past highest-seen ${n}`).toBe(false);
        if (!r.ok) expect(r.reason).toBe("stale_fence");
      }),
    );
  });

  it("I9 a GC-paused old host resuming post-lease presents a stale token and is rejected", () => {
    // Current holder has advanced the fence to 5 (renewals under a live lease).
    const current = resIn("listening", { fence: 5, host: "box.A" });
    // The paused old host wakes carrying its stale fence 2 and tries to SEAL an utterance.
    const stale = R.applyResidencyOp(current, {
      ...canonicalOp("wake_seal", current),
      fence: 2,
      sealed_output_sha: "sha-from-the-dead",
    });
    expect(stale.ok, "a paused old host sealed past the fence").toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("stale_fence");
  });

  it("I9 a write at the current-or-higher fence is admitted (the token gates, does not freeze)", () => {
    const rec = resIn("listening", { fence: 3 });
    const r = R.applyResidencyOp(rec, { ...canonicalOp("heartbeat", rec), fence: 3 });
    expect(r.ok).toBe(true);
  });
});
