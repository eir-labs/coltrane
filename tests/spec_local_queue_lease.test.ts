// ════════════════════════════════════════════════════════════════════════════════════════════
// PENDING IMPLEMENTATION — committed RED on purpose. See docs/specs/SPEC-local-queue-contract.md.
// A failure here is a feature not yet built (`src/local_queue.ts`); a failure in any file NOT named
// spec_* is a regression. Do not weaken these laws to make CI green; implement them.
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// LEASE + HEARTBEAT + REAPER — these MIRROR the reside lease law (PR #447, spec/residency-contract:
// tests/spec_reside_lease.test.ts, tests/spec_reside_liveness.test.ts) rather than restating it
// differently, because two subsystems that disagree about what a lease means IS the defect.
//
// CAVEAT, stated where it bites: the reside spec files are on branch spec/residency-contract and are
// NOT on this branch — they could not be opened this run (confirmed: no tests/spec_reside_* here).
// The invariant NAMES below are grounded in the brief's paraphrase of the reside law plus two OPENED
// sources: src/worker.ts:196-266 reapWorkerState (mtime as the liveness proxy; keeps fresh /
// load-bearing state; drops presumed-abandoned; best-effort, never throws) and Amazon SQS's
// visibility-timeout ("a lease is not a lock"; "record the monotonic time of last renewal"; "treat
// uncertain renewal as loss"; "a crashed grip falls open by timeout"). When the reside spec lands on
// a shared branch, RECONCILE the assertion here against its actual text before either is restated.
//
// Time is INJECTED (a mutable clock) so the laws are deterministic and fast — no sleeping, fully
// offline. The lease state machine is exercised with fast-check over random command sequences
// (lifecycle.model.test.ts pattern), so the invariants hold over the whole transition SPACE.
import { describe, it, expect, afterAll } from "vitest";
import fc from "fast-check";
import { loadLocalQueue, freshRoot, cleanupRoots, type LocalQueue } from "./spec_local_queue_fixtures.js";

afterAll(cleanupRoots);

const LEASE_MS = 1000;

/** A mutable clock the store reads through opts.clock, advanced by the model's Advance command. */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000; // an arbitrary non-zero monotonic origin
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ── The command language for the model laws (I7, I10). ───────────────────────────────────────────
type Cmd =
  | { k: "enq" }
  | { k: "claim"; w: number }
  | { k: "hb"; w: number }
  | { k: "adv"; ms: number }
  | { k: "reap" };

const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  fc.constant<Cmd>({ k: "enq" }),
  fc.integer({ min: 0, max: 3 }).map((w): Cmd => ({ k: "claim", w })),
  fc.integer({ min: 0, max: 3 }).map((w): Cmd => ({ k: "hb", w })),
  fc.integer({ min: 100, max: 2500 }).map((ms): Cmd => ({ k: "adv", ms })),
  fc.constant<Cmd>({ k: "reap" }),
);

/** A reference model of the lease state machine, checked against the real store after each command.
 *  It tracks, per gig, whether it is live-claimed and by whom, and the monotonic lease expiry. */
interface ModelRow { holder: number | null; expires: number; claimed: boolean }

describe("local queue — lease state machine (I7, I10) via model-based testing", () => {
  // I7 — AT MOST ONE LIVE HOLDER. Mirrors reside "exactly one holder". Over any command sequence, a
  // claim only ever succeeds against a gig that is NOT already live-claimed, and the store's view
  // never shows one gig claimed by two holders. This is the sequential-logic complement to the
  // real-race law in spec_local_queue_claim.test.ts (I4).
  it("I7 no gig is ever live-claimed by two holders, across any command sequence", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 1, maxLength: 24 }), async (cmds) => {
        const clock = makeClock();
        const q: LocalQueue = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
        // gig_id -> holder currently believed live in the model
        const liveHolder = new Map<string, number>();
        const liveUntil = new Map<string, number>();
        let lastGig: string | null = null;

        for (const cmd of cmds) {
          if (cmd.k === "enq") {
            lastGig = (await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" }))["gig_id"] as string;
          } else if (cmd.k === "claim") {
            const c = await q.claim(`w${cmd.w}`);
            if (c) {
              const stillLive = (liveUntil.get(c.gig_id) ?? -Infinity) > clock.now();
              expect(stillLive, `gig ${c.gig_id} was handed to a second live holder`).toBe(false);
              liveHolder.set(c.gig_id, cmd.w);
              liveUntil.set(c.gig_id, clock.now() + LEASE_MS);
            }
          } else if (cmd.k === "hb") {
            // A heartbeat only extends the model when it is the believed holder renewing.
            for (const [gig, holder] of liveHolder) {
              if (holder === cmd.w && (await q.heartbeat(`w${cmd.w}`, gig))) {
                liveUntil.set(gig, clock.now() + LEASE_MS);
              }
            }
          } else if (cmd.k === "adv") {
            clock.advance(cmd.ms);
          } else {
            q.reap();
            for (const [gig, until] of [...liveUntil]) {
              if (until <= clock.now()) { liveHolder.delete(gig); liveUntil.delete(gig); }
            }
          }

          // The store's own view must never show a gig claimed by two holders.
          const claimedRows = q.list().filter((r) => r.state === "claimed");
          const perGig = new Map<string, number>();
          for (const r of claimedRows) perGig.set(r.gig_id, (perGig.get(r.gig_id) ?? 0) + 1);
          for (const [gig, count] of perGig) {
            expect(count, `gig ${gig} appears claimed ${count}× — one row, two holders`).toBe(1);
          }
        }
        expect(lastGig === null || typeof lastGig === "string").toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  // I10 — THE REAPER SPARES THE LIVING AND REAPS THE DEAD. Mirrors reside "reaps the dead and NOT
  // the living" and reapWorkerState's fresh-is-kept discipline. Over any sequence: after a reap,
  // every claim whose lease has LAPSED is back in queued, and every FRESH claim is untouched (same
  // holder, same lease).
  it("I10 reap returns lapsed claims and never touches a fresh one, across any sequence", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.array(cmdArb, { minLength: 1, maxLength: 24 }), async (cmds) => {
        const clock = makeClock();
        const q: LocalQueue = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
        const model: Map<string, ModelRow> = new Map();

        for (const cmd of cmds) {
          if (cmd.k === "enq") {
            const g = (await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" }))["gig_id"] as string;
            model.set(g, { holder: null, expires: 0, claimed: false });
          } else if (cmd.k === "claim") {
            const c = await q.claim(`w${cmd.w}`);
            if (c) model.set(c.gig_id, { holder: cmd.w, expires: clock.now() + LEASE_MS, claimed: true });
          } else if (cmd.k === "hb") {
            for (const [g, row] of model) {
              if (row.claimed && row.holder === cmd.w && (await q.heartbeat(`w${cmd.w}`, g))) {
                row.expires = clock.now() + LEASE_MS;
              }
            }
          } else if (cmd.k === "adv") {
            clock.advance(cmd.ms);
          } else {
            // Snapshot which claims were fresh vs lapsed at reap time, then reap.
            const wasFresh = new Map<string, number | null>();
            for (const [g, row] of model) if (row.claimed && row.expires > clock.now()) wasFresh.set(g, row.holder);
            const lapsed = [...model].filter(([, r]) => r.claimed && r.expires <= clock.now()).map(([g]) => g);
            q.reap();
            const view = new Map(q.list().map((r) => [r.gig_id, r] as const));
            for (const g of lapsed) {
              expect(view.get(g)?.state, `reaper left lapsed gig ${g} un-requeued`).toBe("queued");
              model.set(g, { holder: null, expires: 0, claimed: false });
            }
            for (const [g, holder] of wasFresh) {
              const r = view.get(g);
              expect(r?.state, `reaper touched a FRESH claim on gig ${g}`).toBe("claimed");
              expect(r?.holder, `reaper changed the holder of a fresh claim on gig ${g}`).toBe(`w${holder}`);
            }
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe("local queue — heartbeat, liveness, and lapse (I8, I9, I11, F5, F7)", () => {
  // I8 — a heartbeat by the holder advances the lease strictly and keeps the reaper off it. Mirrors
  // SQS "renew before expiry; record the monotonic time of last renewal".
  it("I8 a heartbeat strictly advances the lease and spares the claim from reaping", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    const claimed = await q.claim("w1");
    const first = claimed!.lease.expires_at;
    clock.advance(LEASE_MS - 1); // still live — renew just before expiry
    expect(await q.heartbeat("w1", gig_id)).toBe(true);
    const renewed = q.list().find((r) => r.gig_id === gig_id)!;
    expect(renewed.lease!.expires_at, "the renewed lease must be strictly fresher").toBeGreaterThan(first);
    clock.advance(LEASE_MS - 1); // still inside the renewed window
    q.reap();
    expect(q.list().find((r) => r.gig_id === gig_id)!.state, "a heartbeated claim was reaped").toBe("claimed");
  });

  // I9 — a LAPSED lease ALWAYS becomes claimable again. Mirrors reside "lapsed lease becomes
  // claimable" + SQS "a crashed grip falls open by timeout". Property over arbitrary over-run.
  it("I9 once the lease lapses, the gig is claimable by another worker", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: LEASE_MS, max: 5 * LEASE_MS }), async (overrun) => {
        const clock = makeClock();
        const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
        const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
        expect(await q.claim("w1")).not.toBeNull();
        clock.advance(overrun); // w1 crashed — never heartbeats
        q.reap();
        const reclaimed = await q.claim("w2");
        expect(reclaimed, "a crashed worker's lease never fell open").not.toBeNull();
        expect(reclaimed!.gig_id).toBe(gig_id);
      }),
      { numRuns: 25 },
    );
  });

  // I11 — LIVENESS IS A CONTINUING FACT, not a boot assertion. A holder that once claimed but stops
  // heartbeating loses the lease when it lapses; the initial claim does not immunize it. Mirrors
  // reside "liveness as a continuing fact not a boot assertion".
  it("I11 a successful claim does not immunize a holder that stops heartbeating", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1"); // claimed once, then silence
    clock.advance(LEASE_MS + 1);
    q.reap();
    expect(q.list().find((r) => r.gig_id === gig_id)!.state, "the once-claimed holder kept the row forever").toBe("queued");
  });

  // F5 — an UNCERTAIN/failed renewal is treated as LOSS, never as still-held. A heartbeat against a
  // lease the holder no longer owns (it lapsed and was reclaimed by someone else) returns false.
  it("F5 a heartbeat against a lost lease returns false, not a false 'still held'", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    const { gig_id } = await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    await q.claim("w1");
    clock.advance(LEASE_MS + 1);
    q.reap();
    await q.claim("w2"); // w2 now holds it
    expect(await q.heartbeat("w1", gig_id), "the evicted holder must not renew a lease it lost").toBe(false);
  });

  // F7 — a claim against a gig whose lease is STILL FRESH gets nothing (the null sentinel), not a
  // steal. Fail closed against double-claim of a live gig (mutual exclusion, complements I7).
  it("F7 claiming a live (fresh-lease) gig returns null, never steals it", async () => {
    const { openLocalQueue } = await loadLocalQueue();
    const clock = makeClock();
    const q = openLocalQueue(freshRoot(), { leaseMs: LEASE_MS, clock: clock.now });
    await q.enqueue({ standard_slug: "s", input: {}, acting_for: "a" });
    const first = await q.claim("w1");
    expect(first).not.toBeNull();
    clock.advance(LEASE_MS - 1); // still live
    expect(await q.claim("w2"), "a live gig was stolen from its holder").toBeNull();
  });
});
