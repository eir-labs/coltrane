// E6 — A RE-CLAIM FINISHES THE GIG; IT DOES NOT RUN IT AGAIN. (docs/specs/gig-runs-once.red-spec.json)
//
// The scenario the other laws exist to make rare, and this one exists to make CHEAP when it happens
// anyway: worker A runs every chair, every output drains, and then the completion never reaches the
// store (A died, or the store never acknowledged). The lease expires and worker B — a fresh box, no
// local checkpoint — claims the same row.
//
// Every sealed output is in the sink. B could restore all of them and simply write the completion.
// It cannot today, because rebuildFromDrain (src/worker.ts) refuses to resume without a 64-hex
// genome_hash on the drained header, and the only header that carries one is the terminal header
// that was lost. So B runs the whole gig COLD — the second payment for work already paid for.
//
// The law is END TO END through one stateful store: B reads exactly what A's writes left behind (a
// hand-written header here would pass whatever A did). A's completion is refused on every attempt;
// the store then recovers for B.
//
// Second law: when a resume IS refused for a real reason (the genome moved), the cold run is not
// silent — the reason reaches the gig's header manifest (`manifest.cold_run_reason`), where the
// operator who is paying for it can see it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import { rpcGenomeStore } from "../src/genome_store.js";
import { genomeHash, type AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle, GIG_ID,
} from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
const extraRoots: string[] = [];
afterEach(() => {
  env?.cleanup();
  for (const r of extraRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });

/** Worker A: runs the gig on its OWN state root; its completion header is never acknowledged. */
async function workerAWhoseCompletionIsLost(store: ReturnType<typeof hostedStore>): Promise<number> {
  const rootA = mkdtempSync(join(tmpdir(), "coltrane-runs-once-A-"));
  extraRoots.push(rootA);
  const rootB = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = rootA;
  store.set({ header: (b) => (b["status"] === "completed" ? unavailable() : undefined) });
  const invokeA = vi.fn(async () => sealableSignal);
  try {
    await workOnce(venueCtx(), { makeInvoke: () => invokeA as unknown as AgentInvoker } as WorkOnceDeps);
  } finally {
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = rootB;
  }
  await settle(); // let A's output drains land in the sink
  store.set({ header: undefined }); // the store recovers for B
  return invokeA.mock.calls.length;
}

describe("E6 — a re-claim finishes without re-running", () => {
  it("E6a a fresh worker re-claiming a gig whose completion was lost completes it with ZERO model calls and writes the terminal header", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    const paidByA = await workerAWhoseCompletionIsLost(store);
    expect(paidByA, "worker A must have run the chair once").toBe(1);
    expect(store.outputs.filter((o) => o["gig_id"] === GIG_ID).length, "A's sealed output must be in the sink").toBe(1);
    expect(store.gigs.get(GIG_ID)?.["status"], "A's completion must NOT have reached the store — that is the scenario").not.toBe("completed");

    const lines: string[] = [];
    const invokeB = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), { makeInvoke: () => invokeB as unknown as AgentInvoker, log: (l: string) => lines.push(l) } as WorkOnceDeps);
    expect(res.claimed && res.status).toBe("complete");
    expect(invokeB.mock.calls.length, `worker B paid again for a chair already sealed in the sink:\n${lines.join("\n")}`).toBe(0);

    const genome = await rpcGenomeStore(venueCtx()).load();
    const completed = store.headers().filter((c) => c.body["status"] === "completed" && c.body["id"] === GIG_ID);
    const acked = store.gigs.get(GIG_ID);
    expect(acked?.["status"], "B did not bring the store's row to completed").toBe("completed");
    expect(completed.at(-1)!.body["genome_hash"]).toBe(genomeHash(genome.standards.get("one-chair-v0")!));
  }, 30_000);

  it("E6b a resume REFUSED for a real reason (the genome moved) runs cold AND records why, in the gig's header manifest", async () => {
    env = hostedEnv();
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    await workerAWhoseCompletionIsLost(store);
    // The genome moved between A and B: the sink's identity for this gig is not the one B would run.
    store.gigs.set(GIG_ID, { ...(store.gigs.get(GIG_ID) ?? { id: GIG_ID }), genome_hash: "a".repeat(64) });

    const invokeB = vi.fn(async () => sealableSignal);
    const res = await workOnce(venueCtx(), { makeInvoke: () => invokeB as unknown as AgentInvoker } as WorkOnceDeps);
    expect(res.claimed && res.status).toBe("complete");
    expect(invokeB.mock.calls.length, "a moved genome must NOT be resumed across — B pays, correctly").toBe(1);

    const reasons = store.headers()
      .filter((c) => c.body["id"] === GIG_ID)
      .map((c) => (c.body["manifest"] as Record<string, unknown> | undefined)?.["cold_run_reason"])
      .filter((r): r is string => typeof r === "string");
    expect(reasons.length, "the cold run was SILENT — no header B wrote says why the gig was paid for twice").toBeGreaterThan(0);
    expect(reasons.join(" "), "the recorded reason must name the cause").toMatch(/genome/i);
  }, 30_000);
});
