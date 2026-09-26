// E1 — A GIG ANNOUNCES ITSELF BEFORE IT SPENDS. (docs/specs/gig-runs-once.red-spec.json)
//
// The re-claim path (rebuildFromDrain, src/worker.ts) will only resume a gig whose drained header
// carries a 64-hex genome_hash, and today the ONLY header that carries one is the terminal header —
// the one written fire-and-forget as the process exits (src/runtime.ts complete/failed drains). So
// exactly the gig that most needs resuming — one whose completion was lost — is the one that cannot
// be resumed, and it runs cold: the second payment this battery exists to stop.
//
// The fix is an AWAITED 'running' header, carrying the run's genome_hash, written before the first
// chair is invoked. Awaited is the point: an unawaited start header can lose the same race the
// terminal header loses. The law therefore holds the acknowledgement back and asserts the first chair
// was not reached until the store had answered.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import { rpcGenomeStore } from "../src/genome_store.js";
import { genomeHash, type AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, lateAck, GIG_ID,
} from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

describe("E1 — the start header is written, and acknowledged, before the first chair runs", () => {
  it("E1 an awaited 'running' header carrying the 64-hex genome_hash precedes the first chair invocation", async () => {
    env = hostedEnv();
    const ack = { done: false };
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b) => (b["status"] === "running" ? lateAck(ack, 80) : undefined),
    });
    const seenAtFirstChair: { headers: number; acked: boolean }[] = [];
    const invoke = vi.fn(async () => {
      seenAtFirstChair.push({
        headers: store.headers().filter((c) => c.body["status"] === "running").length,
        acked: ack.done,
      });
      return sealableSignal;
    });
    const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
    expect(res.claimed && res.status, `the gig itself must still run: ${JSON.stringify(res)}`).toBe("complete");
    expect(invoke).toHaveBeenCalledTimes(1);

    const running = store.headers().filter((c) => c.body["status"] === "running");
    expect(running.length, "no 'running' header was written at all — a re-claim has no genome_hash to resume against").toBeGreaterThanOrEqual(1);
    expect(seenAtFirstChair[0]!.headers, "the 'running' header was sent AFTER the first chair was invoked").toBeGreaterThanOrEqual(1);
    expect(seenAtFirstChair[0]!.acked, "the first chair ran before the store ACKNOWLEDGED the 'running' header — it was not awaited").toBe(true);

    const first = running[0]!;
    expect(first.body["id"]).toBe(GIG_ID);
    const gh = first.body["genome_hash"];
    expect(typeof gh === "string" && /^[0-9a-f]{64}$/.test(gh), `the start header's genome_hash is not 64-hex: ${JSON.stringify(gh)}`).toBe(true);
    // Not any 64-hex string: the one the re-claim will compare against — the run's own.
    const genome = await rpcGenomeStore(venueCtx()).load();
    expect(gh).toBe(genomeHash(genome.standards.get("one-chair-v0")!));
    // And it went where every header goes: the drain service, under the instance's own name.
    expect(first.headers["Authorization"]).toMatch(/^Bearer cdk_/);
    expect(first.headers["X-Coltrane-Instance"]).toBeDefined();
  });
});
