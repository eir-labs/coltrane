// THE DRAIN GETS A REALIZER (#23) — `coltrane work` must construct the containerized realizer and
// hand it to workOnce, exactly as the interactive path does at src/server.ts:3486.
//
// ONE DEFECT, third of a shape already fixed twice this week: a capability that EXISTS, is CORRECT,
// and is unreachable because nothing constructs it (dockerComposeRealizer was unreachable from
// dispatch, #397; here it is unreachable from the drain). src/cli.ts's `work` branch handed workOnce
// only `{ makeInvoke, log }` and NEVER `deps.venueRealizer`. So the fail-closed guard at
// src/worker.ts:1023-1028 —
//
//     `claimed gig <id> names venue "<X>", whose declared mcp_servers need a realizer this worker
//      was not given — refusing rather than running the room unbuilt`
//
// — fired for EVERY venue-gig whose room declares mcp_servers on the production drain: a box that
// gated its own claim on being able to stand the room up (venueMayClaim) then refused to stand it up.
// That refusal text is the current-code failure these laws are written against.
//
// THREE LAWS:
//   1. SURVIVAL  — a worker built WITHOUT a realizer still refuses such a gig with that exact text
//                  (green on old AND new code; a "fix" that deletes the guard makes this go red).
//   2. WIRING    — `coltrane work` (runCli) supplies a venueRealizer to workOnce (RED on old code,
//                  green once cli.ts constructs one).
//   3. PARITY    — src/cli.ts constructs dockerComposeRealizer() at its workOnce call site, matching
//                  src/server.ts's construction shape — one shape across both paths, not two.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workOnce, type WorkerContext } from "../../src/worker.js";
import type { AgentInvoker } from "../../src/runtime.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

// ── Shared fixtures — a room that DECLARES an mcp server, so the guard's precondition is met ──────
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
    { slug: "wire-run-v0", domain: "demo", status: "active",  // the drain runs ACTIVE standards; a draft is not dispatchable
      phases: [{ name: "scan", chairs: [{ role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] }] }],
      output_types: ["Signal"] },
  ],
  skills: [], evals: [],
  venues: [{ slug: "engine-room-v1", definition: ENGINE_ROOM_DEF }],
  charts: [],
};

const CLAIM = {
  gig_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", standard_slug: "wire-run-v0",
  standard_version: null, mode: "rehearsal", input: { subject: "the wire" }, acting_for: "steve-1",
  venue: "engine-room-v1",
};

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

type FetchCall = { url: string; body: Record<string, unknown> };
/** Mock the org store: hand back a venue-named claim, an empty genome-output set, and record a
 *  failGig call so the survival law can prove the refusal was drained as a failure, not abandoned. */
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

// A worker in PLAYER mode whose realizable set INCLUDES engine-room-v1, so venueMayClaim admits the
// claim and control reaches the guard. (The direct-workOnce laws arrange the claim themselves — the
// drain's own claim path does not populate realizableVenues, which is #23's out-of-scope companion.)
const CTX = (): WorkerContext => ({
  baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_test000",
  worker: "test-worker", realizableVenues: ["engine-room-v1"],
});

let stateRoot: string;
beforeEach(() => { vi.unstubAllGlobals(); stateRoot = mkdtempSync(join(tmpdir(), "coltrane-cli-realizer-")); process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot; });
afterEach(() => { vi.unstubAllGlobals(); delete process.env["COLTRANE_WORKER_CHECKPOINTS"]; rmSync(stateRoot, { recursive: true, force: true }); });

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW 1 — SURVIVAL. The fail-closed guard must remain: a worker with NO realizer still refuses a
// venue-gig whose room declares mcp_servers, with the exact named error, and records it FAILED. A
// fix that removes the guard instead of satisfying it makes this law go red. Green on old AND new.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("#23 survival — a worker WITHOUT a realizer still refuses a room it cannot build", () => {
  it("refuses with the exact named error and drains the gig as failed", async () => {
    const calls = mockStore(CLAIM);
    // No venueRealizer in deps — the box was given none, so the guard must fire.
    const res = await workOnce(CTX(), {
      makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker,
    });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status, "a room this worker cannot realize must not run unbuilt").toBe("failed");
    // Pin the EXACT refusal — not a loose /refus/ — so an unrelated failure cannot masquerade as
    // this guard, and a softened/reworded guard fails the law.
    expect(String(res.error)).toContain(
      `whose declared mcp_servers need a realizer this worker was not given — refusing rather than running the room unbuilt`,
    );
    const fail = calls.find((c) => c.url.includes("coltrane_mcp_gig_fail"));
    expect(fail, "the refusal is recorded as a failed gig, not an abandoned lease").toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW 2 — WIRING (red-to-green). `coltrane work` must supply a venueRealizer to workOnce. Observed
// by mocking workOnce and inspecting the deps `coltrane work` hands it: on current code cli.ts passes
// `{ makeInvoke, log }` with NO venueRealizer, so this FAILS; once cli.ts constructs one it passes.
//
// DEPARTURE from the plan's chosen observable (refusal-text-absent after runCli reaches the guard):
// via runCli the claim gate refuses a venue-gig FIRST — cli.ts does not populate
// realizableVenues, so venueMayClaim returns false and the run never reaches the guard at all (the
// out-of-scope companion defect, #23). Inspecting the deps workOnce is actually handed proves the one
// thing this change is responsible for — that cli.ts SUPPLIES the realizer — without depending on the
// claim path the change is scoped out of touching.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("#23 wiring — coltrane work supplies a venueRealizer to workOnce", () => {
  const MODE_VARS = ["COLTRANE_STORE_URL", "COLTRANE_STORE_ANON", "COLTRANE_AGENT_TOKEN", "COLTRANE_DRAIN_KEY", "COLTRANE_INSTANCE", "FLY_APP_NAME"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of MODE_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
    // PLAYER mode: store URL + anon + an agent token, no drain key. Enough for the `work` branch to
    // pass its credential check and reach the workOnce call.
    process.env["COLTRANE_STORE_URL"] = "https://store.example";
    process.env["COLTRANE_STORE_ANON"] = "anon-key";
    process.env["COLTRANE_AGENT_TOKEN"] = "ctk_test000";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.resetModules();
    vi.doUnmock("../../src/worker.js");
  });

  it("the deps object handed to workOnce carries a venueRealizer", async () => {
    // Mock the worker module for a FRESH import of cli.ts, so the file's other laws keep the real
    // workOnce. The spy stands in for a completed claim; we only care what deps it was called with.
    const spy = vi.fn(async () => ({ claimed: true, gig_id: "g1", status: "complete", outputs_count: 0 }));
    vi.resetModules();
    vi.doMock("../../src/worker.js", () => ({ workOnce: spy }));
    const { runCli } = await import("../../src/cli.js");

    const code = await runCli(["work"], { out: () => {}, err: () => {} });
    expect(code, "a completed claim exits 0").toBe(0);
    expect(spy, "coltrane work must call workOnce").toHaveBeenCalledTimes(1);
    const deps = (spy.mock.calls[0] as unknown as [unknown, { venueRealizer?: unknown }])[1];
    // The whole defect: this field was absent, so every venue-gig with declared mcp_servers hit the
    // guard's refusal. Present ⇒ the drain can stand the room up, the same as the interactive path.
    expect(deps.venueRealizer, "cli.ts must construct and pass a venueRealizer — see the guard at worker.ts:1023").toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// LAW 3 — CONSTRUCTION PARITY (red-to-green). One construction shape across the drain and interactive
// paths, pinned as an executable law rather than a manual grep (AC4). On current code src/cli.ts has
// neither the import nor the construction, so this FAILS.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("#23 parity — cli.ts constructs the realizer the same way server.ts does", () => {
  const cli = readFileSync(join(REPO, "src/cli.ts"), "utf8");
  const server = readFileSync(join(REPO, "src/server.ts"), "utf8");

  it("src/cli.ts imports dockerComposeRealizer from ./venue_realizer.js", () => {
    expect(
      cli,
      "the drain path must import the realizer from the same module the interactive path does",
    ).toMatch(/import\s*\{[^}]*\bdockerComposeRealizer\b[^}]*\}\s*from\s*["']\.\/venue_realizer\.js["']/);
  });

  it("src/cli.ts constructs `venueRealizer: dockerComposeRealizer()`, matching src/server.ts", () => {
    const shape = /venueRealizer:\s*dockerComposeRealizer\(\)/;
    expect(server, "server.ts is the construction template (src/server.ts:3486)").toMatch(shape);
    expect(
      cli,
      "cli.ts must construct the realizer at its workOnce call site — one shape, not two",
    ).toMatch(shape);
  });
});
