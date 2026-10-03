// E5 — A WORKER THAT WILL NOT RUN A ROW RELEASES IT; IT NEVER HOLDS IT. (docs/specs/gig-runs-once.red-spec.json)
//
// Three paths in src/worker.ts end with a leased row and a worker that has walked away from it:
//   * the store leased a row but minted no credential — claimNextGig throws, "the row stays leased";
//   * the claim names a venue this box cannot realize — claimNextGig throws, "the row stays leased";
//   * the run failed and failGig itself threw — "could not record failure (lease will expire)".
// Each costs one full lease window (sixty minutes) of a gig nobody is running, and the comments call
// that the accepted price because "every release RPC speaks through the credential that was not
// minted". The drain service's coltrane_drain_release speaks through the VENUE credential — the one
// the box always holds — so that premise no longer holds, and neither does the price.
//
// The contract (store PR eir-labs/coltrane-ui #250): coltrane_drain_release(p_token, p_instance, p_gig_id,
// p_reason, p_terminal), where the ROUTE fills p_token from the bearer and p_instance from
// X-Coltrane-Instance — so the engine's body is {p_gig_id, p_reason, p_terminal} and the instance
// travels only in the header. Refusals that are not the gig's
// fault release NON-terminally (the row goes back to the queue for a box that can run it), naming
// the cause; a failure the store would not record falls back to a TERMINAL release carrying the error.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps, type WorkerContext } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, loadLease, GIG_ID, INSTANCE, DRAIN_KEY,
} from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

const deps = (invoke: unknown): WorkOnceDeps => ({ makeInvoke: () => invoke as AgentInvoker });

async function expectRelease(store: ReturnType<typeof hostedStore>, terminal: boolean, reason: RegExp): Promise<void> {
  const rel = store.releases();
  expect(rel.length, "the row was left leased — no release was sent").toBe(1);
  const b = rel[0]!.body;
  expect(Object.keys(b).sort(), "release's body is the store route's shape: {p_gig_id, p_reason, p_terminal}; the instance rides the header only").toEqual(["p_gig_id", "p_reason", "p_terminal"]);
  expect(b["p_gig_id"]).toBe(GIG_ID);
  expect(rel[0]!.headers["X-Coltrane-Instance"], "the instance travels in the header the route reads").toBe(INSTANCE);
  expect(b["p_terminal"], terminal ? "a failure the store would not record must release TERMINALLY" : "a refusal that is not the gig's fault must release NON-terminally, back to the queue").toBe(terminal);
  expect(String(b["p_reason"] ?? ""), "the release must name its cause").toMatch(reason);
  expect(rel[0]!.headers["Authorization"], "release speaks with the venue credential, the one the box always holds").toBe(`Bearer ${DRAIN_KEY}`);
  const { DRAIN_LEASE_ROUTES } = await loadLease();
  expect(rel[0]!.path).toBe(DRAIN_LEASE_ROUTES.release);
}

describe("E5 — release, never hold", () => {
  it("E5a a claim the store leased WITHOUT minting a credential is released (non-terminal), not held for the lease window", async () => {
    env = hostedEnv();
    const noToken = { ...claimFor("one-chair-v0") } as Record<string, unknown>;
    delete noToken["token"];
    const store = hostedStore({ claim: noToken });
    const invoke = vi.fn();
    await workOnce(venueCtx(), deps(invoke)).catch((e: unknown) => e);
    expect(invoke).not.toHaveBeenCalled();
    await expectRelease(store, false, /credential|mint/i);
  });

  it("E5b a claim naming a venue this box cannot realize is released (non-terminal) naming the venue", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0", { venue: "the-far-room" }) });
    const invoke = vi.fn();
    const ctx: WorkerContext = { ...venueCtx(), realizableVenues: ["the-near-room"] };
    await workOnce(ctx, deps(invoke)).catch((e: unknown) => e);
    expect(invoke).not.toHaveBeenCalled();
    await expectRelease(store, false, /the-far-room/);
  });

  it("E5c a failGig that THROWS falls back to a TERMINAL release carrying the run's error", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      gigFail: () => new Response(JSON.stringify({ message: "store unavailable" }), { status: 500 }),
    });
    const invoke = vi.fn(async () => { throw new Error("the model never came back"); });
    const res = await workOnce(venueCtx(), deps(invoke));
    expect(res.claimed && res.status).toBe("failed");
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")), "failGig was not even tried first").toBe(true);
    await expectRelease(store, true, /never came back/);
  });
});
