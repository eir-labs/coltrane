// ROUND 6b — THE LAWS HOLD AGAINST THE REAL STORE, NOT JUST THE FAKE. (docs/specs/gig-runs-once.red-spec.json)
//
// The non-author review of #554 at 2d4e7ab (review 5326196799) ran the real workOnce against a real
// post-#250 store and the drain service's real routes. Every band was green, and three laws did not
// hold on the real store. The fake had answered in ways the store and the service never do:
//   D1  the fake answered coltrane_mcp_gig_status for ANY gig. The live store refuses a gig token
//       reading another gig's status (42501). Its resume exception covers coltrane_mcp_gig_OUTPUTS
//       only. So G4h's closed-gig rebuild always failed live, and every resume ran cold.
//   D2  player mode (coltrane_mcp_claim) leases 30 minutes and has no heartbeat, while the run
//       timeout defaults to 50. A 30–50 minute player run is re-claimed while still running.
//   D3  the drain service answers a refused header with 400 `{error}` and NO `code`
//       (drainErrorStatus). The fake answered 409 with a code. So a cancel landing between claim
//       and start header still ran and paid for the chair.
// The fixture now speaks the real store's scope rules and the real service's refusal shape
// (tests/gig_runs_once_fixtures.ts: `scopeRefusal`, `drainServiceRefusal`). With it, G4h and R5.1
// are red at head, as the review said they should be. The review's four surviving plants are laws
// here too (S1 is D3's 400-without-code shape, S2–S4 below).
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps, type WorkerContext } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, drainServiceRefusal,
  GIG_ID, STORE, TERMINAL,
} from "./gig_runs_once_fixtures.js";

const O = GIG_ID;
const N = "14141414-2525-3636-4747-585858585858";
type Beat = () => Promise<unknown>;

let env: ReturnType<typeof hostedEnv>;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  env?.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const answer = (phase: string) => ({ id: `sig-${phase}`, source: "test", data: { seen: phase }, completeness: 1, acquisition_cost: 0 });

async function onFreshBox(deps: WorkOnceDeps, ctx: WorkerContext = venueCtx()): Promise<Awaited<ReturnType<typeof workOnce>>> {
  const root = mkdtempSync(join(tmpdir(), "coltrane-r6b-box-"));
  roots.push(root);
  const saved = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = root;
  try {
    return await workOnce(ctx, deps);
  } finally {
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = saved;
    await settle();
  }
}

/** Box A: O seals `scan`, then `rescan` fails. O is closed. */
async function closeO(store: ReturnType<typeof hostedStore>): Promise<Record<string, unknown>> {
  store.set({ claim: claimFor("three-chair-v0") });
  const a = await onFreshBox({
    makeInvoke: () => (async (ctx: AgentInvocationContext) => {
      if (ctx.phase === "rescan") throw new Error("rescan broke");
      return answer(ctx.phase);
    }) as unknown as AgentInvoker,
  } as WorkOnceDeps);
  expect(a.claimed && a.status, "precondition: O ends failed").toBe("failed");
  const oScan = store.outputs.find((o) => o["gig_id"] === O && o["phase"] === "scan");
  expect(oScan, "precondition: O's scan is in the sink").toBeDefined();
  return oScan!;
}

const loseLease = () => new Response(JSON.stringify({ error: "no live lease for this instance" }), { status: 403 });
const renewOk = () => new Response(JSON.stringify(new Date(Date.now() + 3_600_000).toISOString()), { status: 200 });

describe("D1 — under the REAL scope rules, a resuming gig never re-pays for the closed gig's seals", () => {
  it("D1 N (resumes O) on a fresh box, then re-claimed on another fresh box after losing it: neither box invokes the chair O sealed", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("three-chair-v0") });
    await closeO(store);

    // Box B: N claims (resumes O) and loses its lease inside `final`.
    store.set({ claim: claimFor("three-chair-v0", { gig_id: N, resumes: O }), renew: loseLease });
    const beats: Beat[] = [];
    const phasesB: string[] = [];
    await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => {
        phasesB.push(ctx.phase);
        if (ctx.phase === "final") { for (const b of beats) await b().catch(() => undefined); throw new Error("box down"); }
        return answer(ctx.phase);
      }) as unknown as AgentInvoker,
      scheduleHeartbeat: (_ms: number, beat: Beat) => { beats.push(beat); return () => undefined; },
    } as unknown as WorkOnceDeps);
    expect(phasesB, "box B re-paid for the chair the closed gig sealed. Under the real scope rules the closed gig's status read is refused (42501), and the resume ran cold").not.toContain("scan");

    // Box C: a fresh re-claim of N.
    store.set({ renew: renewOk });
    const phasesC: string[] = [];
    const c = await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => { phasesC.push(ctx.phase); return answer(ctx.phase); }) as unknown as AgentInvoker,
    } as WorkOnceDeps);
    expect(phasesC, "the re-claim re-paid for the chair the closed gig sealed").not.toContain("scan");
    expect(c.claimed && c.status).toBe("complete");
  }, 30_000);
});

describe("D2 — PLAYER mode runs under its 30-minute lease", () => {
  it("D2 a player-mode run (coltrane_mcp_claim: a 30-minute lease, no heartbeat) is stopped by its run timeout BEFORE the player lease expires", async () => {
    env = hostedEnv();
    delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
    const PLAYER_LEASE_MS = 30 * 60 * 1000;
    const store = hostedStore({ claim: claimFor("one-chair-v0", { token: undefined }) });
    const player: WorkerContext = { baseUrl: STORE, anonKey: "anon-key", agentToken: "ctk_player_steve", worker: "player-box" };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let invoked = false;
    let stoppedBeforeLease = false;
    const chair = (ctx: AgentInvocationContext) => new Promise<Record<string, unknown>>((_resolve, reject) => {
      invoked = true;
      ctx.signal?.addEventListener("abort", () => { stoppedBeforeLease = true; reject(new Error("chair stopped")); }, { once: true });
    });
    const run = workOnce(player, { makeInvoke: () => chair as unknown as AgentInvoker } as WorkOnceDeps);
    for (let i = 0; i < 200 && !invoked; i++) await vi.advanceTimersByTimeAsync(0);
    expect(invoked, "precondition: the player-mode chair started").toBe(true);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_claim")), "precondition: this is the PLAYER claim path").toBe(true);
    await vi.advanceTimersByTimeAsync(PLAYER_LEASE_MS - 1);
    expect(stoppedBeforeLease,
      "the player-mode run was still going when its 30-minute lease lapsed, so another player can claim the same gig while it runs (the 50-minute default applies in player mode)").toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await run;
  }, 30_000);
});

describe("D3 — ANY refusal of the start header stops the run before the first chair (the service's real shape)", () => {
  const CASES: Array<[string, () => Response]> = [
    ["the terminal guard, as the service answers it: 400 {error}, no code", () => drainServiceRefusal("gig is already cancelled and may not become running")],
    ["a lost lease, as the service answers it: 403 {error}, no code", () => drainServiceRefusal("no live lease for this instance")],
    ["a service that keeps answering 503", () => new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 503 })],
  ];
  for (const [label, refuse] of CASES) {
    it(`D3 the 'running' header is refused with ${label}: no chair, nothing sealed, nothing terminal, not complete`, async () => {
      env = hostedEnv();
      const store = hostedStore({
        claim: claimFor("two-chair-v0"),
        header: (b) => (b["status"] === "running" ? refuse() : undefined),
      });
      const invoke = vi.fn(async () => sealableSignal);
      const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
      await settle();
      expect(store.headers().some((c) => c.body["status"] === "running"), "precondition: the start header was sent").toBe(true);
      if (label.includes("503")) {
        // A 5xx is transient: E2's policy retries it (3 attempts in all). The run stops only once the
        // retries are exhausted, never after the first 503 and never by running anyway.
        expect(store.headers().filter((c) => c.body["status"] === "running").length,
          "a 5xx on the start header must be retried under E2's policy (3 attempts) before the run stops").toBe(3);
      }
      expect(invoke, `the start header was refused (${label}) and the chair ran anyway`).not.toHaveBeenCalled();
      expect(sealedLocally(env.stateRoot, GIG_ID)).toEqual([]);
      expect(store.headers().filter((c) => TERMINAL.has(String(c.body["status"]))).map((c) => c.body["status"]),
        "a refused worker wrote a terminal header").toEqual([]);
      expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "a refused worker failed the gig").toBe(false);
      expect(res.claimed && res.status).not.toBe("complete");
    }, 20_000);
  }
});

describe("S2–S4 — the review's surviving plants, booked", () => {
  it("S2 an ordinary FAILED run whose failed header the store acknowledged reports acknowledged:true (and `coltrane work` need not exit 1 for an unlost failure)", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => (async () => { throw new Error("the model never came back"); }) as unknown as AgentInvoker,
    } as WorkOnceDeps);
    expect(res.claimed && res.status).toBe("failed");
    expect(store.gigs.get(GIG_ID)?.["status"], "precondition: the store recorded the failure").toBe("failed");
    expect((res as Record<string, unknown>)["acknowledged"], "an acknowledged failure was reported as UNacknowledged").toBe(true);
  });

  it("S3 when the closed gig's seals cannot be used (its genome moved), a re-claim of the resuming gig still rebuilds from ITS OWN drained seals", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("three-chair-v0") });
    await closeO(store);
    // The closed gig's identity no longer matches: its seals are unusable whatever the scope rules.
    store.gigs.set(O, { ...(store.gigs.get(O) ?? { id: O }), genome_hash: "a".repeat(64) });

    store.set({ claim: claimFor("three-chair-v0", { gig_id: N, resumes: O }), renew: loseLease });
    const beats: Beat[] = [];
    const phasesB: string[] = [];
    await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => {
        phasesB.push(ctx.phase);
        if (ctx.phase === "final") { for (const b of beats) await b().catch(() => undefined); throw new Error("box down"); }
        return answer(ctx.phase);
      }) as unknown as AgentInvoker,
      scheduleHeartbeat: (_ms: number, beat: Beat) => { beats.push(beat); return () => undefined; },
    } as unknown as WorkOnceDeps);
    expect(phasesB, "precondition: B ran cold (O's seals unusable) and lost its box in final").toEqual(["scan", "rescan", "final"]);
    expect(store.outputs.filter((o) => o["gig_id"] === N).map((o) => o["phase"]).sort(), "precondition: N's own seals are in the sink").toEqual(["rescan", "scan"]);

    store.set({ renew: renewOk });
    const phasesC: string[] = [];
    const c = await onFreshBox({
      makeInvoke: () => (async (ctx: AgentInvocationContext) => { phasesC.push(ctx.phase); return answer(ctx.phase); }) as unknown as AgentInvoker,
    } as WorkOnceDeps);
    expect(phasesC, "the closed gig's rebuild failed and the re-claim did not fall back to N's OWN drained seals, so it paid for them again").toEqual(["final"]);
    expect(c.claimed && c.status).toBe("complete");
  }, 30_000);

  it("S4 the 'running' header of a gig that resumes a closed one carries manifest.resumes", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0", { gig_id: N, resumes: O }) });
    await onFreshBox({ makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker } as WorkOnceDeps);
    const running = store.headers().filter((c) => c.body["id"] === N && c.body["status"] === "running");
    expect(running.length, "precondition: the start header was written").toBeGreaterThan(0);
    expect((running[0]!.body["manifest"] as Record<string, unknown> | undefined)?.["resumes"],
      "the start header does not say which gig this one resumes, so the store cannot link them").toBe(O);
  });
});
