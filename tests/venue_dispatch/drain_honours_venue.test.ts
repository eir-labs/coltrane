// RED — the DRAIN path must honour a named venue (SITE 2 of a two-site defect, the PRODUCTION path).
//
// This is the stranger half. src/worker.ts holds a COMPLETE venue-targeting apparatus:
// venueMayClaim(), a per-box `realizable` set, drain keys bound to a venue, and a deny-by-default
// rule that a box may claim a room-named gig ONLY if it can stand that room up. Then workOnce()
// passed ZERO venue fields into runGig — so a worker refused work for rooms it could not build, and
// then built no room for the ones it could. The targeting layer was fully implemented; the thing it
// targeted for was never connected.
//
// The law: workOnce, given a claimed gig carrying a venue, must call runGig with the venue threaded
// (deps.venue + deps.venueRealizer) — proven observable as the resolved room on the chair's
// invocation context — OR refuse. A completed run whose runGig call carried no deps.venue fails the
// law. This law covers worker.ts specifically: a law covering only src/server.ts leaves the
// production path broken and does not satisfy the criterion.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkerContext } from "../../src/worker.js";
import type { AgentInvoker, AgentInvocationContext } from "../../src/runtime.js";
import type { Venue } from "../../src/chart.js";
import type { VenueRealizer, RealizationHandle } from "../../src/venue_realizer.js";

// A worker in PLAYER mode that can stand up engine-room-v1 (and, for the fail-closed case, is told it
// can stand up a room the org genome does not actually hold).
const CTX = (realizable: string[]): WorkerContext => ({
  baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000",
  worker: "test-worker", realizableVenues: realizable,
});

// A room declaring an mcp server, so runGig reaches the substrate realizer for it.
const ENGINE_ROOM_DEF = {
  slug: "engine-room-v1", institution_slug: "demo",
  equipment: { tools: [] }, credential_surface: [],
  mcp_servers: [{ slug: "engine", transport: "stdio", command: ["engine-mcp"], credential_names: [] }],
  lifecycle: { policy: "ephemeral" },
};

const GENOME_ROWS = {
  core_types: [], domain_types: [],
  agents: [
    { slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"], domain: "demo",
      identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [],
      behavioral_primitives: ["explorer", "critic"], permissions: {}, default_skills: [] },
  ],
  standards: [
    { slug: "wire-run-v0", domain: "demo", status: "draft",
      phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
      output_types: ["Signal"] },
  ],
  skills: [], evals: [],
  venues: [{ slug: "engine-room-v1", definition: ENGINE_ROOM_DEF }],
  charts: [],
};

const CLAIM = {
  gig_id: "11111111-2222-3333-4444-555555555555", standard_slug: "wire-run-v0",
  standard_version: null, mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1",
};

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

type FetchCall = { url: string; body: Record<string, unknown> };
function mockStore(claim: unknown): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(claim), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_outputs")) return new Response(JSON.stringify([]), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_status")) return new Response(JSON.stringify(null), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(GENOME_ROWS), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) return new Response(JSON.stringify(true), { status: 200 });
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
  return calls;
}

// A realizer whose realize() returns an inert handle — enough for runGig to stand the room's
// substrate up and tear it down.
function spyRealizer(): VenueRealizer {
  const handle: RealizationHandle = { state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true };
  return {
    substrate: "test", guarantees: [], available: () => true,
    retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async () => handle,
  } as unknown as VenueRealizer;
}

let stateRoot: string;
beforeEach(() => { vi.unstubAllGlobals(); stateRoot = mkdtempSync(join(tmpdir(), "coltrane-venue-drain-")); process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env["COLTRANE_WORKER_CHECKPOINTS"]; rmSync(stateRoot, { recursive: true, force: true }); });

describe("SITE 2 — the drain path honours a named venue", () => {
  it("a claimed gig carrying a venue reaches runGig with the room resolved onto the chair ctx", async () => {
    let captured: AgentInvocationContext | undefined;
    mockStore({ ...CLAIM, venue: "engine-room-v1" });
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => { captured = ctx; return sealableSignal; });
    const res = await workOnce(CTX(["engine-room-v1"]), {
      makeInvoke: () => invoke as unknown as AgentInvoker, venueRealizer: spyRealizer(),
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // The resolved room on the chair ctx is the proof deps.venue reached runGig. workOnce used to
    // pass ZERO venue fields, so this was always undefined — a 'complete' with no venue on the run.
    expect((captured as unknown as { venue?: Venue } | undefined)?.venue?.slug, "workOnce must thread claim.venue into runGig").toBe("engine-room-v1");
  });

  it("a venue the org genome cannot resolve FAILS CLOSED — the drain never runs it unconfined", async () => {
    const calls = mockStore({ ...CLAIM, venue: "ghost-room-v1" });
    // The box is (mis)told it can realize ghost-room-v1, so the claim is admitted — then the run must
    // still refuse, because the genome holds no such room to confine it with.
    const res = await workOnce(CTX(["ghost-room-v1"]), {
      makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker, venueRealizer: spyRealizer(),
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status, "a named room the genome cannot resolve must not complete venue-less").toBe("failed");
    expect(String(res.error)).toMatch(/venue|refused/i);
    const fail = calls.find((c) => c.url.includes("coltrane_mcp_gig_fail"));
    expect(fail, "the refusal is recorded as a failed gig, not an abandoned lease").toBeDefined();
  });

  it("a venue-less claim is wholly unchanged — no room, no refusal", async () => {
    let captured: AgentInvocationContext | undefined;
    mockStore({ ...CLAIM, venue: null });
    const invoke = vi.fn(async (ctx: AgentInvocationContext) => { captured = ctx; return sealableSignal; });
    const res = await workOnce(CTX(["engine-room-v1"]), { makeInvoke: () => invoke as unknown as AgentInvoker, venueRealizer: spyRealizer() });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect((captured as unknown as { venue?: Venue } | undefined)?.venue, "an unnamed gig carries no room").toBeUndefined();
  });
});
