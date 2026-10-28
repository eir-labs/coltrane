// RR-1(c2) — a floored room is REALIZED, not only refused (wiki spec.coltrane.the-red-pass-runs-in-its-room; Vör, round 8).
//
// aRoomNeedsNothing made the claim gate refuse a floored room on a box that cannot build it. But the run's realize decision read only
// mcp_servers and the repository (src/runtime.ts), never floor: the box that CAN build the floor claimed the gig and then ran its chairs
// on the host — the harm the predicate exists to prevent, moved from the gate to the thing the gate protects. A floor is a reason to
// realize. Driven through workOnce: a floored, server-less room with no repository must reach the realizer; a furnishings-only room
// must not (R38 unchanged). Behaviour at the decision site, not a count of how the predicate is spelled.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, type WorkerContext } from "../../src/worker.js";
import type { AgentInvoker } from "../../src/runtime.js";
import type { VenueRealizer, RealizationHandle } from "../../src/venue_realizer.js";

const DIGEST = "sha256:" + "ab".repeat(32);
const CTX = (realizable: string[]): WorkerContext => ({ baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000", worker: "test-worker", realizableVenues: realizable });
const room = (slug: string, extra: Record<string, unknown>) => ({ slug, definition: { slug, institution_slug: "demo", mcp_servers: [], ...extra } });
const GENOME = (venues: unknown[]) => ({
  core_types: [], domain_types: [],
  agents: [{ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["Signal"], domain: "demo", identity: "you are scout", method: "1. look 2. report 3. stop", constraints: [], behavioral_primitives: ["explorer", "critic"], permissions: {}, default_skills: [] }],
  standards: [{ slug: "wire-run-v0", domain: "demo", status: "active", phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }], output_types: ["Signal"] }],
  skills: [], evals: [], venues, charts: [],
});
const CLAIM = (venue: string) => ({ gig_id: "11111111-2222-3333-4444-555555555555", standard_slug: "wire-run-v0", standard_version: null, mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1", credential_expires_at: "2099-01-01T00:00:00Z", venue });
const sealable = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

function store(venues: unknown[], venue: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/rpc/coltrane_mcp_claim")) return new Response(JSON.stringify(CLAIM(venue)), { status: 200 });
    if (u.endsWith("/rpc/coltrane_mcp_gig_outputs")) return new Response("[]", { status: 200 });
    if (u.endsWith("/rpc/coltrane_mcp_gig_status")) return new Response("null", { status: 200 });
    if (u.endsWith("/rpc/coltrane_mcp_genome")) return new Response(JSON.stringify(GENOME(venues)), { status: 200 });
    if (u.endsWith("/rpc/coltrane_mcp_gig_fail")) return new Response("true", { status: 200 });
    return new Response(`unexpected ${u}`, { status: 500 });
  }));
}
function spyRealizer() {
  const realize = vi.fn(async () => ({ state: "PLAYING", mcpServerConfigs: {}, configPath: "", artifacts: [], teardown: () => {}, tornDown: () => true } as unknown as RealizationHandle));
  return { realizer: { substrate: "test", guarantees: [], available: () => true, retention: { max_cached_build_artifacts: 0, max_unreferenced_environments: 0, cadence: "gig" }, realize } as unknown as VenueRealizer, realize };
}
let root: string;
beforeEach(() => { vi.unstubAllGlobals(); root = mkdtempSync(join(tmpdir(), "floored-")); process.env["COLTRANE_WORKER_CHECKPOINTS"] = root; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env["COLTRANE_WORKER_CHECKPOINTS"]; rmSync(root, { recursive: true, force: true }); });

describe("RR-1(c2) — a floored room is realized", () => {
  it("plant: a floored, server-less room with no repository REACHES the realizer (its floor is stood up, the chairs do not run on the host)", async () => {
    store([room("drafting", { floor: DIGEST })], "drafting");
    const { realizer, realize } = spyRealizer();
    await workOnce(CTX(["drafting"]), { makeInvoke: () => vi.fn(async () => sealable) as unknown as AgentInvoker, venueRealizer: realizer });
    expect(realize, "a floored room was not realized: its chairs ran on the host").toHaveBeenCalled();
  });
  it("twin: a furnishings-only room (no servers, no substrate, no floor, no repository) is NOT realized (R38 unchanged)", async () => {
    store([room("furnished", {})], "furnished");
    const { realizer, realize } = spyRealizer();
    await workOnce(CTX(["furnished"]), { makeInvoke: () => vi.fn(async () => sealable) as unknown as AgentInvoker, venueRealizer: realizer });
    expect(realize).not.toHaveBeenCalled();
  });
});
