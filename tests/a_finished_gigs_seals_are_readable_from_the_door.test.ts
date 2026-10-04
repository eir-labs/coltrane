// A FINISHED GIG'S SEALS ARE READABLE FROM THE DOOR (conformance V-7; plan.one-write-path item 38,
// widened on B01 run 7, 4 Oct 2026).
//
// The hosted surface is per-request and holds no filesystem: `outputs` is a fresh in-memory store
// and `ledger` a fresh MemoryLedger on every call. output_query, gig_monitor and
// execution_history_read read THOSE — so on the hosted surface they answered a finished gig with
// {outputs: [], total_count: 0}, status "unknown" and {executions: [], count: 0}. Not a refusal: a
// vacuous empty, indistinguishable from "this gig sealed nothing". Measured live at 828dfbc on gig
// 7bf12626 (seven seals on the store; the engine's own PR on GitHub) by two sessions. The
// reconciler (R15) would not close the order on an empty she could not tell from a lie.
//
// The cure is the engine's own hosted idiom (queueGig, approveGig, cancelGig): the engine DEFINES
// a read seam, the host WIRES it, and without it the tool is an honest typed error — never empty.
//
//   H1  hosted output_query by gig id with NO reader refuses hosted_unsupported by name (red on main:
//       ok, outputs [], total_count 0)
//   H2  with a reader, the rows the store returned are served, each with its content_sha; the
//       engine's filters still apply (domain_type, agent_slug); include_data:false drops `data`
//   H3  hosted gig_monitor with NO reader refuses hosted_unsupported (red on main: status "unknown")
//   H4  with a reader, gig_monitor returns the STORE's status, never "unknown": completed → complete,
//       and queued/running/failed/aborted/awaiting_approval as the store says; a gig the store does
//       not hold is not_found, not unknown
//   H5  hosted execution_history_read by gig id with NO reader refuses; with one it serves the row; a gig
//       the store does not show is not_found, never an empty history (the grade's note)
//   H6  postgrestReadOutputs builds the member GET exactly — coltrane_outputs, gig_id=eq.<id>, the
//       select names content_sha — under the caller's bearer; a ctk_ bearer takes the agent RPC
//       (coltrane_mcp_gig_outputs) with the token in p_bearer and the ANON key as the Authorization
//       bearer — a ctk_ is not a JWT and PostgREST refuses it as one (measured live, 4 Oct)
//   H7  postgrestReadGig builds the member GET on coltrane_gigs by id; a ctk_ bearer takes
//       coltrane_mcp_gig_status
//   H8  a bare (non-hosted) surface is untouched: output_query still reads the local store
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRegistry, createOutputStore, MemoryLedger } from "../src/index.js";
import { createToolSurface, type ToolSurfaceDeps } from "../src/server.js";
import { postgrestReadOutputs, postgrestReadGig } from "../src/genome_store.js";

const GIG = "7bf12626-e86e-4451-b71d-e5793240a503";
const ROWS = [
  { id: "o-1", gig_id: GIG, agent_slug: "john", phase: "intake", domain_type: "change-context", content_sha: "a".repeat(64), input_shas: [], created_at: "2026-10-04T04:12:00Z", data: { k: 1 } },
  { id: "o-7", gig_id: GIG, agent_slug: "forseti", phase: "publish", domain_type: "pull-request", content_sha: "b".repeat(64), input_shas: ["a".repeat(64)], created_at: "2026-10-04T04:36:00Z", data: { branch: "changeset/x" } },
];

function hosted(extra: Partial<ToolSurfaceDeps> = {}): ToolSurfaceDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), hosted: true, ...extra };
}
const call = (d: ToolSurfaceDeps, name: string, args: Record<string, unknown>) =>
  createToolSurface(d).find((t) => t.name === name)!.call(args);

afterEach(() => vi.restoreAllMocks());

describe("a finished gig's seals are readable from the door", () => {
  it("H1 hosted output_query with no reader refuses by name — never an empty", async () => {
    const r = (await call(hosted(), "output_query", { gig_id: GIG })) as unknown as Record<string, unknown>;
    expect(r["ok"]).toBe(false);
    expect(r["hosted_unsupported"]).toBe(true);
    expect(String(r["error"])).toMatch(/readOutputs/);
    expect(r["data"]).toBeUndefined();
  });

  it("H2 with a reader, the store's rows are served with their seals; filters and include_data apply", async () => {
    const seen: unknown[] = [];
    const d = hosted({ readOutputs: async (sel) => { seen.push(sel); return ROWS.filter((r) => !sel.gig_id || r.gig_id === sel.gig_id); } });
    const all = (await call(d, "output_query", { gig_id: GIG })) as unknown as { ok: boolean; data: { outputs: Record<string, unknown>[]; total_count: number } };
    expect(all.ok).toBe(true);
    expect(all.data.total_count).toBe(2);
    expect(all.data.outputs.map((o) => o["content_sha"])).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(all.data.outputs[1]!["data"]).toEqual({ branch: "changeset/x" });
    expect(seen[0]).toMatchObject({ gig_id: GIG });
    const one = (await call(d, "output_query", { gig_id: GIG, domain_type: "pull-request" })) as unknown as { data: { outputs: Record<string, unknown>[] } };
    expect(one.data.outputs.map((o) => o["id"])).toEqual(["o-7"]);
    const who = (await call(d, "output_query", { gig_id: GIG, agent_slug: "john" })) as unknown as { data: { outputs: Record<string, unknown>[] } };
    expect(who.data.outputs.map((o) => o["id"])).toEqual(["o-1"]);
    const compact = (await call(d, "output_query", { gig_id: GIG, include_data: false })) as unknown as { data: { outputs: Record<string, unknown>[] } };
    expect(compact.data.outputs.every((o) => o["data"] === undefined)).toBe(true);
    expect(compact.data.outputs.every((o) => typeof o["content_sha"] === "string")).toBe(true);
  });

  it("H3 hosted gig_monitor with no reader refuses by name — never unknown", async () => {
    const r = (await call(hosted(), "gig_monitor", { gig_id: GIG })) as unknown as Record<string, unknown>;
    expect(r["ok"]).toBe(false);
    expect(r["hosted_unsupported"]).toBe(true);
    expect(String(r["error"])).toMatch(/readGig/);
  });

  it("H4 with a reader, gig_monitor returns the store's status — terminal, never unknown — and the seals so far", async () => {
    const rows: Record<string, Record<string, unknown>> = {
      [GIG]: { id: GIG, status: "completed", standard_slug: "software-change-pr-v1", total_cost_usd: 1.25, completed_at: "2026-10-04T04:36:28Z" },
      "g-run": { id: "g-run", status: "running", standard_slug: "s" },
      "g-fail": { id: "g-fail", status: "failed", standard_slug: "s" },
      "g-park": { id: "g-park", status: "awaiting_approval", standard_slug: "s" },
    };
    const d = hosted({
      readGig: async (id) => rows[id] ?? null,
      readOutputs: async (sel) => ROWS.filter((r) => r.gig_id === sel.gig_id),
    });
    const done = (await call(d, "gig_monitor", { gig_id: GIG })) as unknown as { ok: boolean; data: Record<string, unknown> };
    expect(done.ok).toBe(true);
    expect(done.data["status"]).toBe("complete");
    expect(done.data["phases_complete"]).toBe(2);
    expect((done.data["outputs_so_far"] as unknown[]).length).toBe(2);
    expect(done.data["standard_slug"]).toBe("software-change-pr-v1");
    expect(done.data["finished_at"]).toBe("2026-10-04T04:36:28Z");
    for (const [id, want] of [["g-run", "running"], ["g-fail", "failed"], ["g-park", "awaiting_approval"]] as const) {
      const r = (await call(d, "gig_monitor", { gig_id: id })) as unknown as { data: Record<string, unknown> };
      expect(r.data["status"]).toBe(want);
      expect(r.data["status"]).not.toBe("unknown");
    }
    const missing = (await call(d, "gig_monitor", { gig_id: "g-none" })) as unknown as Record<string, unknown>;
    expect(missing["ok"]).toBe(false);
    expect(missing["not_found"]).toBe(true);
    expect(JSON.stringify(missing)).not.toMatch(/unknown/);
  });

  it("H5 hosted execution_history_read by gig id: refuses without a reader; serves the row with one", async () => {
    const none = (await call(hosted(), "execution_history_read", { gig_id: GIG })) as unknown as Record<string, unknown>;
    expect(none["ok"]).toBe(false);
    expect(none["hosted_unsupported"]).toBe(true);
    const d = hosted({ readGig: async (id) => (id === GIG ? { id: GIG, status: "completed", standard_slug: "software-change-pr-v1", genome_hash: "h", run_fingerprint: "f" } : null) });
    const r = (await call(d, "execution_history_read", { gig_id: GIG })) as unknown as { ok: boolean; data: { executions: Record<string, unknown>[]; count: number } };
    expect(r.ok).toBe(true);
    expect(r.data.count).toBe(1);
    expect(r.data.executions[0]).toMatchObject({ gig_id: GIG, status: "completed", standard_slug: "software-change-pr-v1", genome_hash: "h", run_fingerprint: "f" });
    const other = (await call(d, "execution_history_read", { gig_id: "nope" })) as unknown as Record<string, unknown>;
    expect(other["ok"]).toBe(false);
    expect(other["not_found"]).toBe(true);
  });

  it("H6 postgrestReadOutputs: the member GET names the table, the gig and the seal; an agent bearer takes the RPC", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(ROWS), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const member = postgrestReadOutputs({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJmember" });
    const rows = await member({ gig_id: GIG });
    expect(rows).toHaveLength(2);
    expect(calls[0]!.url).toMatch(/^https:\/\/store\.test\/rest\/v1\/coltrane_outputs\?/);
    expect(calls[0]!.url).toContain(`gig_id=eq.${GIG}`);
    expect(calls[0]!.url).toMatch(/select=[^&]*content_sha/);
    expect(calls[0]!.url).toMatch(/order=created_at/);
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer eyJmember");
    expect((calls[0]!.init.headers as Record<string, string>)["apikey"]).toBe("anon");
    expect(calls[0]!.init.method ?? "GET").toBe("GET");
    const agent = postgrestReadOutputs({ baseUrl: "https://store.test", anonKey: "anon", bearer: "ctk_abc" });
    await agent({ gig_id: GIG });
    expect(calls[1]!.url).toBe("https://store.test/rest/v1/rpc/coltrane_mcp_gig_outputs");
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ p_bearer: "ctk_abc", p_gig: GIG });
    // THE AGENT TOKEN RIDES IN THE BODY, NEVER AS THE BEARER: PostgREST wants a JWT in Authorization and a
    // ctk_ is not one ("Expected 3 parts in JWT; got 1", measured live as vor at coltrane-ui cfbd57b). The
    // header carries the anon key; p_bearer carries the token — the shape rpcQueueGig and hosted_tools keep.
    expect((calls[1]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer anon");
    expect(JSON.stringify(calls[1]!.init.headers)).not.toContain("ctk_abc");
    // a store refusal is thrown with the store's words, never swallowed into an empty
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "permission denied for table coltrane_outputs" }), { status: 401 })));
    await expect(postgrestReadOutputs({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJx" })({ gig_id: GIG })).rejects.toThrow(/permission denied/);
  });

  it("H7 postgrestReadGig: the member GET on coltrane_gigs by id; an agent bearer takes coltrane_mcp_gig_status; a missing row is null", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).includes("rpc/") ? [{ id: GIG, status: "completed" }] : String(url).includes("id=eq.nope") ? [] : [{ id: GIG, status: "completed", standard_slug: "s" }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const member = postgrestReadGig({ baseUrl: "https://store.test", anonKey: "anon", bearer: "eyJmember" });
    const row = await member(GIG);
    expect(row).toMatchObject({ id: GIG, status: "completed" });
    expect(calls[0]!.url).toMatch(/^https:\/\/store\.test\/rest\/v1\/coltrane_gigs\?/);
    expect(calls[0]!.url).toContain(`id=eq.${GIG}`);
    expect(calls[0]!.url).toMatch(/select=[^&]*status/);
    expect(await member("nope")).toBeNull();
    const agent = postgrestReadGig({ baseUrl: "https://store.test", anonKey: "anon", bearer: "ctk_abc" });
    expect(await agent(GIG)).toMatchObject({ status: "completed" });
    expect(calls[2]!.url).toBe("https://store.test/rest/v1/rpc/coltrane_mcp_gig_status");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ p_bearer: "ctk_abc", p_gig: GIG });
    expect((calls[2]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer anon");
  });

  it("H8 a bare surface is untouched: output_query reads the local store as before", async () => {
    const registry = createRegistry();
    const d: ToolSurfaceDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
    const r = (await call(d, "output_query", { gig_id: GIG })) as unknown as { ok: boolean; data: { outputs: unknown[]; total_count: number } };
    expect(r.ok).toBe(true);
    expect(r.data.total_count).toBe(0);
  });
});
