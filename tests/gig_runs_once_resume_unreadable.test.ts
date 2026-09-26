// U1–U4 — AN UNREADABLE RESUME NEVER STALLS THE QUEUE. (docs/specs/gig-runs-once.red-spec.json)
//
// Review 5327331488 (NOT MERGEABLE at edcb239). B2 made a `resumes` claim whose closed gig cannot be
// read refuse, release NON-terminally and refund the attempt. That is right for a TRANSIENT failure.
// For a PERMANENT one it is a trap:
//   * the store's claim doors take the OLDEST eligible row;
//   * a refunded row goes back to `queued` with its attempt count unchanged;
//   * so the next poll claims the same dead row first, refuses it, and refunds it again;
//   * the attempts cap never trips, and every gig behind it in the org never runs.
// The reviewer reproduced this on a real store twice: without coltrane-ui #253 (scope 42501), and WITH
// #253 once the resumed gig's acting agent had been unseated ("agent … holds no seat", also 42501).
//
// The contract, laws:
//   U1 TRANSIENT (5xx, a network error, no answer) → refund and re-queue. B2 carries these cases.
//   U2 PERMANENT (42501 scope refusal; an unseated or retired acting agent; a closed gig that no longer
//      exists) → the gig is TERMINATED: failed, with a named reason, non-retryable, NO refund, nothing
//      invoked. The store's terminal release, or gig_fail, is what does it.
//   U3 THE QUEUE ADVANCES: with a permanently unreadable resume at the head of the queue and a healthy
//      gig behind it, successive polls run the healthy gig and never re-claim the dead one.
//   U4 A TRANSIENT FAILURE THAT PERSISTS STILL ENDS. The attempts cap (coltrane-ui #250) applies, and
//      the queue never spins forever behind it. The store refunds every non-terminal release
//      (20260926040000), so refunding on every poll can never reach the cap. The engine must bound it
//      somehow; the law pins only that it ends.
//
// The fake store models the queue as the store has it (see `queue` in the fixture): oldest first,
// every claim counts, a non-terminal release refunds, a terminal release or gig_fail fails, and the cap
// fails `attempts_exhausted`. `lapse()` is time passing between polls.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, settle, type ResumedReadMode } from "./gig_runs_once_fixtures.js";

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
async function poll(invoked: Array<[string, string]>): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "coltrane-r6g-box-"));
  roots.push(root);
  const saved = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = root;
  try {
    const res = await workOnce(venueCtx(), {
      makeInvoke: () => (async (ctx: AgentInvocationContext) => {
        invoked.push([String((ctx as unknown as { gig_id?: string }).gig_id ?? "?"), ctx.phase]);
        return answer(ctx.phase);
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

const PERMANENT: Array<[string, { status?: ResumedReadMode; outputs?: ResumedReadMode }]> = [
  ["status refused 42501: the token's scope (#250 as merged)", { status: "refuse" }],
  ["status refused 42501: the resumed gig's acting agent holds no seat (unseated or retired), which happens even with #253", { status: "unseated" }],
  ["outputs refused 42501", { outputs: "refuse" }],
  ["the closed gig no longer exists (no status row, no outputs): never a cold run", { status: "missing", outputs: "missing" }],
];

describe("U2 — a PERMANENTLY unreadable resume TERMINATES the gig: failed, named, no refund, nothing invoked", () => {
  for (const [label, resumedRead] of PERMANENT) {
    it(`U2 ${label}`, async () => {
      env = hostedEnv();
      const store = hostedStore({ claim: null, queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O })], resumedRead });
      if (resumedRead.status !== "missing") seedClosedGig(store);
      const invoked: Array<[string, string]> = [];
      const outcome = await poll(invoked);

      expect(invoked, "a chair ran for a resume whose closed gig cannot be read").toEqual([]);
      expect(store.queueRow(N)?.claims, "precondition: the resuming gig was claimed").toBe(1);
      const nonTerminal = store.releases().filter((c) => c.body["p_gig_id"] === N && c.body["p_terminal"] === false);
      expect(nonTerminal.map((c) => c.body["p_reason"]),
        "a PERMANENT failure was released non-terminally: the attempt is refunded and the same dead row heads the queue on every poll").toEqual([]);
      expect(store.queueRow(N)?.status, "the gig was not terminated (terminal release or gig_fail)").toBe("failed");
      expect(store.queueRow(N)?.attempts, "the attempt was refunded").toBe(1);
      expect(outcome, "the refusal must name the gig it could not resume").toContain(O);
      const reason = store.queueRow(N)?.reason ?? "";
      expect(reason, "the terminated gig's reason must name the resume and the closed gig").toMatch(/resum/i);
      expect(reason).toContain(O);
    });
  }
});

describe("U3 — the queue advances past a permanently unreadable resume", () => {
  for (const [label, resumedRead] of PERMANENT.slice(0, 2)) {
    it(`U3 ${label.includes("seat") ? "an unseated acting agent (42501)" : "a scope refusal (42501)"} at the head, a healthy gig behind: within three polls the healthy gig runs, and the dead one is claimed once`, async () => {
      env = hostedEnv();
      const store = hostedStore({
        claim: null,
        queue: [claimFor("one-chair-v0", { gig_id: N, resumes: O }), claimFor("one-chair-v0", { gig_id: H })],
        resumedRead,
      });
      seedClosedGig(store);
      const invoked: Array<[string, string]> = [];
      for (let i = 0; i < 3 && store.queueRow(H)?.status !== "completed"; i++) {
        await poll(invoked);
        store.lapse();
      }
      expect(store.queueRow(N)?.claims, "the dead resume was claimed again. It heads the queue on every poll, and the org STALLS").toBe(1);
      expect(store.queueRow(H)?.status, "the healthy gig behind the dead resume never ran").toBe("completed");
    });
  }
});

describe("U4 — a transient failure that persists still ends; nothing spins forever", () => {
  it("U4 the resumed gig's status read keeps failing with 500: within eight polls it ENDS (failed; the attempts cap applies), and the healthy gig behind it runs", async () => {
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
    expect(store.queueRow(N)?.claims ?? 0, "the persistent transient failure was retried beyond the attempts cap").toBeLessThanOrEqual(4);
    expect(store.queueRow(H)?.status, "the healthy gig behind a persistently failing resume never ran").toBe("completed");
    expect(invoked.filter(([, p]) => p === "scan").length, "precondition: exactly one chair ran, the healthy gig's own").toBeLessThanOrEqual(1);
  }, 60_000);
});

