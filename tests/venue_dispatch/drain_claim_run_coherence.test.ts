// RED — the claim gate and the run gate must be CONNECTED (SITE 2 coherence).
//
// venueMayClaim (src/worker.ts) is a deny-by-default oracle: a box may claim a room-named gig ONLY
// if its `realizable` set includes that room. So a box that CLAIMS a venue-named gig has, by that
// very gate, declared it can stand the room up. The defect: workOnce then stood NO room up — it
// gated on a room and skipped building it. That is not merely an omission; it is the claim gate and
// the run gate disagreeing about the same room.
//
// The law binds the two: a WorkerContext whose realizableVenues includes "engine-room-v1" claims a
// gig named for that room (venueMayClaim returns true) AND workOnce then reaches venueRealizer.realize
// for that room. Gating on a room and then not building it must fail this law.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, venueMayClaim, type WorkerContext } from "../../src/worker.js";
import type { AgentInvoker } from "../../src/runtime.js";
import type { Venue } from "../../src/chart.js";
import type { VenueRealizer, RealizationHandle } from "../../src/venue_realizer.js";

const CTX = (realizable: string[]): WorkerContext => ({
  baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000",
  worker: "test-worker", realizableVenues: realizable,
});

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
  venue: "engine-room-v1",
};

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

function mockStore(claim: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(claim), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_outputs")) return new Response(JSON.stringify([]), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_status")) return new Response(JSON.stringify(null), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(GENOME_ROWS), { status: 200 });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) return new Response(JSON.stringify(true), { status: 200 });
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
}

// A realizer that RECORDS which rooms it was asked to build — the observable "the run gate fired".
function recordingRealizer(): { realizer: VenueRealizer; built: () => string[] } {
  const built: string[] = [];
  const handle: RealizationHandle = { state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true };
  const realizer = {
    substrate: "test", guarantees: [], available: () => true,
    retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" },
    realize: async (venue: unknown) => { built.push((venue as Venue).slug); return handle; },
  } as unknown as VenueRealizer;
  return { realizer, built: () => built };
}

let stateRoot: string;
beforeEach(() => { vi.unstubAllGlobals(); stateRoot = mkdtempSync(join(tmpdir(), "coltrane-venue-coherence-")); process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env["COLTRANE_WORKER_CHECKPOINTS"]; rmSync(stateRoot, { recursive: true, force: true }); });

describe("SITE 2 — the claim gate and the run gate agree about the room", () => {
  it("a box that MAY claim engine-room-v1 actually stands engine-room-v1 up when it does", async () => {
    // The claim gate opens: this box declared it can realize the room.
    expect(venueMayClaim("engine-room-v1", ["engine-room-v1"]), "the claim gate admits a room this box can build").toBe(true);

    mockStore(CLAIM);
    const { realizer, built } = recordingRealizer();
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX(["engine-room-v1"]), {
      makeInvoke: () => invoke as unknown as AgentInvoker, venueRealizer: realizer,
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // The run gate fired for the SAME room the claim gate admitted — gating on a room and then not
    // building it is the defect this law forbids.
    expect(built(), "workOnce must stand up the room its claim was gated on").toContain("engine-room-v1");
  });
});
