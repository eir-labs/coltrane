// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — committed RED on purpose. See docs/specs/SPEC-local-queue-contract.md.
// A failure here is a feature not yet built (`src/local_queue.ts`); a failure in any file NOT named
// spec_* is a regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// RE-CLAIM WITH VERDICTS, PARK, IDEMPOTENT EFFECT, CANCEL, and PARTIAL-WRITE SAFETY.
//
// A gig that parks at a human chair must be re-claimable with its verdicts, matching the drain's
// park->approve->re-claim path (worker.ts parkGig :446, ClaimedGig.approvals :116, approvalWiring).
// The local queue has NO cloud sink — the file root IS both store and sink — so the local park must
// write role-keyed verdicts where the local re-claim reads them. And because a lapsed lease can let
// a second worker re-run a gig (at-least-once, not true exactly-once), the effect must be
// idempotent: a re-run re-seals the SAME output (content_sha dedup, worker.ts lineage) rather than
// duplicating, and a re-run that would produce a DIFFERENT output fails closed rather than forking.
import { describe, it, expect, afterAll } from "vitest";
import fc from "fast-check";
import { loadLocalQueue, freshRoot, cleanupRoots, gigPayloadArb, type ClaimedLocalGig } from "./spec_local_queue_fixtures.js";
import type { ToolSurfaceDeps } from "../src/server.js";

afterAll(cleanupRoots);

const LEASE_MS = 1000;
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe("local queue — park then approve then re-claim carries verdicts (I12, I13, F6)", () => {
  // I12 — the re-claim of an approved parked gig carries the prior verdicts keyed by chair role, and
  // each entry keeps who approved it (the approval seals under the approving principal's name, not
  // the worker's — worker.ts:120-122). Mirrors approvalWiring's role-keyed shape.
  it("I12 an approved re-claim exposes the role-keyed verdicts the park recorded", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    expect(await q.park("w1", gig_id), "park must record the awaiting_approval state").toBe(true);
    const verdict = { decision: "approved", note: "looks right" };
    expect(await q.approve(gig_id, "reviewer", verdict, "governor@example.com")).toBe(true);

    const reclaimed = await q.claim("w2");
    expect(reclaimed, "an approved parked gig must be re-claimable").not.toBeNull();
    expect(reclaimed!.gig_id).toBe(gig_id);
    const approvals = reclaimed!.approvals ?? {};
    expect(approvals["reviewer"]?.verdict, "the human verdict did not survive the re-claim").toEqual(verdict);
    expect(approvals["reviewer"]?.approved_by, "the approving principal was lost").toBe("governor@example.com");
  });

  // I13 — PARK CLEARS THE LEASE. awaiting_approval is not a live claim, so the reaper must never
  // treat a parked gig as an abandoned claim to return to queued (mirrors parkGig clearing the lease
  // so the approve RPC can re-queue at once — worker.ts:436-459). A parked gig, even after the lease
  // window elapses, stays awaiting_approval — it is NOT re-queued by lapse.
  it("I13 a parked gig has no live lease and is never re-queued by lease lapse", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.park("w1", gig_id);
    expect(q.list().find((r) => r.gig_id === gig_id)!.state).toBe("awaiting_approval");
    clock.advance(10 * LEASE_MS); // long human delay
    q.reap();
    expect(
      q.list().find((r) => r.gig_id === gig_id)!.state,
      "the reaper mistook a parked gig for an abandoned claim",
    ).toBe("awaiting_approval");
  });

  // F6 — fail closed on approval integrity. A parked gig is NOT claimable until a verdict is
  // recorded (never silently resume past a human chair with no approval), and recording an EMPTY
  // verdict is refused rather than accepted as an approval.
  it("F6 a parked-but-unapproved gig is not claimable, and an empty verdict is refused", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.park("w1", gig_id);
    expect(await q.claim("w2"), "a parked gig with no verdict resumed past the human chair").toBeNull();
    await expect(q.approve(gig_id, "reviewer", {}, "governor@example.com"), "an empty verdict is not an approval")
      .rejects.toThrow();
  });
});

describe("local queue — idempotent effect on re-run (I14, F9)", () => {
  // I14 — at-least-once + idempotent-effect. When a lapsed lease lets a second worker re-run a gig,
  // completing with the SAME output re-seals it (same content_sha) rather than duplicating — the
  // second seal reports duplicated:true. Grounded in coltrane's content_sha dedup (worker.ts).
  it("I14 re-completing a gig with the same output dedups (same content_sha, duplicated:true)", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    const output = { data: { verdict: "met", n: 3 } };
    const first = await q.complete("w1", gig_id, output);
    expect(first.duplicated).toBe(false);

    // w1 "crashed" after sealing but before recording done; the lease lapses and w2 re-runs it.
    clock.advance(LEASE_MS + 1);
    q.reap();
    const c2 = await q.claim("w2");
    expect(c2, "the lapsed gig must be re-claimable for the re-run").not.toBeNull();
    const second = await q.complete("w2", gig_id, output);
    expect(second.content_sha, "the same output must seal to the same content_sha").toBe(first.content_sha);
    expect(second.duplicated, "the re-run duplicated an output instead of deduping").toBe(true);
  });

  // I14 property — content_sha is a pure function of the output: identical outputs always share it,
  // so dedup is well-defined regardless of which worker sealed.
  it("I14 identical outputs always seal to identical content_sha", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), async (data) => {
        const q1 = openLocalQueue(freshRoot());
        const q2 = openLocalQueue(freshRoot());
        const { gig_id: g1 } = await q1.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
        const { gig_id: g2 } = await q2.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
        await q1.claim("w1"); await q2.claim("w1");
        const a = await q1.complete("w1", g1, { data });
        const b = await q2.complete("w1", g2, { data });
        expect(a.content_sha).toBe(b.content_sha);
      }),
      { numRuns: 25 },
    );
  });

  // F9 — if a re-run cannot be guaranteed idempotent (it would seal a DIFFERENT output for the same
  // gig), it must refuse rather than duplicate/fork outputs. Fail closed, not two conflicting seals.
  it("F9 re-completing a gig with a DIFFERENT output is refused, not forked", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    await q.complete("w1", gig_id, { data: { verdict: "met" } });
    await expect(
      q.complete("w1", gig_id, { data: { verdict: "NOT met" } }),
      "a divergent re-run must fail closed rather than fork the sealed output",
    ).rejects.toThrow();
  });
});

describe("local queue — cancel a queued gig (I18)", () => {
  // I18 — cancelling a queued gig removes it from queued so it can never be claimed. Sibling of
  // postgrestCancelGig (genome_store.ts:577), same {gig_id, status:'cancelled'} shape.
  it("I18 a cancelled queued gig is never claimed and returns the cancelled shape", async () => {
    const { openLocalQueue, fileCancelGig } = await loadLocalQueue();
    const root = freshRoot();
    const q = openLocalQueue(root);
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    const out = await fileCancelGig(root)({ gig_id });
    expect(Object.keys(out).sort()).toEqual(["gig_id", "status"]);
    expect(out["status"]).toBe("cancelled");
    expect(out["gig_id"]).toBe(gig_id);
    expect(await q.claim("w1"), "a cancelled gig was still claimable").toBeNull();
  });

  // I18 wired — the cancel seam is assignable exactly where deps.cancelGig plugs in (server.ts:3073).
  it("I18 the cancel seam is assignable to ToolSurfaceDeps.cancelGig", async () => {
    const { fileCancelGig } = await loadLocalQueue();
    const seam: ToolSurfaceDeps["cancelGig"] = fileCancelGig(freshRoot());
    expect(seam).toBeTypeOf("function");
  });
});

describe("local queue — a claim never serves a partial write (F4)", () => {
  // F4 — enqueue is atomic: a claim only ever returns a fully-committed, runnable row, never a
  // half-written one. Asserted observably over interleaved enqueue/claim: every claimed row has the
  // fields a worker needs to run (standard_slug, input, acting_for), so no partial row is ever served.
  it("F4 every claimed row is complete and runnable, never a partial", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.array(gigPayloadArb, { minLength: 1, maxLength: 8 }), async (payloads) => {
        const q = openLocalQueue(freshRoot());
        // Interleave enqueues and claims concurrently — the reader must never catch a mid-write row.
        const claims: Promise<ClaimedLocalGig | null>[] = [];
        for (const p of payloads) {
          void q.enqueue(p);
          claims.push(q.claim("w1"));
        }
        for (const c of await Promise.all(claims)) {
          if (c === null) continue;
          expect(typeof c.standard_slug, "a claimed row missing standard_slug is a partial write").toBe("string");
          expect(c.standard_slug.length).toBeGreaterThan(0);
          expect(c.input, "a claimed row missing input is a partial write").toBeTypeOf("object");
          expect(typeof c.acting_for).toBe("string");
        }
      }),
      { numRuns: 25 },
    );
  });
});
