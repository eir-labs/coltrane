// L1 — A LATE ANSWER AFTER A LOST LEASE IS NEVER SEALED. (docs/specs/gig-runs-once.red-spec.json)
//
// E4 proves a lost lease aborts the run's signal. Its chair HONOURS that signal and throws, so E4
// cannot see what happens when a chair does not. Some invokers do not honour it: a completions
// call already in flight, or a tool loop that never polls the signal. Those answer anyway, after
// the store has said the gig belongs to someone else. If that answer is sealed, the record carries
// a result from a worker that no longer held the gig. That is the double run again, and it goes
// straight into the chain.
//
// The law uses a chair that IGNORES the abort: it fires the heartbeat, the renew is refused
// (403 / 42501), and it answers normally anyway. That answer must not be sealed locally, must not
// be drained, and must not start the next chair. The run ends `abandoned`, the result vocabulary
// for a lost lease.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, GIG_ID, TERMINAL,
} from "./gig_runs_once_fixtures.js";

type Beat = () => Promise<unknown>;

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("L1 — an answer that arrives after the lease was lost is not sealed", () => {
  it("L1 a chair that ignores the abort and answers after renew is refused: nothing sealed, nothing drained, no next chair, the run is `abandoned`", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("two-chair-v0"),
      renew: () => new Response(JSON.stringify({ code: "42501", message: "lease not held by this instance" }), { status: 403 }),
    });
    const beats: Beat[] = [];
    let signalAbortedBeforeAnswer = false;
    const invoke = vi.fn(async (ctx: { signal?: AbortSignal }) => {
      for (const b of beats) await b().catch(() => undefined);
      signalAbortedBeforeAnswer = ctx.signal?.aborted === true;
      return sealableSignal; // answers ANYWAY: this invoker does not honour the signal
    });
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => invoke as unknown as AgentInvoker,
      scheduleHeartbeat: (_ms: number, beat: Beat) => { beats.push(beat); return () => undefined; },
    } as unknown as WorkOnceDeps);
    await settle();

    expect(beats.length, "precondition: a heartbeat was armed").toBe(1);
    expect(store.renews().length, "precondition: the renew was sent and refused").toBeGreaterThanOrEqual(1);
    expect(signalAbortedBeforeAnswer, "precondition: the lease loss reached the signal before the chair answered").toBe(true);
    expect(sealedLocally(env.stateRoot, GIG_ID), "the late answer was SEALED after the lease was lost").toEqual([]);
    expect(store.outputRows().map((c) => c.body["id"]), "the late answer was drained after the lease was lost").toEqual([]);
    expect(invoke, "the late answer started the next chair").toHaveBeenCalledTimes(1);
    expect(store.headers().filter((c) => TERMINAL.has(String(c.body["status"]))).map((c) => c.body["status"])).toEqual([]);
    expect(res.claimed && res.status, "a lost lease ends the run `abandoned`").toBe("abandoned");
  });
});
