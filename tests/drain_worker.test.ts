// The drain worker — the process that turns a queued gig into a completed one.
//
// The gig table IS the queue, and until this module nothing consumed it: dispatch queued
// rows (104+ live at time of writing) and every one sat "queued" forever. workOnce is the
// worker's whole verb: claim (atomic, leased, chair-authorized — the store enforces that
// side), load the ORG genome through the agent's own token, execute under the CLAIMED
// gig's id so the drained header completes the queue row rather than minting a parallel
// one, and record failure as a failed status — never an abandoned lease.
//
// RED-first: written against an engine with no src/worker.ts and no rpcGenomeStore.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { workOnce, claimNextGig, failGig, type WorkerContext } from "../src/worker.js";
import { rpcGenomeStore } from "../src/genome_store.js";
import type { AgentInvoker } from "../src/runtime.js";

const CTX: WorkerContext = {
  baseUrl: "https://store.example",
  anonKey: "anon-key",
  agentToken: "ctk_test000",
  worker: "test-worker",
};

// Store rows as coltrane_mcp_genome returns them (to_jsonb of the five tables).
const GENOME_ROWS = {
  core_types: [], // empty → the engine seeds its canonical six, like a bare genome root
  domain_types: [],
  agents: [
    {
      slug: "scout",
      primitives: ["SENSE"],
      input_types: [],
      output_types: ["Signal"],
      domain: "demo",
      identity: "you are scout",
      method: "1. look 2. report 3. stop",
      constraints: [],
      behavioral_primitives: ["explorer", "critic"],
      permissions: {},
      default_skills: [],
    },
  ],
  standards: [
    {
      slug: "wire-run-v0",
      domain: "demo",
      status: "draft",
      phases: [
        {
          name: "scan",
          chairs: [
            { role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] },
          ],
        },
      ],
      output_types: ["Signal"],
    },
  ],
  skills: [],
};

const CLAIM = {
  gig_id: "11111111-2222-3333-4444-555555555555",
  standard_slug: "wire-run-v0",
  standard_version: null,
  mode: "rehearsal",
  input: { subject: "the wire" },
  acting_for: "steve-1",
};

type FetchCall = { url: string; body: Record<string, unknown> };

function mockStore(opts: { claim: unknown; failResult?: boolean }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: u, body });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) {
      return new Response(JSON.stringify(opts.claim), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) {
      return new Response(JSON.stringify(GENOME_ROWS), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) {
      return new Response(JSON.stringify(opts.failResult ?? true), { status: 200 });
    }
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
  return calls;
}

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("claimNextGig — the atomic claim, spoken through the agent's own token", () => {
  it("returns the claimed gig payload", async () => {
    const calls = mockStore({ claim: CLAIM });
    const claim = await claimNextGig(CTX);
    expect(claim).toEqual(CLAIM);
    const rpc = calls.find((c) => c.url.includes("coltrane_mcp_claim"))!;
    expect(rpc.body["p_bearer"]).toBe("ctk_test000");
    expect(rpc.body["p_worker"]).toBe("test-worker");
  });

  it("returns null when the queue holds nothing this agent may run", async () => {
    mockStore({ claim: null });
    expect(await claimNextGig(CTX)).toBeNull();
  });
});

describe("rpcGenomeStore — the org genome, readable through a ctk bearer", () => {
  it("reconstructs the same genome shape the PostgREST store produces", async () => {
    mockStore({ claim: null });
    const genome = await rpcGenomeStore(CTX).load();
    expect(genome.agents.has("scout")).toBe(true);
    expect(genome.standards.has("wire-run-v0")).toBe(true);
    expect(genome.core_types.size).toBe(6); // canonical seed on empty rows
    expect(genome.load_errors).toEqual([]);
  });

  it("refuses upsert — an agent token does not author genome", async () => {
    mockStore({ claim: null });
    await expect(rpcGenomeStore(CTX).upsert("agent", { slug: "x" })).rejects.toThrow(/does not author/);
  });
});

describe("workOnce — claim, run under the claimed id, drain or fail honestly", () => {
  it("an empty queue is a clean no-op: no genome load, no invocation", async () => {
    const calls = mockStore({ claim: null });
    const invoke = vi.fn();
    const res = await workOnce(CTX, { makeInvoke: () => invoke as unknown as AgentInvoker });
    expect(res).toEqual({ claimed: false });
    expect(invoke).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes("coltrane_mcp_genome"))).toBe(false);
  });

  it("runs the claimed gig UNDER ITS QUEUED ID and reports completion", async () => {
    mockStore({ claim: CLAIM });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX, { makeInvoke: () => invoke as unknown as AgentInvoker });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // The whole point: the run's gig id IS the queue row's id, so the drained header
    // completes the claimed row instead of minting a parallel record.
    expect(res.gig_id).toBe(CLAIM.gig_id);
    expect(res.outputs_count).toBe(1);
  });

  it("a failed run records failure through coltrane_mcp_gig_fail — no stuck lease", async () => {
    const calls = mockStore({ claim: CLAIM });
    const invoke = vi.fn(async () => { throw new Error("the model never came back"); });
    const res = await workOnce(CTX, { makeInvoke: () => invoke as unknown as AgentInvoker });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("failed");
    expect(res.gig_id).toBe(CLAIM.gig_id);
    const fail = calls.find((c) => c.url.includes("coltrane_mcp_gig_fail"));
    expect(fail, "gig_fail RPC must be called").toBeDefined();
    expect(fail!.body["p_gig"]).toBe(CLAIM.gig_id);
    expect(String(fail!.body["p_error"])).toMatch(/never came back/);
  });

  it("a claimed standard missing from the genome fails the gig rather than dropping the lease", async () => {
    const calls = mockStore({ claim: { ...CLAIM, standard_slug: "not-in-genome" } });
    const res = await workOnce(CTX, { makeInvoke: () => vi.fn() as unknown as AgentInvoker });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("failed");
    const fail = calls.find((c) => c.url.includes("coltrane_mcp_gig_fail"));
    expect(fail).toBeDefined();
    expect(String(fail!.body["p_error"])).toMatch(/not-in-genome/);
  });
});

describe("failGig", () => {
  it("reports whether the store recorded the failure", async () => {
    mockStore({ claim: null, failResult: true });
    expect(await failGig(CTX, CLAIM.gig_id, "boom")).toBe(true);
  });
});
