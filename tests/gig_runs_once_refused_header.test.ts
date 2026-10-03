// E10 — A HEADER THE STORE REFUSES STOPS THE WORKER. (docs/specs/gig-runs-once.red-spec.json)
//
// The store side (eir-labs/coltrane-ui #250) adds a terminal-status guard: a finished row accepts only
// an identical status, and anything else is refused with 23514 (check_violation). It also answers
// 403 / 42501 to a writer that no longer holds the lease. Both answers mean the same thing to a worker:
// THIS GIG IS NOT YOURS TO RUN. The row is already finished, or someone else holds it. A worker that
// logs the refusal and keeps going is the double run this battery exists to close, with the store's
// own refusal sitting in the log as evidence.
//
// So when the store refuses the 'running' header (E1), the worker handles it the way it handles a
// lost lease (E4). It invokes no chair and seals nothing. It writes nothing terminal: no terminal
// header, no coltrane_mcp_gig_fail, no terminal release. A finished gig must not be failed after the
// fact, and a gig someone else holds is theirs to finish.
//
// Mid-run headers: the engine writes none today apart from awaiting_approval, which is a park and not
// a progress write. If the implementation adds any, the same rule applies to them. These laws drive
// the header that exists: the start header.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker } from "../src/runtime.js";
import {
  hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, sealedLocally, settle, GIG_ID, TERMINAL,
} from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => env?.cleanup());

const REFUSALS: Array<{ name: string; answer: () => Response; why: RegExp }> = [
  {
    name: "23514 — the terminal guard: the row is already finished",
    answer: () => new Response(JSON.stringify({ code: "23514", message: "gig is terminal; only an identical status is accepted" }), { status: 409 }),
    why: /23514|terminal|finished|already/i,
  },
  {
    name: "403 / 42501 — the lease is not this worker's",
    answer: () => new Response(JSON.stringify({ code: "42501", message: "lease not held by this instance" }), { status: 403 }),
    why: /42501|lease/i,
  },
];

describe("E10 — a refused start header stops the worker before it spends", () => {
  for (const r of REFUSALS) {
    it(`E10 the store refuses the 'running' header with ${r.name}: no chair, no seal, no terminal write`, async () => {
      env = hostedEnv();
      const store = hostedStore({
        claim: claimFor("two-chair-v0"),
        header: (b) => (b["status"] === "running" ? r.answer() : undefined),
      });
      const invoke = vi.fn(async () => sealableSignal);
      const res = await workOnce(venueCtx(), { makeInvoke: () => invoke as unknown as AgentInvoker } as WorkOnceDeps);
      await settle();

      expect(store.headers().some((c) => c.body["status"] === "running"),
        "no 'running' header was sent, so the store never had the chance to refuse (E1 first)").toBe(true);
      expect(invoke, "the store said this gig is not this worker's to run, and a chair ran anyway").not.toHaveBeenCalled();
      expect(sealedLocally(env.stateRoot, GIG_ID), "outputs were sealed for a gig the store refused").toEqual([]);
      expect(store.outputRows().map((c) => c.body["id"]), "outputs were drained for a gig the store refused").toEqual([]);
      expect(store.headers().filter((c) => TERMINAL.has(String(c.body["status"]))).map((c) => c.body["status"]),
        "a refused worker wrote the gig's terminal header").toEqual([]);
      expect(store.calls.some((c) => c.host === "store" && c.path.endsWith("/coltrane_mcp_gig_fail")),
        "a refused worker FAILED a gig that is finished or held by someone else").toBe(false);
      expect(store.releases().filter((c) => c.body["p_terminal"] === true),
        "a refused worker terminally released the row").toEqual([]);
      expect(res.claimed && res.status, "a refused run is not a completion").not.toBe("complete");
      expect(JSON.stringify(res), "the result must say WHY it stopped").toMatch(r.why);
    });
  }
});
