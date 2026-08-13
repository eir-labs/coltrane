// gig_cancel — stop a QUEUED gig before any drain worker claims it. The surface already had
// gig_abort, which targets a RUNNING gig and reports not_found for a queued row — so a gig
// dispatched into the org gig table but never claimed had no cancel path. gig_cancel closes
// that: it cancels the queued row and FAILS CLOSED on a running/claimed gig, naming gig_abort.
//
// RED-first: written against an engine with no gig_cancel tool, no cancel seam, no store seams.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createToolSurface, dispatchTool, type ToolSurfaceDeps } from "../src/server.js";
import { MCP_TOOLS } from "../src/mcp.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { newGigRun, type GigRunState } from "../src/gig_tracker.js";
import { postgrestCancelGig, rpcCancelGig } from "../src/genome_store.js";

function bareDeps(extra?: Partial<ToolSurfaceDeps>): ToolSurfaceDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map(), ...extra };
}

// ── the tool is advertised on the run surface ───────────────────────────────
describe("gig_cancel — advertised on the run surface", () => {
  it("is a run-category tool taking gig_id", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "gig_cancel");
    expect(tool, "gig_cancel must be in MCP_TOOLS").toBeDefined();
    expect(tool!.category).toBe("run");
    const props = (tool!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props), "gig_cancel takes a gig_id").toContain("gig_id");
  });
});

// ── local surface (no queue) fails closed ───────────────────────────────────
describe("gig_cancel — local surface has no queue, so it fails closed", () => {
  it("a RUNNING local gig is refused and pointed at gig_abort", async () => {
    const gig_runs = new Map<string, GigRunState>();
    const run = newGigRun("g-run", "std", 2, new Date().toISOString());
    run.status = "running";
    gig_runs.set("g-run", run);
    const res = await dispatchTool("gig_cancel", { gig_id: "g-run" }, bareDeps({ gig_runs }));
    expect(
      res.ok,
      "cancel is for a QUEUED gig; a running gig must not be cancelled through this door",
    ).toBe(false);
    expect(res.error, "the refusal must name the tool that DOES stop a running gig").toMatch(/gig_abort/);
  });

  it("with no store/queue wired, cancel is a typed hosted-only explanation", async () => {
    const res = await dispatchTool("gig_cancel", { gig_id: "g-queued" }, bareDeps());
    expect(res.ok).toBe(false);
    expect(
      res.error,
      "a queued gig lives in the org gig table — the local surface has no queue to cancel from",
    ).toMatch(/queue|coltrane_gig_cancel|hosted/i);
  });
});

// ── hosted routing through the cancel seam ──────────────────────────────────
describe("gig_cancel — hosted routing through the cancel seam", () => {
  it("without a cancel seam is a typed hosted error naming the cancel RPC", async () => {
    const surface = createToolSurface(bareDeps({ hosted: true }));
    const res = await surface.find((t) => t.name === "gig_cancel")!.call({ gig_id: "g1" });
    expect(res.ok).toBe(false);
    expect(res.hosted_unsupported).toBe(true);
    expect(res.error).toMatch(/cancel|coltrane_gig_cancel/i);
  });

  it("with a cancelGig seam routes through it — the queued gig is cancelled", async () => {
    const cancelGig = vi.fn(async () => ({ gig_id: "g1", status: "cancelled" }));
    const surface = createToolSurface(bareDeps({ hosted: true, cancelGig }));
    const res = await surface.find((t) => t.name === "gig_cancel")!.call({ gig_id: "g1" });
    expect(cancelGig).toHaveBeenCalledWith({ gig_id: "g1" });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ gig_id: "g1", status: "cancelled" });
  });

  it("a store refusal (already claimed/running) surfaces the store's message", async () => {
    const cancelGig = vi.fn(async () => { throw new Error("gig g1 is already running — use gig_abort"); });
    const surface = createToolSurface(bareDeps({ hosted: true, cancelGig }));
    const res = await surface.find((t) => t.name === "gig_cancel")!.call({ gig_id: "g1" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/gig_abort/);
  });
});

// ── the store seams: member vs agent bearer class ───────────────────────────
describe("gig_cancel store seams — member JWT vs agent token", () => {
  const CTX = { baseUrl: "https://store.example", anonKey: "anon-key", bearer: "eyJx.eyJy.zzz" };
  const AGENT_CTX = { baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_abc" };
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify("g1") }) as unknown as Response);
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("a member JWT cancels through coltrane_gig_cancel, riding its own token", async () => {
    const out = await postgrestCancelGig(CTX)({ gig_id: "g1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_gig_cancel");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${CTX.bearer}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_gig"]).toBe("g1");
    expect(body["p_bearer"], "the JWT authenticates via the header, never the body").toBeUndefined();
    expect(out).toEqual({ gig_id: "g1", status: "cancelled" });
  });

  it("an agent token cancels through the definer RPC coltrane_mcp_gig_cancel", async () => {
    await rpcCancelGig(AGENT_CTX)({ gig_id: "g1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example/rest/v1/rpc/coltrane_mcp_gig_cancel");
    // a ctk bearer is not a JWT: it rides the anon key on transport, authenticates in the body
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${AGENT_CTX.anonKey}`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["p_bearer"]).toBe("ctk_abc");
    expect(body["p_gig"]).toBe("g1");
  });
});
