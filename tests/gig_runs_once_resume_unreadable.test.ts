// U2–U3, V1–V6 — AN UNREADABLE RESUME NEVER STALLS THE QUEUE, AND IS NEVER DESTROYED BY THE STALL
// FIX. (docs/specs/gig-runs-once.red-spec.json)
//
// ROUND 6 (19a4812) was graded NOT MERGEABLE, and the laws were part of the defect. The round-6
// contract classified ANY answered 4xx on a resume-state read as PERMANENT and TERMINATED the gig on
// poll 1 — failed, no refund, nothing invoked. On the live store as deployed TODAY that destroys
// every resuming gig there is:
//
//   * coltrane-ui #250 as merged lets a gig token read the OUTPUTS of the gig its row resumes, and
//     REFUSES the STATUS read (403 / 42501). The widening to `coltrane_mcp_gig_status` is #253 and
//     has not shipped. So the live sequence is: outputs ok → status 42501 → "permanent" → terminated.
//   * the other branch is fatal too: a closed gig the sink holds no outputs for took the `nothing`
//     branch, which was permanent unconditionally.
//
// Before round 6 those gigs were refunded and re-queued. They SPUN — the defect the review opened on
// — but they survived, and would have started working the moment the store widened.
//
// ── THE SEAT'S TWO RULINGS, WHICH THESE LAWS ENCODE ─────────────────────────────────────────────
//
// R1  THE FAIL-CLOSED DIRECTION WAS INVERTED. "Absent must mean DECLINE" holds only where the
//     refusal is REVERSIBLE. Here it is not: terminating throws away the gig AND the money already
//     spent on the closed gig's chairs, and no later poll can undo it, while the spin it replaces is
//     recoverable by definition. A TRANSIENT FAILURE WHOSE BOUND CANNOT BE ESTABLISHED IS REFUNDED,
//     NOT TERMINATED. The unbounded spin is still a real defect and is still bounded — never by
//     trading a stall for destruction.
//
// R2  THE `nothing` BRANCH SPLITS. src/worker.ts:1420 reads
//       const permanent = "nothing" in rebuilt || rebuilt.permanent;
//     unconditionally, never consulting whether the closed gig's status row EXISTS. The spec wrote
//     case 4 as "the closed gig NO LONGER EXISTS (no status row, no outputs)"; the code implemented
//     "sealed nothing". Status row ABSENT → permanent. Status row PRESENT with zero outputs → COLD
//     RUN: the justification "a cold run re-pays for every chair the closed gig already sealed"
//     collapses when zero chairs sealed, and the cold run is then both free and correct.
//
// ── WHAT EACH LAW IS FOR ────────────────────────────────────────────────────────────────────────
//   U2  the ONE permanent case the spec actually named: the closed gig no longer exists.
//   U3  a transient failure that persists still ENDS, and the queue advances (round 6's U4).
//   V1  the missing law round 6's U4 could not catch: a transient failure must be RETRIED — refunded
//       and re-claimed — before it ends. U4 forbids the spin and never requires the retry, so
//       replacing the bounded retry with instant termination leaves U4 GREEN.
//   V2  TODAY'S LIVE STORE (42501 on the status read, and on the outputs read) SURVIVES. This is the
//       re-pointed round-6 U2 case 1, and it OBJECTS to termination rather than merely not asserting
//       it: plant "an answered 4xx is permanent" back and V2 goes red.
//   V3  fetchDrainedGenomeHash(O) and nextResumeReadFailureCount(N) call the SAME RPC on the SAME
//       token and boundedWorkerRpc has no internal retry, so ONE store hiccup fails both. A
//       thirty-second store restart must not destroy every resuming gig claimed during it.
//   V4  the header that would CARRY the bound is itself refused: still not a reason to destroy.
//   V5  player mode with no COLTRANE_DRAIN_KEY: remoteConfigured() is false BY CONSTRUCTION, so the
//       first transient failure is terminal every time, forever.
//   V6  R2's cold run: a status row present with zero outputs runs cold and completes.
//
// ── ROUND 9: THE TWO PLANTS THAT SURVIVED ROUND 8 ───────────────────────────────────────────────
// Round 8's implementer mutation-tested nine anchor-verified plants against the eleven laws above
// and killed seven. Two survived, and per this repo's discipline a surviving plant becomes a law.
//   V7  THE CORNER NO LAW REACHED: outputs EMPTY **and** the status UNREADABLE, both at once. U2 has
//       the status readable-and-absent; V3, V4 and V5 all have outputs PRESENT. So deleting the
//       `header.error` check in rebuildFromDrain's empty-outputs branch — which makes an UNREADABLE
//       status read as `exists: false`, i.e. "the gig is not there" — left all eleven GREEN while
//       re-introducing the round-6 inversion for "the store was unwell while the closed gig happened
//       to hold no seals". An unread store is not evidence of absence.
//   V8  THE RESIDUAL DESIGN DECISION, UNPINNED. Round 8 split the hand-back in two: where a transient
//       bound CAN be established and kept → a non-terminal release (the attempt refunds, the worker's
//       header count bounds it); where it CANNOT be established (V3/V5) or CANNOT be kept (V4) → NO
//       release at all, status `abandoned`, the lease lapses, and the store re-queues WITHOUT
//       refunding so its own max_attempts is the bound. V3/V4/V5 assert only SURVIVAL, so "refund
//       everywhere" satisfies all three — and a later hand could revert the split with nothing going
//       red, leaving a path bounded by nothing at all. V8a/V8b pin the lapse itself, at both sites.
//
// The fake store models the queue as the store has it (see `queue` in the fixture): oldest first,
// every claim counts, a non-terminal release refunds, a terminal release or gig_fail fails, and the
// cap fails `attempts_exhausted`. `lapse()` is time passing between polls.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, RESUME_READ_MAX_ATTEMPTS, type WorkOnceDeps, type WorkerContext } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, settle, STORE, type ResumedReadMode } from "./gig_runs_once_fixtures.js";

const O = "0c0c0c0c-1111-2222-3333-444444444444"; // the closed gig
const N = "1d1d1d1d-5555-6666-7777-888888888888"; // resumes O
const H = "2e2e2e2e-9999-aaaa-bbbb-cccccccccccc"; // a healthy gig queued behind N

let env: ReturnType<typeof hostedEnv>;
const roots: string[] = [];
afterEach(() => {
  env?.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const answer = (phase: string) => ({ id: `sig-${phase}`, source: "test", data: { seen: phase }, completeness: 1, acquisition_cost: 0 });

/** One poll of one fresh box. Records every invoked (gig, phase). */
async function poll(
  invoked: Array<[string, string]>,
  ctx: WorkerContext = venueCtx(),
  chair: (phase: string) => unknown = (p) => answer(p),
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "coltrane-r7-box-"));
  roots.push(root);
  const saved = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = root;
  try {
    const res = await workOnce(ctx, {
      makeInvoke: () => (async (ictx: AgentInvocationContext) => {
        invoked.push([String((ictx as unknown as { gig_id?: string }).gig_id ?? "?"), ictx.phase]);
        return chair(ictx.phase);
      }) as unknown as AgentInvoker,
    } as WorkOnceDeps).then((r) => JSON.stringify(r), (e: unknown) => (e instanceof Error ? e.message : String(e)));
    return res;
  } finally {
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = saved;
    await settle();
  }
}

/** The closed gig O as the sink holds it: one sealed output, so a resume of it has something to read. */
function seedClosedGig(store: ReturnType<typeof hostedStore>): void {
  store.outputs.push({
    id: "o-scan", gig_id: O, domain_type: "Signal", agent_slug: "scout", phase: "scan",
    content_sha: "a".repeat(64), input_shas: [], created_at: "2026-09-26T00:00:00.000Z", data: { seen: "scan" },
  });
}

/**
 * O REALLY RAN AND REALLY DIED: the store holds its start header (carrying the run's real
 * genome_hash) and its real, re-sealable `scan` row. A law that asserts the resuming gig SURVIVES
 * has to be able to show it then RESUMES, and a hand-written header would let a broken rebuild pass.
 */
async function closeO(store: ReturnType<typeof hostedStore>): Promise<void> {
  store.set({ claim: claimFor("two-chair-v0", { gig_id: O }) });
  const invoked: Array<[string, string]> = [];
  await poll(invoked, venueCtx(), (phase) => {
    if (phase === "rescan") throw new Error("O's box went down in rescan");
    return answer(phase);
  });
  expect(invoked.map(([, p]) => p), "precondition: O sealed scan and died in rescan").toEqual(["scan", "rescan"]);
  expect(store.outputs.some((o) => o["gig_id"] === O && o["phase"] === "scan"), "precondition: O's scan is in the sink").toBe(true);
  expect(store.gigs.get(O)?.["genome_hash"], "precondition: the sink holds O's run identity").toMatch(/^[0-9a-f]{64}$/);
}

/**
 * BREAK THE STORE'S `coltrane_mcp_gig_status` RPC for the named gigs — both of them, which is the
 * whole point of V3: `fetchDrainedGenomeHash(<the closed gig>)` and `nextResumeReadFailureCount(<this
 * gig>)` are the SAME RPC on the SAME token, and `boundedWorkerRpc` has no internal retry, so one
 * unwell store fails both. Wraps the fixture's fetch rather than adding a fixture knob, so the law
 * states its own hypothesis. `heal()` is the store coming back.
 */
function breakStatusRpc(gigIds: string[], mode: "error" | "network" | "hang"): { heal(): void } {
  const inner = globalThis.fetch as typeof fetch;
  let broken = true;
  const wrapped = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    let body: Record<string, unknown> = {};
    try { body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
    if (broken && u.pathname.endsWith("/rpc/coltrane_mcp_gig_status") && gigIds.includes(String(body["p_gig"]))) {
      if (mode === "error") return new Response(JSON.stringify({ message: "internal error" }), { status: 500 });
      if (mode === "network") throw new TypeError("fetch failed: ECONNRESET");
      return await new Promise<Response>(() => { /* the store never answers */ });
    }
    return inner(url as string, init);
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", wrapped);
  return { heal: () => { broken = false; } };
}

const terminalReleases = (store: ReturnType<typeof hostedStore>, gig: string) =>
  store.releases().filter((c) => c.body["p_gig_id"] === gig && c.body["p_terminal"] === true);
const refunds = (store: ReturnType<typeof hostedStore>, gig: string) =>
  store.releases().filter((c) => c.body["p_gig_id"] === gig && c.body["p_terminal"] === false);
const failCalls = (store: ReturnType<typeof hostedStore>, gig: string) =>
  store.calls.filter((c) => c.host === "store" && c.path.endsWith("/rpc/coltrane_mcp_gig_fail") && c.body["p_gig"] === gig);

/** Everything a DESTROYED gig looks like, in one assertion, so every survivor law objects the same way. */
function expectSurvived(store: ReturnType<typeof hostedStore>, gig: string, where: string): void {
  expect(store.queueRow(gig)?.status, `${where}: the resuming gig was FAILED. It is recoverable work and the closed gig's chairs are already paid for`).not.toBe("failed");
  expect(terminalReleases(store, gig).map((c) => c.body["p_reason"]), `${where}: the gig was released TERMINALLY, which destroys it and refunds nothing`).toEqual([]);
  expect(failCalls(store, gig).length, `${where}: the gig was failed on the store (coltrane_mcp_gig_fail)`).toBe(0);
}

describe("U2 — the ONE permanent case: the closed gig NO LONGER EXISTS (no status row, no outputs)", () => {
  it("U2 the resuming gig is TERMINATED (failed, named, no refund, nothing invoked), and the healthy gig behind it runs on the next poll", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: null,
      queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O }), claimFor("one-chair-v0", { gig_id: H })],
      resumedRead: { status: "missing", outputs: "missing" },
    });
    const invoked: Array<[string, string]> = [];
    const outcome = await poll(invoked);

    expect(invoked, "a chair ran for a resume whose closed gig is not there at all").toEqual([]);
    expect(store.queueRow(N)?.claims, "precondition: the resuming gig was claimed").toBe(1);
    expect(refunds(store, N).map((c) => c.body["p_reason"]),
      "a gig that no longer exists was released non-terminally: the attempt refunds and the same unrunnable row heads the queue on every poll, forever").toEqual([]);
    expect(store.queueRow(N)?.status, "the gig was not terminated (terminal release or gig_fail)").toBe("failed");
    expect(store.queueRow(N)?.attempts, "the attempt was refunded").toBe(1);
    expect(outcome, "the refusal must name the gig it could not resume").toContain(O);
    const reason = store.queueRow(N)?.reason ?? "";
    expect(reason, "the terminated gig's reason must name the resume and the closed gig").toMatch(/resum/i);
    expect(reason).toContain(O);

    store.lapse();
    await poll(invoked);
    expect(invoked.map(([g]) => g), "the healthy gig behind a gig that cannot exist never ran").toEqual([H]);
  }, 30_000);
});

describe("U3 — a transient failure that persists still ends; nothing spins forever", () => {
  it("U3 the resumed gig's status read keeps failing with 500: within eight polls it ENDS (failed; the attempts cap applies), and the healthy gig behind it runs", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: null,
      queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O }), claimFor("one-chair-v0", { gig_id: H })],
      maxAttempts: 3,
      resumedRead: { status: "error" },
    });
    seedClosedGig(store);
    const invoked: Array<[string, string]> = [];
    for (let i = 0; i < 8; i++) {
      if (store.queueRow(N)?.status === "failed" && store.queueRow(H)?.status === "completed") break;
      await poll(invoked);
      store.lapse();
    }
    expect(store.queueRow(N)?.status,
      `a persistently failing resume never ended after ${store.queueRow(N)?.claims} claims. Each refund puts it back at the head with its attempt returned, so the cap can never trip`).toBe("failed");
    expect(store.queueRow(N)?.claims ?? 0, "the persistent transient failure was retried beyond the attempts cap").toBeLessThanOrEqual(RESUME_READ_MAX_ATTEMPTS + 1);
    expect(store.queueRow(H)?.status, "the healthy gig behind a persistently failing resume never ran").toBe("completed");
    expect(invoked.filter(([, p]) => p === "scan").length, "precondition: exactly one chair ran, the healthy gig's own").toBeLessThanOrEqual(1);
  }, 60_000);
});

describe("V1 — a transient failure is RETRIED before it ends: refunded, re-claimed, bounded", () => {
  // THE LAW ROUND 6 WAS MISSING. U3 (round 6's U4) is one-sided: it forbids the spin and never
  // requires that a transient failure be retried at all, so replacing the bounded retry with instant
  // termination leaves it GREEN — which is exactly what 19a4812 did on the live store. This law is
  // the other side: the gig is handed BACK, claimed again, and only ends at the bound.
  it("V1 a transient 500 on the closed gig's status read, with a healthy read of this gig's OWN header: refunded and re-claimed three times before it ends, and no chair ever runs", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: null,
      queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O })],
      maxAttempts: 10, // the store's cap is not what is being measured; the WORKER's bound is
      resumedRead: { status: "error" },
    });
    seedClosedGig(store);
    const invoked: Array<[string, string]> = [];

    await poll(invoked);
    expectSurvived(store, N, "the FIRST transient failure");
    expect(store.queueRow(N)?.status, "the first transient failure did not put the row back in the queue").toBe("queued");
    expect(refunds(store, N).length, "the first transient failure was not refunded: the attempt was spent on a store hiccup").toBe(1);
    expect(store.queueRow(N)?.attempts, "the refunded attempt was not returned").toBe(0);

    for (let i = 0; i < 6 && store.queueRow(N)?.status !== "failed"; i++) {
      store.lapse();
      await poll(invoked);
    }
    expect(store.queueRow(N)?.claims,
      `a transient failure must be tried ${RESUME_READ_MAX_ATTEMPTS} times before the gig is ended — it was claimed ${store.queueRow(N)?.claims} time(s)`).toBe(RESUME_READ_MAX_ATTEMPTS);
    expect(store.queueRow(N)?.status, "the bounded retry never ended").toBe("failed");
    expect(refunds(store, N).length, "the retries were not refunds").toBe(RESUME_READ_MAX_ATTEMPTS - 1);
    expect(invoked, "a chair ran for a resume whose closed gig could not be read").toEqual([]);
  }, 60_000);
});

describe("V2 — TODAY'S LIVE STORE: a 42501 on a resume-state read SURVIVES and later runs", () => {
  // Round 6 classified this as PERMANENT and terminated the gig on poll 1. It is the answer the live
  // store gives RIGHT NOW to every resuming gig (coltrane-ui #250 as merged; the widening is #253 and
  // has not shipped), so round 6 as written destroys every resume in production.
  //
  // THIS LAW HAS TEETH BY CONSTRUCTION: it is red at 19a4812, and re-planting "an answered 4xx is
  // permanent" anywhere in the classification puts it back to red. It does not merely stop asserting
  // the destructive behaviour — it objects to it.
  const STATUS_42501: Array<[string, ResumedReadMode]> = [
    ["the token's scope (#250 as merged)", "refuse"],
    ["the resumed gig's acting agent holds no seat (unseated or retired), which happens even with #253", "unseated"],
  ];

  it("V2a the closed gig's STATUS read is refused 42501: the resuming gig is refunded and re-claimed, and RESUMES once the store widens", async () => {
    for (const [label, mode] of STATUS_42501) {
      env = hostedEnv();
      const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
      await closeO(store);
      store.set({ claim: null, queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })], resumedRead: { status: mode } });

      const invoked: Array<[string, string]> = [];
      await poll(invoked);
      expectSurvived(store, N, `a 42501 status refusal — ${label}`);
      expect(invoked, `${label}: a chair ran for a resume whose closed gig could not be read`).toEqual([]);
      expect(refunds(store, N).length, `${label}: the gig was not refunded, so the attempt was spent and nothing gave the row back`).toBe(1);
      expect(store.queueRow(N)?.status, `${label}: the row did not go back to the queue`).toBe("queued");

      // The store widens (coltrane-ui #253 ships, or the acting agent is re-seated). A gig that
      // survived is a gig that now works — which is the whole reason not to destroy it.
      store.set({ resumedRead: {} });
      await poll(invoked);
      expect(invoked.map(([, p]) => p), `${label}: the survivor did not resume once the store widened — it either re-paid for scan or never ran`).toEqual(["rescan"]);
      expect(store.queueRow(N)?.status, `${label}: the resumed gig did not complete`).toBe("completed");
      env.cleanup();
    }
  }, 90_000);

  it("V2b the closed gig's OUTPUTS read is refused 42501: the resuming gig is refunded and re-claimed, and RESUMES once the store widens", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store);
    store.set({ claim: null, queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })], resumedRead: { outputs: "refuse" } });

    const invoked: Array<[string, string]> = [];
    await poll(invoked);
    expectSurvived(store, N, "a 42501 refusal on the OUTPUTS read");
    expect(invoked, "a chair ran for a resume whose closed gig's outputs could not be read").toEqual([]);
    expect(refunds(store, N).length, "the gig was not refunded").toBe(1);

    store.set({ resumedRead: {} });
    await poll(invoked);
    expect(invoked.map(([, p]) => p), "the survivor did not resume once the store widened").toEqual(["rescan"]);
    expect(store.queueRow(N)?.status, "the resumed gig did not complete").toBe("completed");
  }, 60_000);
});

describe("V3 — ONE store hiccup fails BOTH reads, and must not destroy the gig", () => {
  // fetchDrainedGenomeHash(<the closed gig>) and nextResumeReadFailureCount(<this gig>) are the SAME
  // RPC (coltrane_mcp_gig_status) on the SAME token, and boundedWorkerRpc has no internal retry. So
  // an unwell store does not merely make the read fail — it also makes the BOUND unestablishable, and
  // 19a4812 ends the gig on that. A thirty-second store restart therefore destroys every resuming gig
  // claimed while it is down. Per the seat's ruling R1 an unestablishable bound is a reason to hand
  // the work back, never a reason to throw it away.
  for (const mode of ["error", "network", "hang"] as const) {
    const what = mode === "error" ? "a 500" : mode === "network" ? "ECONNRESET" : "a store that never answers";
    it(`V3 ${what} on coltrane_mcp_gig_status for BOTH the closed gig and this gig's own header: the resuming gig survives, and resumes when the store comes back`, async () => {
      env = hostedEnv();
      const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
      await closeO(store);
      store.set({ claim: null, queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })] });

      const restart = breakStatusRpc([O, N], mode);
      const invoked: Array<[string, string]> = [];
      await poll(invoked);
      expectSurvived(store, N, `${what} on both status reads`);
      expect(invoked, "a chair ran while the store could not be read").toEqual([]);

      restart.heal();
      store.lapse();
      await poll(invoked);
      expect(invoked.map(([, p]) => p), "the gig did not survive the store restart: it never resumed after the store came back").toEqual(["rescan"]);
      expect(store.queueRow(N)?.status, "the gig did not complete after the store came back").toBe("completed");
    }, 90_000);
  }
});

describe("V4 — the header that would CARRY the bound is refused: still not a reason to destroy", () => {
  // The worker keeps its retry count on this gig's own header (RESUME_READ_FAILURES_KEY). When that
  // write does not land, 19a4812 ends the gig: "the retry count did not reach this gig's header, so
  // the retry cannot be bounded". That is R1's inversion again — an unkeepable count is a reason to
  // hand the work back (or to let the lease lapse and let the STORE's own attempts cap bound it),
  // never a reason to throw it away. The law pins the destruction, not which of the two the
  // implementer picks: either is a survival, and a survival is what is owed.
  it("V4 the drain service refuses the retry-count header (503) while the closed gig's status read is transiently failing: the gig survives, and resumes once both recover", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store);
    let headerDown = true;
    store.set({
      claim: null,
      queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })],
      resumedRead: { status: "error" },
      header: () => (headerDown ? new Response("", { status: 503 }) : undefined),
    });

    const invoked: Array<[string, string]> = [];
    await poll(invoked);
    expectSurvived(store, N, "a 503 on the header carrying the retry count");
    expect(invoked, "a chair ran while the resume state could not be read").toEqual([]);

    headerDown = false;
    store.set({ resumedRead: {} });
    store.lapse();
    await poll(invoked);
    expect(invoked.map(([, p]) => p), "the gig did not survive a header route that was briefly down").toEqual(["rescan"]);
    expect(store.queueRow(N)?.status, "the gig did not complete once the header route recovered").toBe("completed");
  }, 90_000);
});

describe("V5 — PLAYER MODE (no COLTRANE_DRAIN_KEY): the first transient failure is not terminal", () => {
  // remoteConfigured() is false by construction in player mode, so nextResumeReadFailureCount returns
  // "there is no drain to keep this gig's retry count on" on the FIRST failure and every failure
  // after it. At 19a4812 that means: a player-mode resume that meets one store hiccup is destroyed,
  // every time, forever. There is no path on which it survives.
  it("V5 a player-mode resume meets a 500 on the closed gig's status read: it is not failed, no chair runs, and a later poll resumes it", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store); // O closes under the venue path, so the sink holds its real seals

    delete process.env["COLTRANE_DRAIN_KEY"]; // <- player mode: remoteConfigured() is now false
    const player: WorkerContext = { baseUrl: STORE, anonKey: "anon-key", agentToken: `ctk_${N}`, worker: "player-box" };
    store.set({ claim: null, queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })] });

    const outage = breakStatusRpc([O], "error");
    const invoked: Array<[string, string]> = [];
    const outcome = await poll(invoked, player);
    expectSurvived(store, N, "player mode with no drain, first transient failure");
    expect(outcome, "the player-mode run reported a failure for one store hiccup").not.toMatch(/"status":"failed"/);
    expect(invoked, "a chair ran while the closed gig could not be read").toEqual([]);

    outage.heal();
    store.lapse();
    await poll(invoked, player);
    expect(invoked.map(([, p]) => p), "the player-mode resume was destroyed by one store hiccup and never ran").toEqual(["rescan"]);
  }, 90_000);
});

describe("V6 — R2: a closed gig with a status row PRESENT and zero outputs runs COLD", () => {
  // src/worker.ts:1420 — `const permanent = "nothing" in rebuilt || rebuilt.permanent;` — never
  // consults whether the closed gig's status row exists. The spec wrote this case as "the closed gig
  // NO LONGER EXISTS (no status row, no outputs)"; the code implemented "sealed nothing". A gig that
  // exists and died in its first chair before sealing anything has zero chairs to re-pay for, so the
  // cold run is free and correct — and at a1d6925 this worked (invoked = ["scan"]). At 19a4812 it is
  // invoked = [] and permanently failed: a gig destroyed for having got nothing done.
  //
  // U2 above is the OTHER half of the split, and the two together are what make the branch
  // falsifiable: collapse them back into one and one of the two goes red.
  it("V6 the closed gig's status row is there and it sealed nothing: the resuming gig runs COLD and completes", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: null,
      queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O })],
      resumedRead: { outputs: "missing" },
    });
    // The closed gig EXISTS — it died in its first chair, before anything sealed.
    store.gigs.set(O, { id: O, status: "failed", genome_hash: "b".repeat(64), error: "the box went down before the first seal" });

    const invoked: Array<[string, string]> = [];
    await poll(invoked);
    expect(invoked.map(([, p]) => p),
      "a resume of a gig that exists and sealed NOTHING was refused instead of run cold. There are zero chairs to re-pay for, so the cold run is free").toEqual(["scan"]);
    expect(store.queueRow(N)?.status, "the cold run did not complete").toBe("completed");
    expect(terminalReleases(store, N).map((c) => c.body["p_reason"]), "the gig was ended instead of run").toEqual([]);
  }, 30_000);
});

describe("V7 — the closed gig holds no seals AND its status cannot be read: an unread store is not absence", () => {
  // THE PLANT THAT SURVIVED ROUND 8. rebuildFromDrain's empty-outputs branch (src/worker.ts) reads:
  //
  //   const header = await fetchDrainedGenomeHash(ctx, source);
  //   if (header.error !== undefined) return { ok: false, reason: ..., unreadable: true, permanent: ... };
  //   return { ...nothing, exists: header.exists === true };
  //
  // Delete the `header.error` line and an UNREADABLE status collapses into `exists: false` — "no
  // status row and no sealed outputs, it is not there to resume" — which is `gone`, which is the ONE
  // terminal case. So a store that is merely unwell, on a resume whose closed gig happens to hold no
  // seals YET readable, is destroyed on poll one. That is round 6's inversion again, in the one
  // corner nothing reached: U2 has the status readable-and-absent, and V3/V4/V5 all have outputs
  // present, so no existing law puts both failures on the same poll.
  //
  // O here REALLY RAN and its seals REALLY EXIST (closeO) — the outputs read is simply answering
  // empty while the store is unwell. That is what makes the recovery half sayable: the gig that
  // survived goes on to resume from the seals the store denied it had.
  it("V7 the outputs read answers EMPTY while the status read is 500: the resuming gig is handed back, not ended, and resumes from the seals the unwell store denied", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store);
    store.set({
      claim: null,
      queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })],
      resumedRead: { status: "error", outputs: "missing" },
    });

    const invoked: Array<[string, string]> = [];
    const outcome = await poll(invoked);
    expectSurvived(store, N, "an empty outputs answer while the status read was unwell");
    expect(outcome,
      "the gig was ENDED for a store that could not be read. `exists: false` is a fact only a READ can establish; an unread status is not one").not.toMatch(/"status":"failed"/);
    expect(outcome, "the refusal did not name the closed gig it could not read").toContain(O);
    expect(invoked, "a chair ran for a resume whose closed gig could not be read").toEqual([]);
    expect(refunds(store, N).length,
      "the unreadable status was treated as a readable absence, so the row was ended instead of refunded").toBe(1);
    expect(store.queueRow(N)?.status, "the row did not go back to the queue").toBe("queued");
    expect(store.queueRow(N)?.attempts, "the refunded attempt was not returned").toBe(0);

    // The store comes back. O's seals were there the whole time, which is exactly why "no answer"
    // must never have been read as "no gig".
    store.set({ resumedRead: {} });
    await poll(invoked);
    expect(invoked.map(([, p]) => p),
      "the survivor did not resume once the store recovered — it either re-paid for scan or never ran").toEqual(["rescan"]);
    expect(store.queueRow(N)?.status, "the resumed gig did not complete").toBe("completed");
  }, 90_000);
});

describe("V8 — a hand-back the WORKER cannot bound is a LAPSE, never a refund", () => {
  // THE SECOND PLANT THAT SURVIVED ROUND 8: make the lapse path release non-terminally too — i.e.
  // refund everywhere — and all eleven laws stay green, because V3, V4 and V5 assert only that the
  // gig SURVIVES, and a refund is a survival.
  //
  // But the two hand-backs are not interchangeable, and the difference IS the bound:
  //   refund  a non-terminal release. The store RETURNS the attempt (coltrane-ui 20260926040000), so
  //           the store's own max_attempts can never trip and the WORKER's header count is the only
  //           thing that can end the retry.
  //   lapse   no release at all. The row is left leased, the lease runs out, the store re-queues it
  //           WITHOUT refunding, and the store's max_attempts does the bounding.
  //
  // So where the worker's count cannot be ESTABLISHED (V8a: the same RPC on the same token as the
  // read that just failed) or cannot be KEPT (V8b: the header write did not land, so every later
  // poll would refund from the same stale prior forever), a refund is a survival bounded by NOTHING.
  // Round 8 chose the lapse for exactly that reason; these laws are what stops the choice being
  // reverted silently. They assert the absence of a refund and then walk the store's cap to the end,
  // because "no refund" is only half the ruling — the other half is that something still bounds it.
  it("V8a the bound cannot be ESTABLISHED (a 500 on coltrane_mcp_gig_status for BOTH reads): no release at all, the attempt stays spent, and the STORE's max_attempts ends it", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store);
    store.set({
      claim: null,
      queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })],
      maxAttempts: 2, // the STORE's cap is what is being measured here: it is the only bound left
    });

    breakStatusRpc([O, N], "error"); // never healed: the store stays unwell for every poll below
    const invoked: Array<[string, string]> = [];
    const outcome = await poll(invoked);
    expectSurvived(store, N, "the worker's bound could not be established");
    expect(outcome, "an unestablishable bound must leave the row to its lease, not report an outcome for it").toContain('"status":"abandoned"');
    expect(refunds(store, N).length,
      "the row was REFUNDED although the worker's retry count could not be established. The store returns the attempt on every non-terminal release, so its cap can never trip, and the worker has no count either: nothing bounds this retry at all").toBe(0);
    expect(store.queueRow(N)?.status,
      "the row was released back to the queue; a lapse releases nothing and the lease is what returns it").toBe("running");
    expect(store.queueRow(N)?.attempts,
      "the attempt was given back, which is the refund this law forbids under another name").toBe(1);

    // Time passes. The lease lapses, the store re-queues the row WITHOUT refunding, and the attempt
    // it already spent is still counted — which is the whole reason the lapse is bounded.
    store.lapse();
    expect(store.queueRow(N)?.attempts, "the lapse returned the attempt").toBe(1);
    await poll(invoked);
    store.lapse();
    await poll(invoked);

    expect(store.queueRow(N)?.status, "the store's own cap never ended a row nothing else was bounding").toBe("failed");
    expect(store.queueRow(N)?.reason, "the row ended for some reason other than the store's attempts cap").toBe("attempts_exhausted");
    expect(refunds(store, N).length, "some poll refunded the attempt, which would hold the cap off forever").toBe(0);
    expect(invoked, "a chair ran while the store could not be read").toEqual([]);
  }, 90_000);

  it("V8b the bound cannot be KEPT (the header carrying the retry count is refused 503): no release either, and the STORE's max_attempts ends it", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("two-chair-v0", { gig_id: O }) });
    await closeO(store);
    store.set({
      claim: null,
      queue: [claimFor("two-chair-v0", { gig_id: N, resumes: O })],
      maxAttempts: 2,
      resumedRead: { status: "error" },
      header: () => new Response("", { status: 503 }), // the count never reaches this gig's header
    });

    const invoked: Array<[string, string]> = [];
    const outcome = await poll(invoked);
    expectSurvived(store, N, "the worker's retry count could not be kept");
    expect(outcome, "a count that cannot be kept must leave the row to its lease").toContain('"status":"abandoned"');
    expect(refunds(store, N).length,
      "the row was REFUNDED although the count that would bound the retry never landed. The next poll reads the same stale prior, refunds from it again, and does so for as long as the header route stays down").toBe(0);
    expect(store.queueRow(N)?.status, "the row was released back to the queue instead of left to its lease").toBe("running");
    expect(store.queueRow(N)?.attempts, "the attempt was given back, so the store's cap can never see it").toBe(1);

    store.lapse();
    await poll(invoked);
    store.lapse();
    await poll(invoked);

    expect(store.queueRow(N)?.status, "the store's own cap never ended a row the worker could not bound").toBe("failed");
    expect(store.queueRow(N)?.reason, "the row ended for some reason other than the store's attempts cap").toBe("attempts_exhausted");
    expect(refunds(store, N).length, "some poll refunded the attempt").toBe(0);
    expect(invoked, "a chair ran while the resume state could not be read").toEqual([]);
  }, 90_000);
});
