// THE HOSTED SEAT IS A DOOR (WI-9 M1; conformance lib-caps RS-5 — the engine half).
//
// Measured 4 Oct 2026: the engine had reside.ts, reside_backing.ts and residency.ts and NO hosted
// provider — selectResidencyBacking answered "hosted" in the drain environment and resolveSeatBacking
// then refused no_backend because the deployment "injects" a provider no deployment ever wrote; nothing
// in the engine called residency.*. The store's doors live in schema `residency`, which PostgREST does
// not expose; coltrane-ui 20261004090000 opens five public wrappers. This is the provider over them,
// the sovereign's seat door on the hosted surface, and the CLI that wires the provider from the env.
//
//   RH1  postgrestSeatBacking.claim POSTs public coltrane_residency_claim with p_key, p_instance and
//        p_residency_id (null for "any") under the anon key, and maps the store's row to a ResidencyClaim:
//        org ← org_id, lease_token ← token, fence carried as a STRING, hands and may_dispatch as lists
//   RH2  heartbeat, release and cursorAdvance carry the fence to the store as a NUMBER; a fence that is
//        not a whole number is refused by name (bad_fence) before any call
//   RH3  a store refusal is thrown with the store's own words (not_holder, stale_fence…), never flattened
//        to a null claim; a claim that answers no row is null
//   RH4  hostedSeatBackingFromEnv builds the provider from the five drain variables (FLY_APP_NAME as
//        COLTRANE_INSTANCE's alias) and names every missing one
//   RH5  runReside in the drain environment injects that provider: the seat seam passes (no "seam: hosted"
//        refusal) and the boot's next wall is the deployment's listener; a missing drain variable is named
//   RH6  residency_seat on the hosted surface is a MEMBER act: an agent-token caller is refused
//        not_a_human_member before any backend; a member without the seam gets no_backend by name
//   RH7  with the seam, the four names are read as non-empty strings (bad_args otherwise), the lists pass
//        as lists, the store's residency id comes back; a store refusal rides back in its words
//   RH8  postgrestSeatResidency POSTs coltrane_residency_seat under the MEMBER's bearer with the eight
//        parameters the twin takes
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { postgrestSeatBacking, hostedSeatBackingFromEnv, claimFromRow, HOSTED_SEAT_DOORS } from "../src/reside_hosted.js";
import { postgrestSeatResidency } from "../src/genome_store.js";
import { runReside } from "../src/reside.js";

const ROW = {
  residency_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", org_id: "c0000000-0000-4000-8000-00000000e17a", agent_slug: "vor",
  channel_id: "C0C6DDCK1V1", venue_slug: "residency", repo: null, hands: ["envoy"], status: "seated", cursor: 3, session_id: null,
  soul_output_id: null, may_dispatch: ["software-change-pr-v1"], lease_until: "2026-10-04T09:00:00Z", fence: 7, token: "lease-secret",
};
const CTX = { baseUrl: "https://store.test", anonKey: "anon", key: "cdk_box", instance: "coltrane-residency-vor" };

function recordFetch(reply: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: (init?.headers ?? {}) as Record<string, string> });
    return reply(String(url), body);
  }));
  return calls;
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("the hosted seat is a door", () => {
  it("RH1 claim POSTs the public claim door with key, instance and residency, and maps the row", async () => {
    const calls = recordFetch(() => json(ROW));
    const seat = postgrestSeatBacking(CTX);
    const any = await seat.claim("any");
    expect(calls[0]!.url).toBe(`https://store.test/rest/v1/rpc/${HOSTED_SEAT_DOORS.claim}`);
    expect(calls[0]!.body).toEqual({ p_key: "cdk_box", p_instance: "coltrane-residency-vor", p_residency_id: null });
    expect(calls[0]!.headers["apikey"]).toBe("anon");
    expect(any).toMatchObject({ residency_id: ROW.residency_id, agent_slug: "vor", org: ROW.org_id, channel_id: "C0C6DDCK1V1", venue_slug: "residency", lease_token: "lease-secret", cursor: 3, hands: ["envoy"], may_dispatch: ["software-change-pr-v1"] });
    expect(any!.fence).toBe("7");
    await seat.claim(ROW.residency_id);
    expect(calls[1]!.body["p_residency_id"]).toBe(ROW.residency_id);
    expect(claimFromRow({ ...ROW, fence: 12 }).fence).toBe("12");
  });

  it("RH2 the fence crosses as a number; a non-integer fence is refused by name before any call", async () => {
    const calls = recordFetch((url) => json(url.endsWith("cursor_advance") ? 4 : "2026-10-04T09:00:00Z"));
    const seat = postgrestSeatBacking(CTX);
    await seat.heartbeat(ROW.residency_id, "7");
    expect(calls[0]!.url).toMatch(/coltrane_residency_heartbeat$/);
    expect(calls[0]!.body).toEqual({ p_key: "cdk_box", p_instance: "coltrane-residency-vor", p_residency_id: ROW.residency_id, p_fence: 7 });
    await seat.release(ROW.residency_id, "7", "hibernated");
    expect(calls[1]!.body).toMatchObject({ p_fence: 7, p_status: "hibernated" });
    expect(await seat.cursorAdvance(ROW.residency_id, "7", 4)).toBe(4);
    expect(calls[2]!.body).toMatchObject({ p_fence: 7, p_cursor: 4 });
    await expect(seat.heartbeat(ROW.residency_id, "seven")).rejects.toThrow(/^bad_fence/);
    await expect(seat.release(ROW.residency_id, "7.5", "unseated")).rejects.toThrow(/^bad_fence/);
    expect(calls).toHaveLength(3);
  });

  it("RH3 a store refusal is thrown in the store's words; an empty answer is a null claim", async () => {
    recordFetch(() => json({ message: "not_holder: this instance does not hold residency 7c9e… — claim it first" }, 400));
    const seat = postgrestSeatBacking(CTX);
    await expect(seat.heartbeat(ROW.residency_id, "7")).rejects.toThrow(/not_holder: this instance does not hold/);
    await expect(seat.claim("any")).rejects.toThrow(/not_holder/);
    recordFetch(() => json(null));
    expect(await postgrestSeatBacking(CTX).claim("any")).toBeNull();
  });

  it("RH4 the provider is built from the drain environment, naming what is missing", () => {
    const none = hostedSeatBackingFromEnv({ COLTRANE_STORE_URL: "https://s", COLTRANE_STORE_ANON: "a" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.missing).toEqual(["COLTRANE_DRAIN_KEY", "COLTRANE_INSTANCE"]);
    const alias = hostedSeatBackingFromEnv({ COLTRANE_STORE_URL: "https://s", COLTRANE_STORE_ANON: "a", COLTRANE_DRAIN_KEY: "cdk_x", FLY_APP_NAME: "coltrane-residency-vor" });
    expect(alias.ok).toBe(true);
    const full = hostedSeatBackingFromEnv({ COLTRANE_STORE_URL: "https://s", COLTRANE_STORE_ANON: "a", COLTRANE_DRAIN_KEY: "cdk_x", COLTRANE_INSTANCE: "i" });
    expect(full.ok).toBe(true);
    if (full.ok) for (const m of ["claim", "heartbeat", "release", "cursorAdvance"] as const) expect(typeof full.seat[m]).toBe("function");
  });

  it("RH5 runReside in the drain environment injects the provider: the seat seam passes and the boot refuses at a DEPLOYMENT seam, not no_backend on the seat", async () => {
    recordFetch(() => json(null));
    const err: string[] = [];
    const env = { COLTRANE_STORE_URL: "https://store.test", COLTRANE_STORE_ANON: "anon", COLTRANE_DRAIN_KEY: "cdk_box", COLTRANE_INSTANCE: "coltrane-residency-vor" };
    const code = await runReside(["reside", "--residency", ROW.residency_id], { env, err: (s: string) => err.push(s) });
    const said = err.join("\n");
    // before this module: "no_backend (seam: hosted) — the hosted backing is supplied by the DEPLOYMENT…"
    expect(said).not.toMatch(/seam: hosted|supplied by the DEPLOYMENT|seam: store-env/);
    // the loop's own next wall — the listener the deployment wires — is what refuses now
    expect(said).toMatch(/no_backend \(seam: channelListener\)/);
    expect(code).toBe(2);
    const missing: string[] = [];
    const code2 = await runReside(["reside"], { env: { COLTRANE_STORE_URL: "https://store.test", COLTRANE_STORE_ANON: "anon", COLTRANE_INSTANCE: "i" }, err: (s: string) => missing.push(s) });
    expect(code2).toBe(2);
    expect(missing.join("\n")).toMatch(/no_backend \(seam: store-env\).*COLTRANE_DRAIN_KEY/);
  });

  function surface(extra: Partial<ToolSurfaceDeps>): (args: Record<string, unknown>) => Promise<Record<string, unknown>> {
    const registry = createRegistry();
    const d: ToolSurfaceDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), hosted: true, ...extra };
    return (args) => createToolSurface(d).find((t) => t.name === "residency_seat")!.call(args) as unknown as Promise<Record<string, unknown>>;
  }
  const SEAT_ARGS = { org_slug: "eir-labs-inc", agent_slug: "vor", venue_slug: "residency", channel_id: "C0C6DDCK1V1", hands: ["envoy"], may_dispatch: ["software-change-pr-v1"] };

  it("RH6 residency_seat is a member act: an agent token is refused first; a member without the seam gets no_backend", async () => {
    const agent = await surface({ caller: { kind: "gig" }, seatResidency: async () => ({ residency_id: "x" }) })(SEAT_ARGS);
    expect(agent["ok"]).toBe(false);
    expect(agent["refusal"]).toBe("not_a_human_member");
    const unwired = await surface({ caller: { kind: "member" } })(SEAT_ARGS);
    expect(unwired["ok"]).toBe(false);
    expect(unwired["refusal"]).toBe("no_backend");
    expect(String(unwired["error"])).toMatch(/seatResidency/);
  });

  it("RH7 with the seam: the four names are required, the lists pass, the id comes back, a refusal rides back", async () => {
    const seen: unknown[] = [];
    const call = surface({ caller: { kind: "member" }, seatResidency: async (a) => { seen.push(a); return { residency_id: ROW.residency_id }; } });
    const ok = await call(SEAT_ARGS);
    expect(ok["ok"]).toBe(true);
    expect(ok["data"]).toEqual({ residency_id: ROW.residency_id, org_slug: "eir-labs-inc", agent_slug: "vor", channel_id: "C0C6DDCK1V1" });
    expect(seen[0]).toMatchObject({ org_slug: "eir-labs-inc", agent_slug: "vor", venue_slug: "residency", channel_id: "C0C6DDCK1V1", hands: ["envoy"], may_dispatch: ["software-change-pr-v1"], repo: null });
    const bad = await call({ ...SEAT_ARGS, channel_id: "  " });
    expect(bad["refusal"]).toBe("bad_args");
    expect(seen).toHaveLength(1);
    const refused = await surface({ caller: { kind: "member" }, seatResidency: async () => { throw new Error("coltrane_residency_seat 400: wildcard_dispatch: name the standards this presence may reach"); } })(SEAT_ARGS);
    expect(refused["ok"]).toBe(false);
    expect(String(refused["error"])).toMatch(/wildcard_dispatch/);
  });

  it("RH8 postgrestSeatResidency POSTs the public seat door under the member's bearer with the twin's eight parameters", async () => {
    const calls = recordFetch(() => json(ROW.residency_id));
    const r = await postgrestSeatResidency({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJmember" })({ org_slug: "eir-labs-inc", agent_slug: "vor", venue_slug: "residency", channel_id: "C0C6DDCK1V1", hands: ["envoy"], may_dispatch: ["software-change-pr-v1"] });
    expect(r).toEqual({ residency_id: ROW.residency_id });
    expect(calls[0]!.url).toBe("https://store.test/rest/v1/rpc/coltrane_residency_seat");
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer eyJmember");
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["p_agent_slug", "p_channel_id", "p_hands", "p_may_dispatch", "p_org_slug", "p_repo", "p_soul_output_id", "p_venue_slug"]);
    expect(calls[0]!.body).toMatchObject({ p_org_slug: "eir-labs-inc", p_agent_slug: "vor", p_venue_slug: "residency", p_channel_id: "C0C6DDCK1V1", p_hands: ["envoy"], p_may_dispatch: ["software-change-pr-v1"], p_repo: null, p_soul_output_id: null });
  });
});
