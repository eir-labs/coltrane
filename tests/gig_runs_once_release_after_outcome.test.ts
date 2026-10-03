// G2 + ATTEMPT REFUND — WHICH RELEASES A WORKER MAY STILL SEND ONCE IT HAS SPENT.
// (docs/specs/gig-runs-once.red-spec.json)
//
// The store (eir-labs/coltrane-ui #250) counts an attempt on every claim and REFUNDS it on a
// non-terminal release. A non-terminal release says "I never started; hand this row to someone who
// can run it". So a non-terminal release after a chair has been invoked is wrong twice over. It
// refunds an attempt that really was spent, which lets a poisoned gig loop forever under
// max_attempts. And it re-queues a gig whose outcome is already decided, which is the double run
// again.
//
// Rulings (conductor, from Eugene's):
//   G2: after the outcome is decided the worker never sends a non-terminal release. If the terminal
//       header cannot be acknowledged, workOnce returns acknowledged:false and sends NO release at
//       all. The lease lapses, and the re-claim finishes the gig by resuming it (E6/E9).
//   REFUND: a non-terminal release goes out only BEFORE any chair has been invoked. Once one has
//       been, every release this worker sends is terminal.
//
// Each law opens with a precondition that is red at 33ad276 (acknowledged:false, a release actually
// sent). That keeps the "no non-terminal release" assertion from passing because nothing happens.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle } from "./gig_runs_once_fixtures.js";

const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
const field = (res: unknown, k: string): unknown => (res as Record<string, unknown>)[k];

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("G2 — once the outcome is decided, an unacknowledged terminal header sends no release", () => {
  it("G2a completed but never acknowledged: acknowledged:false and NO release of any kind", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "completed" ? unavailable() : undefined),
    });
    const res = await workOnce(venueCtx(), { makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker } as WorkOnceDeps);
    await settle();
    expect(field(res, "acknowledged"), "precondition: the worker must report that it gave up on the completed header (E2)").toBe(false);
    expect(store.releases().map((c) => c.body), "the outcome was decided, and the worker released the row anyway").toEqual([]);
  }, 20_000);

  it("G2b failed but the failed header never acknowledged (gig_fail recorded): acknowledged:false and NO release of any kind", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "failed" ? unavailable() : undefined),
    });
    const invoke = vi.fn(async () => { throw new Error("the model never came back"); });
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status).toBe("failed");
    expect(field(res, "acknowledged"), "precondition: the worker must report that it gave up on the failed header (E2)").toBe(false);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "precondition: the failure was recorded through gig_fail").toBe(true);
    expect(store.releases().map((c) => c.body),
      "the outcome was decided and recorded, and the worker released the row anyway").toEqual([]);
  }, 20_000);
});

describe("ATTEMPT REFUND — after the first chair is invoked, every release is terminal", () => {
  it("REFUND a chair ran, the run failed, and failGig threw: the release this worker sends is TERMINAL, never a refund", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      gigFail: () => new Response(JSON.stringify({ message: "store unavailable" }), { status: 500 }),
    });
    const invoke = vi.fn(async () => { throw new Error("the model never came back"); });
    await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    await settle();
    expect(invoke, "precondition: a chair was invoked").toHaveBeenCalledTimes(1);
    const rel = store.releases();
    expect(rel.length, "precondition: a worker whose failGig threw must release the row, not hold it (E5c)").toBeGreaterThan(0);
    expect(rel.filter((c) => c.body["p_terminal"] !== true).map((c) => c.body),
      "a NON-terminal release after a chair was invoked refunds an attempt that was really spent").toEqual([]);
  });
});
