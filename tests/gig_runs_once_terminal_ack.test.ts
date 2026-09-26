// E2 — A TERMINAL WRITE IS ACKNOWLEDGED, OR IT IS REPORTED. (docs/specs/gig-runs-once.red-spec.json)
//
// The completion header is the ONLY way 'completed' reaches the store (src/runtime.ts, the `void
// drainGigHeader(...)` on the success path), and it is fire-and-forget into a process that exits as
// soon as workOnce returns. When that fetch dies with the process, the row stays 'running', its
// lease expires, and the store hands the finished gig to the next worker, which runs it again and
// pays again. The failed path is the same `void`. Errors on both are printed only under
// COLTRANE_DRAIN_DEBUG, so the loss is silent in exactly the deployment where it costs money.
//
// The contract: both terminal headers are AWAITED; a transient refusal is retried, at most
// TERMINAL_ATTEMPTS times; workOnce does not report success until the store acknowledged; when it
// never does, workOnce says so (`acknowledged: false`), logs it whatever COLTRANE_DRAIN_DEBUG says,
// and `coltrane work` exits non-zero so a supervisor sees a worker that did not finish its job.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import { runCli, type CliIO } from "../src/cli.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, lateAck, VERDICT, STORE, GIG_ID,
} from "./gig_runs_once_fixtures.js";

/** Pinned: a terminal header is tried at most three times before the worker gives up and says so. */
const TERMINAL_ATTEMPTS = 3;
const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

const field = (res: unknown, k: string): unknown => (res as Record<string, unknown>)[k];

describe("E2 — the terminal header is awaited, retried, and its loss is reported", () => {
  it("E2a workOnce does not return 'complete' until the store has ACKNOWLEDGED the completed header", async () => {
    env = hostedEnv();
    const ack = { done: false };
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "completed" ? lateAck(ack, 80) : undefined),
    });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    const ackedAtReturn = ack.done;
    expect(res.claimed && res.status).toBe("complete");
    expect(store.headers().some((c) => c.body["status"] === "completed"), "no completed header was even sent").toBe(true);
    expect(ackedAtReturn, "workOnce returned 'complete' while the completed header was still in flight — fire-and-forget").toBe(true);
    expect(field(res, "acknowledged"), "an acknowledged completion must say so").toBe(true);
  });

  it("E2b a transient refusal of the completed header is RETRIED until acknowledged (within the bound)", async () => {
    env = hostedEnv();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b, n) => (b["status"] === "completed" && n < TERMINAL_ATTEMPTS ? unavailable() : undefined),
    });
    const res = await workOnce(venueCtx(), { makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker } as WorkOnceDeps);
    const tries = store.headers().filter((c) => c.body["status"] === "completed").length;
    expect(tries, "a 503 on the completed header was not retried").toBe(TERMINAL_ATTEMPTS);
    expect(store.gigs.get(GIG_ID)?.["status"], "the store never learned the gig completed").toBe("completed");
    expect(field(res, "acknowledged")).toBe(true);
  }, 20_000);

  it("E2c a completed header the store NEVER acknowledges is reported (acknowledged:false) and LOGGED without COLTRANE_DRAIN_DEBUG", async () => {
    env = hostedEnv();
    expect(process.env["COLTRANE_DRAIN_DEBUG"]).toBeUndefined();
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "completed" ? unavailable() : undefined),
    });
    const lines: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    try {
      const res = await workOnce(venueCtx(), {
        makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker,
        log: (l: string) => lines.push(l),
      } as WorkOnceDeps);
      const tries = store.headers().filter((c) => c.body["status"] === "completed").length;
      expect(tries, `a terminal header must be tried exactly ${TERMINAL_ATTEMPTS} times, then given up on`).toBe(TERMINAL_ATTEMPTS);
      expect(res.claimed).toBe(true);
      expect(field(res, "acknowledged"), "workOnce reported a completion the store never recorded as if it were done").toBe(false);
      const said = lines.filter((l) => /header|acknowledg/i.test(l));
      expect(said.length, `the lost completion was not logged (debug off). lines:\n${lines.join("\n")}`).toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 20_000);

  it("E2d the FAILED header is awaited and retried too — a failed run's truth reaches the store before workOnce returns", async () => {
    env = hostedEnv();
    const ack = { done: false };
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b, n) => {
        if (b["status"] !== "failed") return undefined;
        return n === 1 ? unavailable() : lateAck(ack, 80);
      },
    });
    const invoke = vi.fn(async () => { throw new Error("the model never came back"); });
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    const ackedAtReturn = ack.done;
    expect(res.claimed && res.status).toBe("failed");
    const tries = store.headers().filter((c) => c.body["status"] === "failed").length;
    expect(tries, "a 503 on the failed header was not retried").toBe(2);
    expect(ackedAtReturn, "workOnce returned while the failed header was still in flight — fire-and-forget").toBe(true);
  }, 20_000);

  it("E2e `coltrane work` exits NON-ZERO when the completion was never acknowledged", async () => {
    env = hostedEnv();
    const saved = { url: process.env["COLTRANE_STORE_URL"], anon: process.env["COLTRANE_STORE_ANON"], tok: process.env["COLTRANE_AGENT_TOKEN"] };
    process.env["COLTRANE_STORE_URL"] = STORE;
    process.env["COLTRANE_STORE_ANON"] = "anon-key";
    delete process.env["COLTRANE_AGENT_TOKEN"];
    try {
      // A human-only standard whose approval rides the claim: it completes with no model call, so
      // this drives the REAL `work` door (its own invoker, its own realizer) end to end.
      const store = hostedStore({
        claim: claimFor("human-only-v0", { approvals: { approve: { verdict: VERDICT, approved_by: "eugene" } } }),
        header: (b) => (b["status"] === "completed" ? unavailable() : undefined),
      });
      let out = "";
      const io: CliIO = { out: (s) => { out += s; }, err: (s) => { out += s; } };
      const code = await runCli(["work"], io);
      expect(store.headers().some((c) => c.body["status"] === "completed"), `the run never reached its completion header:\n${out}`).toBe(true);
      expect(code, `a worker whose completion the store never recorded exited ${code}:\n${out}`).not.toBe(0);
    } finally {
      for (const [k, v] of [["COLTRANE_STORE_URL", saved.url], ["COLTRANE_STORE_ANON", saved.anon], ["COLTRANE_AGENT_TOKEN", saved.tok]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 20_000);
});
