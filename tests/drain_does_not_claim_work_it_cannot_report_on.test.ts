// DR-6 — drain:does-not-claim-work-it-cannot-report-on (wiki spec.coltrane.the-drain-runs-a-graded-red-pass rev 3).
//
// The worker verified the resource it borrowed (the lease: leaseLost() before and after the run) and never its own
// authority to report: the credential every write depends on (Vör, after the DR-4 run). On the PLAYER path the claim
// leases thirty minutes under the player's STANDING token and runs to a 25-minute deadline, and nothing asks whether
// that token outlives it: a token with ten minutes left claims, spends, and then cannot write its terminal header.
// (A venue claim's credential moves with the lease — coltrane_drain_renew — so it does not lapse while the lease holds.)
//
// The claim now carries `credential_expires_at` (the store half, coltrane_mcp_claim). The worker refuses to BEGIN a
// gig whose credential expires before its deadline: no chair seated, nothing spent, both instants named. Absent or
// unparseable means decline. And a terminal write the store did not acknowledge while the credential had lapsed is
// told apart from a store that merely did not acknowledge.
import { describe, it, expect, afterEach, vi } from "vitest";
import { workOnce, type WorkOnceDeps, type WorkerContext } from "../src/worker.js";
import { drainTimeoutMs } from "../src/run_deps.js";
import type { AgentInvoker } from "../src/runtime.js";
import { hostedStore, hostedEnv, venueCtx, claimFor, sealableSignal, settle, GIG_ID } from "./gig_runs_once_fixtures.js";

let env: ReturnType<typeof hostedEnv>;
afterEach(() => { delete process.env["COLTRANE_GIG_TIMEOUT_MS"]; env?.cleanup(); });

const playerCtx = (): WorkerContext => {
  const { instance: _venueInstance, ...rest } = venueCtx();
  void _venueInstance;
  return { ...rest, drainKey: "", agentToken: "player-token" };
};
const T0 = Date.parse("2026-10-28T08:00:00Z");
const DEADLINE = drainTimeoutMs("player")!;
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

async function drive(claimExtra: Record<string, unknown>, opts: { header?: Parameters<typeof hostedStore>[0]["header"]; chairAdvancesTo?: number } = {}) {
  env = hostedEnv();
  let t = T0;
  const store = hostedStore({ claim: claimFor("one-chair-v0", claimExtra), header: opts.header });
  const chair = vi.fn(async () => { if (opts.chairAdvancesTo !== undefined) t = opts.chairAdvancesTo; return sealableSignal; });
  const lines: string[] = [];
  const res = await workOnce(playerCtx(), {
    makeInvoke: () => chair as unknown as AgentInvoker, now: () => t, log: (l: string) => lines.push(l),
  } as WorkOnceDeps);
  await settle();
  return { res: res as Record<string, unknown>, store, chair, log: lines.join("\n") };
}
const notBegun = (d: Awaited<ReturnType<typeof drive>>, why: string) => {
  expect(d.chair, `${why}: a chair was seated`).not.toHaveBeenCalled();
  expect(d.res["status"], `${why}: the gig was begun (status ${String(d.res["status"])}): ${String(d.res["error"])}`).toBe("declined");
  expect(d.store.headers().filter((c) => c.body["id"] === GIG_ID).length, `${why}: a header was written for a gig this worker cannot report on`).toBe(0);
};

describe("DR-6 — the drain does not begin a gig whose credential expires before its deadline", () => {
  it("plant — a credential with ten minutes left (deadline 25): not begun, no chair seated, both instants named", async () => {
    const exp = iso(T0 + 10 * MIN);
    const d = await drive({ credential_expires_at: exp });
    notBegun(d, "a ten-minute credential");
    expect(String(d.res["error"])).toContain(exp);
    expect(String(d.res["error"])).toContain(iso(T0 + DEADLINE));
  });

  it("plant — a claim carrying no credential_expires_at: not begun (absent declines, never assumes enough)", async () => {
    notBegun(await drive({}), "no credential_expires_at");
  });

  it("plant — an unparseable credential_expires_at: not begun", async () => {
    notBegun(await drive({ credential_expires_at: "soon" }), "an unparseable expiry");
  });

  it("plant — a credential expiring ONE millisecond before the deadline: not begun (the boundary is the deadline itself)", async () => {
    notBegun(await drive({ credential_expires_at: iso(T0 + DEADLINE - 1) }), "a credential one ms short");
  });

  it("plant — a mid-run lapse: the completed header refused after the credential lapsed is logged as the lapse, not as the store's", async () => {
    const exp = T0 + DEADLINE + MIN;
    const d = await drive({ credential_expires_at: iso(exp) }, {
      chairAdvancesTo: exp + MIN,
      header: (b) => (b["status"] === "completed" ? new Response(JSON.stringify({ error: "invalid, revoked, or expired agent token" }), { status: 401 }) : undefined),
    });
    expect(d.chair, "precondition: the gig was begun").toHaveBeenCalledTimes(1);
    expect(d.res["acknowledged"], "precondition: the terminal write was not acknowledged").toBe(false);
    expect(d.log).toContain(`this worker's credential lapsed at ${iso(exp)}, before the terminal write`);
    expect(d.log, "a lapse reported as the store's failure to acknowledge").not.toMatch(/the store did NOT acknowledge/);
  });

  it("control — a store that refuses the terminal write while the credential is live is still reported as the store's", async () => {
    const d = await drive({ credential_expires_at: iso(T0 + 2 * DEADLINE) }, {
      header: (b) => (b["status"] === "completed" ? new Response(JSON.stringify({ error: "service unavailable" }), { status: 503 }) : undefined),
    });
    expect(d.res["acknowledged"]).toBe(false);
    expect(d.log).toMatch(/the store did NOT acknowledge/);
    expect(d.log).not.toMatch(/credential lapsed/);
  });

  it("twin, must be ALLOWED — a credential that outlives the deadline runs exactly as before: one chair, completed, acknowledged", async () => {
    const d = await drive({ credential_expires_at: iso(T0 + DEADLINE) });
    expect(d.chair).toHaveBeenCalledTimes(1);
    expect(d.res["status"], String(d.res["error"])).toBe("complete");
    expect(d.res["acknowledged"]).toBe(true);
  });
});
