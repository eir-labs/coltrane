// E8 — THE HOSTED LEASE IS ONE NUMBER. (docs/specs/gig-runs-once.red-spec.json)
//
// The engine held its idea of the store's lease in prose: "the store's lease is thirty minutes"
// (src/run_deps.ts, above DEFAULT_DRAIN_TIMEOUT_MS) and "until the lease expires (30 minutes)"
// (src/worker.ts, the no-mint refusal). The store's lease is sixty. Nothing could notice, because a
// number in a comment cannot fail. Now two mechanisms depend on it — the heartbeat's interval and the
// run timeout that must stay under the lease — and two copies of one number is the drift this repo
// keeps paying for.
//
// So: one exported constant, HOSTED_LEASE_MS in src/lease.ts, equal to sixty minutes; the heartbeat
// interval and the drain's default run timeout are DERIVED from it. The derivation is proved the only
// way it can be — by moving the constant (a module mock) and watching both follow. A heartbeat
// interval hard-coded to twenty minutes equals a third of the real lease and would pass any law that
// only reads the real value; it fails this one.
//
// (Implementer obligation, not pinned here because comment text is not behaviour: retire the stale
// "thirty minutes" comments in src/worker.ts and src/run_deps.ts.)
import { describe, it, expect, afterEach, vi } from "vitest";
import type { WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, loadLease, LEASE_MODULE } from "./gig_runs_once_fixtures.js";

const WORKER_MODULE = "../src/worker.js";
const RUN_DEPS_MODULE = "../src/run_deps.js";
const MOVED_LEASE_MS = 12 * 60 * 1000;

let env: ReturnType<typeof hostedEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  vi.doUnmock(LEASE_MODULE);
  vi.resetModules();
});

describe("E8 — the lease length is one constant", () => {
  it("E8 HOSTED_LEASE_MS is sixty minutes; a VENUE run has no run deadline (the lease is its only clock), and a PLAYER run's deadline sits under the player lease", async () => {
    const { HOSTED_LEASE_MS, PLAYER_LEASE_MS } = await loadLease();
    expect(HOSTED_LEASE_MS, "the store leases a claimed row for sixty minutes").toBe(60 * 60 * 1000);
    delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
    const { drainTimeoutMs } = (await import(/* @vite-ignore */ RUN_DEPS_MODULE)) as { drainTimeoutMs(mode?: "venue" | "player"): number | undefined };
    // Founder's ruling, 3 Oct 2026: a venue run stops on facts (lease lost or unverifiable, budget,
    // abort), never because time passed — tests/a_venue_run_stops_on_facts_not_on_the_clock.test.ts.
    expect(drainTimeoutMs("venue"), "a venue run was given a run deadline: a clock cutting work whose lease is renewing").toBeUndefined();
    expect(drainTimeoutMs(), "the default mode is venue, and it has no deadline").toBeUndefined();
    process.env["COLTRANE_GIG_TIMEOUT_MS"] = "80";
    expect(drainTimeoutMs("venue"), "COLTRANE_GIG_TIMEOUT_MS gave a venue run a deadline — the variable is not read on that path").toBeUndefined();
    delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
    // The player path has no renew door, so its deadline is its lease restated — under it.
    expect(drainTimeoutMs("player")).toBeGreaterThan(0);
    expect(drainTimeoutMs("player"), "a player run that outlives its lease is working on a gig another player may hold").toBeLessThan(PLAYER_LEASE_MS);
  });

  it("E8 move the constant and the heartbeat interval AND the run timeout follow it — neither is a second copy", async () => {
    // Fail on the missing module itself first, so the reason reads as what it is.
    await loadLease();
    vi.resetModules();
    vi.doMock(LEASE_MODULE, async (importOriginal) => ({
      ...((await importOriginal()) as Record<string, unknown>),
      HOSTED_LEASE_MS: MOVED_LEASE_MS,
    }));
    const moved = await loadLease();
    expect(moved.HOSTED_LEASE_MS, "the module mock did not take — this law would be testing nothing").toBe(MOVED_LEASE_MS);

    delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
    const { drainTimeoutMs } = (await import(/* @vite-ignore */ RUN_DEPS_MODULE)) as { drainTimeoutMs(mode?: "venue" | "player"): number | undefined };
    // The venue run has no deadline to follow the constant — moving the lease moves only the
    // heartbeat interval (asserted below); the player deadline follows PLAYER_LEASE_MS, untouched here.
    expect(drainTimeoutMs("venue"), "moving the lease conjured a venue run deadline").toBeUndefined();
    expect(drainTimeoutMs("player")).toBeGreaterThan(0);
    expect(drainTimeoutMs("player"), "the player deadline followed the HOSTED lease, which is not the lease it runs under").toBeLessThan(moved.PLAYER_LEASE_MS);

    env = hostedEnv();
    hostedStore({ claim: claimFor("one-chair-v0") });
    const intervals: number[] = [];
    const { workOnce } = (await import(/* @vite-ignore */ WORKER_MODULE)) as {
      workOnce(ctx: unknown, deps: WorkOnceDeps): Promise<unknown>;
    };
    await workOnce(venueCtx(), {
      makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker,
      scheduleHeartbeat: (ms: number) => { intervals.push(ms); return () => undefined; },
    } as unknown as WorkOnceDeps);
    expect(intervals, "no heartbeat was armed").toHaveLength(1);
    expect(intervals[0], "the heartbeat interval did not follow the lease constant — it is hard-coded").toBe(MOVED_LEASE_MS / 3);
  });
});
