// E9 — A GIG'S OUTPUTS LAND BEFORE ITS COMPLETION DOES. (docs/specs/gig-runs-once.red-spec.json)
//
// Every sealed output reaches the sink through mirror.persist → `void drainRemote(rec)`
// (src/output_mirror.ts): fire-and-forget, and nothing waits for it. So once E2 makes the terminal
// header acknowledged, the store can hold a row that says 'completed' over a sink that is missing
// the outputs it completed WITH, and it will never re-run it (the terminal guard sees to that).
// That is a finished gig with no work product, and nothing records the loss. The re-claim path (E6)
// has the same dependency: it can only resume from rows that actually landed.
//
// The contract: the 'completed' header is written only after EVERY output drain for the gig has
// been acknowledged. An output row the drain service will not take, after the same bounded retry
// the terminal header gets (3 attempts), means the gig is NOT reported complete. That shows up as
// acknowledged:false, no completed header, a log line whether or not COLTRANE_DRAIN_DEBUG is set, and
// a non-zero exit from `coltrane work`.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import { runCli, type CliIO } from "../src/cli.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, lateAck, settle, VERDICT, STORE, GIG_ID,
} from "./gig_runs_once_fixtures.js";

const ATTEMPTS = 3; // the terminal header's policy, applied to every output row
const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
const field = (res: unknown, k: string): unknown => (res as Record<string, unknown>)[k];

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("E9 — outputs are acknowledged before the gig is reported complete", () => {
  it("E9a the 'completed' header is sent only AFTER the store acknowledged every output row of the gig", async () => {
    env = hostedEnv();
    const ack = { done: false };
    let ackedWhenCompletedSent: boolean | undefined;
    const store = hostedStore({
      claim: claimFor("two-chair-v0"),
      // hold the FIRST output row's acknowledgement back, which is the one a void drain races
      outputs: (_b, n) => (n === 1 && !ack.done ? lateAck(ack, 120) : undefined),
      header: (b) => {
        if (b["status"] === "completed" && ackedWhenCompletedSent === undefined) ackedWhenCompletedSent = ack.done;
        return undefined;
      },
    });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    await settle(200);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(res.claimed && res.status).toBe("complete");
    expect(store.outputs.filter((o) => o["gig_id"] === GIG_ID).length, "both sealed outputs must reach the sink").toBe(2);
    expect(ackedWhenCompletedSent, "no completed header was sent at all").not.toBeUndefined();
    expect(ackedWhenCompletedSent, "the gig was declared 'completed' while one of its outputs was still in flight").toBe(true);
    expect(field(res, "acknowledged")).toBe(true);
  });

  it("E9b an output row the drain service NEVER acknowledges: retried to the bound, NO completed header, acknowledged:false, logged without debug", async () => {
    env = hostedEnv();
    expect(process.env["COLTRANE_DRAIN_DEBUG"]).toBeUndefined();
    const store = hostedStore({ claim: claimFor("one-chair-v0"), outputs: () => unavailable() });
    const lines: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
    try {
      const res = await workOnce(venueCtx(), {
        makeInvoke: () => (async () => sealableSignal) as unknown as AgentInvoker,
        log: (l: string) => lines.push(l),
      } as WorkOnceDeps);
      await settle();
      expect(store.outputRows().length, `an output row must be tried exactly ${ATTEMPTS} times, then given up on`).toBe(ATTEMPTS);
      expect(store.headers().filter((c) => c.body["status"] === "completed").map((c) => c.body["status"]),
        "the store was told 'completed' about a gig whose output never landed").toEqual([]);
      expect(field(res, "acknowledged"), "workOnce reported the gig finished though its output never reached the store").toBe(false);
      expect(lines.filter((l) => /output/i.test(l) && /drain|acknowledg|land/i.test(l)).length,
        `the lost output was not logged (debug off). lines:\n${lines.join("\n")}`).toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }, 20_000);

  it("E9c `coltrane work` exits NON-ZERO when a sealed output never reached the store", async () => {
    env = hostedEnv();
    const saved = { url: process.env["COLTRANE_STORE_URL"], anon: process.env["COLTRANE_STORE_ANON"], tok: process.env["COLTRANE_AGENT_TOKEN"] };
    process.env["COLTRANE_STORE_URL"] = STORE;
    process.env["COLTRANE_STORE_ANON"] = "anon-key";
    delete process.env["COLTRANE_AGENT_TOKEN"];
    try {
      // The human chair's Judgment is a sealed output like any other and drains the same way.
      const store = hostedStore({
        claim: claimFor("human-only-v0", { approvals: { approve: { verdict: VERDICT, approved_by: "eugene" } } }),
        outputs: () => unavailable(),
      });
      let out = "";
      const io: CliIO = { out: (s) => { out += s; }, err: (s) => { out += s; } };
      const code = await runCli(["work"], io);
      expect(store.outputRows().length, `the run never tried to drain its output:\n${out}`).toBeGreaterThan(0);
      expect(code, `a worker whose output never reached the store exited ${code}:\n${out}`).not.toBe(0);
    } finally {
      for (const [k, v] of [["COLTRANE_STORE_URL", saved.url], ["COLTRANE_STORE_ANON", saved.anon], ["COLTRANE_AGENT_TOKEN", saved.tok]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 20_000);
});
