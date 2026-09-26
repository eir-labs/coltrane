// B1 + B2 — THE LAST HOP. (docs/specs/gig-runs-once.red-spec.json; review 5326586074)
//
// B1 · THE BUDGET IS ENFORCED ON THE DRAIN. Round 6c made the hosted door carry `budget_micro_usd`,
// and coltrane-ui #253 writes it to the row and hands it back on the claim (a JSON integer of
// micro-dollars, #555). But workOnce builds its ceiling from drainBudget(claim.input), which reads
// only input.budget.max_usd or COLTRANE_DRAIN_MAX_USD. It never reads claim.budget_micro_usd, and the
// door strips `budget` from what it forwards. So a hosted gig with a ceiling runs UNBOUNDED: the
// silent drop H4 forbids, moved to the last hop.
//
//   SEMANTICS PINNED. These are the engine's existing batch-boundary rule (src/runtime.ts, "BUDGET
//   BATCH-BOUNDARY GATE"), applied to the claim's ceiling:
//     * the ceiling is claim.budget_micro_usd, integer micro-dollars (1 USD = 1_000_000);
//     * before each chair (batch) is invoked, SETTLED spend is compared with the ceiling. A chair
//       starts only while settled < ceiling. The in-flight chair is never interrupted, and its
//       settled cost counts toward the next check;
//     * so settled spend never exceeds the ceiling by more than ONE chair's actual cost, and the run
//       ends with a NAMED budget stop (BudgetExhausted), never a silent overrun and never "complete";
//     * no budget_micro_usd on the claim means no ceiling, exactly as today.
//   Fixture: three sequential chairs at $5.00 settled each (5_000_000 micro-dollars), ceiling $8.00.
//   Chair 1 runs at settled 0; chair 2 at settled 5; chair 3 would start at settled 10 ≥ 8, so it
//   does not. Settled 10 ≤ 8 + 5.
//
// B2 · A RESUME REFUSES WHEN THE CLOSED GIG CANNOT BE READ. Without coltrane-ui #253's status
// exception, the store answers the resumed gig's status read with 42501. The worker then runs a
// `resumes` claim COLD: it re-runs chairs the closed gig already paid for (the double spend), and it
// contradicts H3 on the hosted door. The law: when the worker cannot read the resumed gig's status or
// outputs (42501, an error, or no answer), it REFUSES the claim by name. It releases the row
// non-terminally, so the attempt is refunded, and it invokes nothing. It never runs a `resumes`
// claim cold.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, settle, GIG_ID, TERMINAL, type ResumedReadMode,
} from "./gig_runs_once_fixtures.js";

const O = GIG_ID;
const N = "15151515-2626-3737-4848-595959595959";
const CHAIR_USD = 5;

let env: ReturnType<typeof hostedEnv>;
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  delete process.env["COLTRANE_DRAIN_MAX_USD"];
  env?.cleanup();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const answer = (phase: string) => ({ id: `sig-${phase}`, source: "test", data: { seen: phase }, completeness: 1, acquisition_cost: 0 });

/** A chair that settles CHAIR_USD, reported the way a real invoker does (a `result` stream event). */
function payingChairs(): { invoke: AgentInvoker; phases: string[] } {
  const phases: string[] = [];
  const invoke = (async (ctx: AgentInvocationContext) => {
    phases.push(ctx.phase);
    ctx.onEvent?.({ type: "result", raw: { usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: CHAIR_USD } });
    return answer(ctx.phase);
  }) as unknown as AgentInvoker;
  return { invoke, phases };
}

async function onFreshBox(deps: WorkOnceDeps): Promise<Awaited<ReturnType<typeof workOnce>>> {
  const root = mkdtempSync(join(tmpdir(), "coltrane-r6e-box-"));
  roots.push(root);
  const saved = process.env["COLTRANE_WORKER_CHECKPOINTS"];
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = root;
  try {
    return await workOnce(venueCtx(), deps);
  } finally {
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = saved;
  }
}

describe("B1 — the claim's budget_micro_usd is the run's ceiling on the drain", () => {
  it("B1 a claim carrying budget_micro_usd 8000000 over three $5 chairs: two chairs run, the third never starts, and the run ends with a NAMED budget stop", async () => {
    env = hostedEnv();
    delete process.env["COLTRANE_DRAIN_MAX_USD"];
    const store = hostedStore({ claim: claimFor("three-chair-v0", { budget_micro_usd: 8_000_000 }) });
    const { invoke, phases } = payingChairs();
    const res = await onFreshBox({ makeInvoke: () => invoke } as WorkOnceDeps);
    await settle();

    expect(phases, "the claim's ceiling was ignored: a chair started after settled spend had reached it").toEqual(["scan", "rescan"]);
    const settledMicro = phases.length * CHAIR_USD * 1_000_000;
    expect(settledMicro, "settled spend exceeded the ceiling by more than one chair's actual cost").toBeLessThanOrEqual(8_000_000 + CHAIR_USD * 1_000_000);
    expect(res.claimed && res.status, "a run stopped by its budget reported itself complete").not.toBe("complete");
    const said = JSON.stringify(res) + JSON.stringify(store.headers().filter((c) => TERMINAL.has(String(c.body["status"]))).map((c) => c.body));
    expect(said, "the budget stop must be NAMED, in the result or the terminal header").toMatch(/budget/i);
  });

  it("B1 no budget_micro_usd on the claim (and no COLTRANE_DRAIN_MAX_USD) → no ceiling: all three chairs run, exactly as today", async () => {
    env = hostedEnv();
    delete process.env["COLTRANE_DRAIN_MAX_USD"];
    hostedStore({ claim: claimFor("three-chair-v0") });
    const { invoke, phases } = payingChairs();
    const res = await onFreshBox({ makeInvoke: () => invoke } as WorkOnceDeps);
    expect(phases, "an absent budget conjured a ceiling").toEqual(["scan", "rescan", "final"]);
    expect(res.claimed && res.status).toBe("complete");
  });
});

describe("B2 — a `resumes` claim whose closed gig cannot be read is REFUSED, never run cold", () => {
  const CASES: Array<[string, { status?: ResumedReadMode; outputs?: ResumedReadMode }]> = [
    ["status refused 42501 (#250 as merged)", { status: "refuse" }],
    ["status errors (500)", { status: "error" }],
    ["outputs refused 42501", { outputs: "refuse" }],
    ["status never answers", { status: "hang" }],
  ];
  for (const [label, resumedRead] of CASES) {
    it(`B2 the resumed gig's ${label}: nothing invoked, the claim refused by name, released NON-terminally`, async () => {
      env = hostedEnv();
      const store = hostedStore({ claim: claimFor("three-chair-v0") });
      // Box A closes O: scan seals, rescan fails.
      const a = await onFreshBox({
        makeInvoke: () => (async (ctx: AgentInvocationContext) => {
          if (ctx.phase === "rescan") throw new Error("rescan broke");
          return answer(ctx.phase);
        }) as unknown as AgentInvoker,
      } as WorkOnceDeps);
      expect(a.claimed && a.status, "precondition: O ends failed").toBe("failed");
      await settle();

      store.set({ claim: claimFor("three-chair-v0", { gig_id: N, resumes: O }), resumedRead });
      const callsBefore = store.calls.length;
      const phases: string[] = [];
      const deps = { makeInvoke: () => (async (ctx: AgentInvocationContext) => { phases.push(ctx.phase); return answer(ctx.phase); }) as unknown as AgentInvoker } as WorkOnceDeps;

      let outcome: string;
      if (resumedRead.status === "hang" || resumedRead.outputs === "hang") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let settledRes: string | undefined;
        const p = onFreshBox(deps).then((r) => { settledRes = JSON.stringify(r); }, (e: unknown) => { settledRes = String(e); });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(settledRes, "the worker is still waiting on a store that never answers about the resumed gig").toBeDefined();
        await p;
        outcome = settledRes!;
        vi.useRealTimers();
      } else {
        outcome = await onFreshBox(deps).then((r) => JSON.stringify(r), (e: unknown) => (e instanceof Error ? e.message : String(e)));
      }
      await settle();

      expect(phases, "a `resumes` claim whose closed gig could not be read ran COLD, re-paying for chairs the closed gig sealed").toEqual([]);
      expect(outcome, "the refusal must name the gig it could not resume").toContain(O);
      const second = store.calls.slice(callsBefore);
      const releases = second.filter((c) => c.host === "drain" && c.path.endsWith("/coltrane_drain_release"));
      expect(releases.map((c) => [c.body["p_gig_id"], c.body["p_terminal"]]),
        "the claim must be handed back NON-terminally (the attempt refunds), not held and not ended").toEqual([[N, false]]);
      expect(String(releases[0]?.body["p_reason"] ?? ""), "the release must say why").toMatch(/resum/i);
      expect(second.filter((c) => c.host === "drain" && c.path === "/rest/v1/coltrane_gigs" && TERMINAL.has(String(c.body["status"]))).length,
        "a refused claim wrote a terminal header").toBe(0);
    }, 30_000);
  }
});
