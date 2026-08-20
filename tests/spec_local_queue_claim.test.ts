// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — committed RED on purpose. See docs/specs/SPEC-local-queue-contract.md.
// A failure here is a feature not yet built (`src/local_queue.ts`); a failure in any file NOT named
// spec_* is a regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// CLAIM — the exactly-one-winner core and the round-trip identity.
//
// The claim side is welded to HTTP today (claimNextGig, worker.ts:364, over coltrane_drain_claim /
// coltrane_mcp_claim). The local sibling must give mutual exclusion with no database and no lock:
// POSIX rename(2) is atomic within a filesystem, so a directory-per-state design (queued/ ->
// claimed/<worker>/) means the winner's rename removes the source and every loser's rename of the
// same source ENOENTs — that is how a loser learns it lost (maildir new/->cur/, cr.yp.to; FSQ). The
// laws pin the INVARIANT, never the layout: for ANY interleaving of N claims on one row, exactly one
// wins and the rest get nothing; and the gig a worker claims is byte-for-byte the gig enqueued.
import { describe, it, expect, afterAll } from "vitest";
import fc from "fast-check";
import {
  loadLocalQueue,
  freshRoot,
  cleanupRoots,
  gigPayloadArb,
  SEMANTIC_FIELDS,
} from "./spec_local_queue_fixtures.js";

afterAll(cleanupRoots);

describe("local queue — the claimed gig IS the enqueued gig (I3, round-trip identity)", () => {
  // I3 — "a local run must not be a different code path with different meaning". For any well-formed
  // payload, every semantic field survives enqueue→claim unchanged. Asserted as an observable
  // property over arbitrary payloads, not a sampled example (venue_doors.property template).
  it("I3 every semantic field is preserved across enqueue and claim", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(gigPayloadArb, async (payload) => {
        const q = openLocalQueue(freshRoot());
        await q.enqueue(payload);
        const claimed = await q.claim("w1");
        expect(claimed, "an enqueued gig that cannot be claimed lost its identity").not.toBeNull();
        for (const f of SEMANTIC_FIELDS) {
          expect(claimed![f as keyof typeof claimed], `field "${f}" drifted between enqueue and claim`)
            .toEqual(payload[f]);
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("local queue — EXACTLY ONE WINNER under concurrency (I4, I5, I6, I19)", () => {
  // I4 (real race) — the actual thing under test is rename(2) atomicity, so fire a REAL Promise.all
  // of N concurrent claims against ONE queued row and assert exactly one resolves with the gig. Over
  // arbitrary N (2..8), because "exactly one" is a universal claim, not a lucky single race.
  it("I4 N concurrent claims of one row ⇒ exactly one winner (real filesystem race)", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const q = openLocalQueue(freshRoot());
        const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
        const results = await Promise.all(
          Array.from({ length: n }, (_, i) => q.claim(`w${i}`)),
        );
        const winners = results.filter((r) => r !== null);
        expect(winners.length, "two workers claimed one row — mutual exclusion failed").toBe(1);
        expect(winners[0]!.gig_id).toBe(gig_id);
      }),
      { numRuns: 30 },
    );
  });

  // I5 — a claim that LOSES the race returns the same empty sentinel as "nothing to claim" (null),
  // NEVER a thrown store error. A loss must not read as an error to the drain loop (F3).
  it("I5/F3 every loser of the race returns null and none reject", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const q = openLocalQueue(freshRoot());
        await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
        // Promise.allSettled so a rejection is observable as a defect rather than crashing the run.
        const settled = await Promise.allSettled(
          Array.from({ length: n }, (_, i) => q.claim(`w${i}`)),
        );
        const rejected = settled.filter((s) => s.status === "rejected");
        expect(rejected, "a lost race must not surface as a thrown error").toHaveLength(0);
        const values = settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
        const losers = values.filter((v) => v === null);
        expect(losers.length, "every non-winner must get the null sentinel").toBe(n - 1);
      }),
      { numRuns: 30 },
    );
  });

  // I6 — a successful claim REMOVES the row from queued; a second claim of the same gig finds
  // nothing (mutual exclusion by source removal — maildir new/->cur/ removes the source).
  it("I6 a claimed row is gone from queued — a second claim gets nothing", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const q = openLocalQueue(freshRoot());
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    const first = await q.claim("w1");
    expect(first!.gig_id).toBe(gig_id);
    const second = await q.claim("w2");
    expect(second, "the same row was claimed twice").toBeNull();
  });

  // I19 — the linearizability gate, operationalized: for a concurrent batch of claims across K
  // queued gigs, every observed history is serial-explainable — the claimed multiset has NO
  // duplicate (each gig claimed at most once, one atomic rename point) and is a subset of the
  // enqueued ids, and exactly min(workers, gigs) claims succeed.
  it("I19 concurrent claims across K rows are serial-explainable (no dup, subset, min count)", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        async (gigs, workers) => {
          const q = openLocalQueue(freshRoot());
          const enq = new Set<string>();
          for (let i = 0; i < gigs; i++) {
            enq.add((await q.enqueue({ standard_slug: "s", input: { i }, acting_for: "a" }))["gig_id"] as string);
          }
          const claimed = (
            await Promise.all(Array.from({ length: workers }, (_, i) => q.claim(`w${i}`)))
          ).filter((r): r is NonNullable<typeof r> => r !== null);
          const ids = claimed.map((c) => c.gig_id);
          expect(new Set(ids).size, "one gig was claimed twice — not serial-explainable").toBe(ids.length);
          for (const id of ids) expect(enq.has(id), "a claim returned a gig never enqueued").toBe(true);
          expect(ids.length, "the number of winners must be min(workers, gigs)").toBe(Math.min(gigs, workers));
        },
      ),
      { numRuns: 30 },
    );
  });
});
