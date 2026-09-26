// Q6 — A GIG THAT HITS THE DRAIN DEADLINE ENDS `aborted`, REASON `timeout`. (docs/specs/gig-runs-once.red-spec.json)
//
// workOnce arms `setTimeout(() => aborter.abort(), drainTimeoutMs())` (src/worker.ts). When it fires,
// the run dies inside a chair and falls into the ordinary catch. It is recorded through
// coltrane_mcp_gig_fail, and its header says `failed`, the same thing a chair that threw says. But a
// deadline is not a defect in the work. It says how long the work was allowed to take. And once the
// store's terminal guard holds a row at `failed`, it can never be corrected to what actually
// happened.
//
// Ruling (Eugene, Q6): when the drain deadline fires, the gig ends `aborted` with reason `timeout`.
// WorkOnceResult says so (status "aborted", `aborted: { reason: "timeout" }`), the terminal header
// carries status `aborted`, and that header is acknowledged under E2's policy (awaited and retried).
// It is not also sent through gig_fail: a second, contradictory terminal write is exactly what the
// terminal guard refuses.
//
// The deadline is shortened with COLTRANE_GIG_TIMEOUT_MS, the override drainTimeoutMs() already
// honours. The chair honours the run's signal the way a real invoker does.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps } from "../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle, GIG_ID } from "./gig_runs_once_fixtures.js";

const unavailable = () => new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });

let env: ReturnType<typeof hostedEnv>;
afterEach(() => {
  delete process.env["COLTRANE_GIG_TIMEOUT_MS"];
  env?.cleanup();
});

/** A chair that works until the run's signal says stop, then stops the way a real invoker does. */
const slowChair = vi.fn((ctx: AgentInvocationContext) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const giveUp = setTimeout(() => resolve(sealableSignal), 5_000); // the deadline must beat this
  const onAbort = () => { clearTimeout(giveUp); reject(new Error(`chair stopped: ${String(ctx.signal?.reason ?? "aborted")}`)); };
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
}));

describe("Q6 — the drain deadline ends a gig as aborted/timeout, acknowledged", () => {
  it("Q6 the run timeout fires: WorkOnceResult is aborted/timeout, the terminal header says `aborted` (retried to acknowledgement), and nothing reports it failed", async () => {
    env = hostedEnv();
    process.env["COLTRANE_GIG_TIMEOUT_MS"] = "80";
    const store = hostedStore({
      claim: claimFor("one-chair-v0"),
      header: (b, n) => (b["status"] === "aborted" && n === 1 ? unavailable() : undefined),
    });
    const res = await workOnce(venueCtx(), { makeInvoke: () => slowChair as unknown as AgentInvoker } as WorkOnceDeps);
    await settle();

    expect(slowChair, "precondition: the chair was running when the deadline fired").toHaveBeenCalledTimes(1);
    expect(res.claimed && res.status, "a deadline is not a failure of the work: the gig ends ABORTED").toBe("aborted");
    expect((res as Record<string, unknown>)["aborted"], "WorkOnceResult must say why it aborted").toEqual(expect.objectContaining({ reason: "timeout" }));

    const terminal = store.headers().filter((c) => c.body["id"] === GIG_ID && ["failed", "aborted", "completed"].includes(String(c.body["status"])));
    expect(terminal.map((c) => c.body["status"]), "the store must be told `aborted`, and only that").toEqual(["aborted", "aborted"]);
    expect(JSON.stringify(terminal.at(-1)!.body), "the aborted header must carry the reason").toMatch(/timeout/i);
    expect(store.gigs.get(GIG_ID)?.["status"], "the aborted header was not retried to acknowledgement (E2)").toBe("aborted");
    expect((res as Record<string, unknown>)["acknowledged"]).toBe(true);
    expect(store.calls.some((c) => c.path.endsWith("/coltrane_mcp_gig_fail")),
      "a timed-out gig was ALSO reported failed, a contradictory terminal write").toBe(false);
  }, 20_000);

  it("Q6r the aborted header carries the reason `timeout` ITSELF, as manifest.abort_reason, even when the chair's own error never mentions it", async () => {
    // Q6's chair folds the abort reason into its error text, so /timeout/ matched without the engine
    // saying anything. This chair stops with words of its own ("chair stopped"). The reason has to
    // come from the engine's knowledge of WHY it aborted, and it has to arrive as a field.
    env = hostedEnv();
    process.env["COLTRANE_GIG_TIMEOUT_MS"] = "80";
    const store = hostedStore({ claim: claimFor("one-chair-v0") });
    const mute = vi.fn((ctx: AgentInvocationContext) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const giveUp = setTimeout(() => resolve(sealableSignal), 5_000);
      const onAbort = () => { clearTimeout(giveUp); reject(new Error("chair stopped")); };
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener("abort", onAbort, { once: true });
    }));
    const res = await workOnce(venueCtx(), { makeInvoke: () => mute as unknown as AgentInvoker } as WorkOnceDeps);
    await settle();
    expect(res.claimed && res.status, "precondition: the deadline ended the gig aborted").toBe("aborted");
    const aborted = store.headers().filter((c) => c.body["id"] === GIG_ID && c.body["status"] === "aborted");
    expect(aborted.length, "precondition: an aborted header was sent").toBeGreaterThan(0);
    // A TOKEN, not prose. The run's error text reaches the header by more than one path (the chair's
    // words, GigAborted's message, the `aborted: <reason>` prefix), so a /timeout/ match on free text
    // cannot fail when any single path is cut. Measured: dropping the prefix left the header saying
    // "GigAborted: … was aborted — timeout: …" through the exception's own message. The reason a
    // consumer can read is a field: manifest.abort_reason === "timeout".
    const manifest = (aborted.at(-1)!.body["manifest"] ?? {}) as Record<string, unknown>;
    expect(manifest["abort_reason"], "the aborted header does not carry the reason as a field (manifest.abort_reason)").toBe("timeout");
  }, 20_000);
});
