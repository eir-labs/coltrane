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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workOnce, claimNextGig, failGig, type WorkerContext } from "../src/worker.js";
import { rpcGenomeStore } from "../src/genome_store.js";
import { genomeHash, type AgentInvoker } from "../src/runtime.js";

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
      carried_skills: [
        { slug: "carried-probe", skill_type: "extraction", description: "a carried definition riding the agent row" },
      ],
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
    // The drift the worker's first live claim found: input_types is load-bearing (the
    // entry-chair-seed rule) and the store round-trip had dropped it — every org standard
    // failed composition at its entry chair. A store standard whose entry chair leans on
    // the gig input must reconstruct cleanly.
    {
      slug: "seeded-entry-v0",
      domain: "demo",
      status: "draft",
      input_types: ["Signal"],
      phases: [
        {
          name: "scan",
          chairs: [
            { role: "scan", agent_slug: "scout", depends_on: [], input_contract: ["Signal"], output_contract: ["Signal"], optional_outputs: [], required_skills: [] },
          ],
        },
      ],
      output_types: ["Signal"],
    },
    // The human seat, as an org standard: one model chair, then a chair a PERSON holds. A
    // worker that claims this row cannot finish it alone — the approval is the gate.
    {
      slug: "approve-run-v0",
      domain: "demo",
      status: "draft",
      phases: [
        {
          name: "scan",
          chairs: [
            { role: "scan", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["Signal"], optional_outputs: [], required_skills: [] },
          ],
        },
        {
          name: "approve",
          chairs: [
            { role: "approve", human: true, agent_slug: "", depends_on: ["scan"], input_contract: [], output_contract: ["Judgment"], optional_outputs: [], required_skills: [] },
          ],
        },
      ],
      output_types: ["Signal", "Judgment"],
    },
  ],
  skills: [],
  venues: [
    { slug: "bare-room", definition: { slug: "bare-room", institution_slug: "demo", equipment: { tools: [] }, lifecycle: { policy: "ephemeral" } } },
  ],
  charts: [
    { slug: "wire-set-v0", definition: { slug: "wire-set-v0", movements: [{ movement_id: "only", standard_slug: "wire-run-v0" }] } },
  ],
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

function mockStore(opts: {
  claim: unknown;
  failResult?: boolean;
  park?: boolean | "absent";
  /** What `coltrane_mcp_gig_outputs` answers — the gig's drained rows. Default: none. */
  drained?: unknown;
  /** What `coltrane_mcp_gig_status` answers — the drained gig HEADER. Default: no header. */
  header?: unknown;
}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: u, body });
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_claim")) {
      return new Response(JSON.stringify(opts.claim), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_outputs")) {
      return new Response(JSON.stringify(opts.drained ?? []), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_status")) {
      return new Response(JSON.stringify(opts.header ?? null), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_genome")) {
      return new Response(JSON.stringify(GENOME_ROWS), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_fail")) {
      return new Response(JSON.stringify(opts.failResult ?? true), { status: 200 });
    }
    if (u.endsWith("/rest/v1/rpc/coltrane_mcp_gig_park")) {
      // A store that has not deployed the park RPC yet answers PostgREST's own 404.
      if (opts.park === "absent") {
        return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.coltrane_mcp_gig_park(p_bearer, p_gig) in the schema cache" }), { status: 404 });
      }
      return new Response(JSON.stringify(opts.park ?? true), { status: 200 });
    }
    return new Response(`unexpected url ${u}`, { status: 500 });
  }));
  return calls;
}

const sealableSignal = { id: "sig-1", source: "test", data: { seen: true }, completeness: 1, acquisition_cost: 0 };

// The worker keeps durable state (checkpoints + the sealed rows they name) so an approved
// re-claim can resume. Every test in this file redirects that root into a temp dir: a suite
// that wrote into $HOME would leave a checkpoint behind, and the NEXT run of the test above
// would silently resume from it instead of running cold.
let stateRoot: string;
beforeEach(() => {
  vi.unstubAllGlobals();
  stateRoot = mkdtempSync(join(tmpdir(), "coltrane-worker-state-"));
  process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["COLTRANE_WORKER_CHECKPOINTS"];
  rmSync(stateRoot, { recursive: true, force: true });
});

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
    // carried skills ride the agent row through the store round-trip
    expect(genome.agents.get("scout")!.skills?.[0]?.slug).toBe("carried-probe");
    expect(genome.standards.has("wire-run-v0")).toBe(true);
    expect(genome.core_types.size).toBe(6); // canonical seed on empty rows
    // charts + venues ride the store round-trip through the same gates the loader runs
    expect(genome.venues.has("bare-room")).toBe(true);
    expect(genome.charts.has("wire-set-v0")).toBe(true);
    expect(genome.load_errors).toEqual([]);
    // input_types survived the round-trip: the seeded-entry standard composed instead of
    // dying with "requires Signal not produced by any upstream chair".
    expect(genome.standards.has("seeded-entry-v0")).toBe(true);
    expect(genome.standards.get("seeded-entry-v0")!.input_types).toEqual(["Signal"]);
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

// ── the approval loop, seen from the queue ───────────────────────────────────────
// The worker is the process that ACTUALLY runs an org's gigs, so the human seat is only
// reachable in production if the worker speaks it: park the row without failing it, carry
// the approvals the store handed back on the next claim, and resume from the checkpoint so
// the chairs already paid for are not replayed. Every one of those is money or truth.
describe("workOnce — the human seat, claimed twice", () => {
  const APPROVAL_CLAIM = { ...CLAIM, standard_slug: "approve-run-v0" };
  const VERDICT = {
    id: "approval-1", input_refs: [],
    criteria: ["the scan covers the declared boundary"],
    verdicts: [{ criterion: "the scan covers the declared boundary", verdict: "approved" }],
    reasoning_chain: ["read the sealed scan; the boundary matches the queued payload"],
  };
  /** The claim payload the approve RPC produces: per-role verdict + who approved it. */
  const APPROVED_CLAIM = {
    ...APPROVAL_CLAIM,
    approvals: { approve: { verdict: VERDICT, approved_by: "eugene" } },
  };

  const sealed = (gig_id: string): Array<Record<string, unknown>> =>
    readFileSync(join(stateRoot, "outputs", `${gig_id}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  it("parks an unapproved human chair: not complete, not failed, and the lease is released", async () => {
    const calls = mockStore({ claim: APPROVAL_CLAIM });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX, { makeInvoke: () => invoke as unknown as AgentInvoker });
    expect(res.claimed).toBe(true);
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("awaiting_approval");
    expect(res.awaiting).toEqual({ phase: "approve", role: "approve" });
    // Recording it as failed would be a lie an operator acts on, and would take the row out of
    // the approve→requeue path entirely.
    expect(calls.some((c) => c.url.includes("coltrane_mcp_gig_fail")), "a parked gig is not a failed gig").toBe(false);
    const park = calls.find((c) => c.url.includes("coltrane_mcp_gig_park"));
    expect(park, "the lease must be released so the approval can re-queue the row").toBeDefined();
    expect(park!.body["p_bearer"]).toBe("ctk_test000");
    expect(park!.body["p_gig"]).toBe(CLAIM.gig_id);
  });

  it("a store without the park RPC does not turn a park into a failure", async () => {
    // The drained header already says awaiting_approval; an absent release is a missing
    // convenience, not a lost fact, and must not be reported as a crashed run.
    const lines: string[] = [];
    mockStore({ claim: APPROVAL_CLAIM, park: "absent" });
    const res = await workOnce(CTX, { makeInvoke: () => vi.fn(async () => sealableSignal) as unknown as AgentInvoker, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("awaiting_approval");
    expect(lines.join("\n")).toMatch(/park/i);
  });

  it("the claim's approvals reach the run: it completes and seals under the approver", async () => {
    mockStore({ claim: APPROVED_CLAIM });
    const invoke = vi.fn(async () => sealableSignal);
    const res = await workOnce(CTX, { makeInvoke: () => invoke as unknown as AgentInvoker });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(res.outputs_count).toBe(2);
    const judgment = sealed(CLAIM.gig_id).find((o) => o["domain_type"] === "Judgment");
    expect(judgment, "the human chair sealed").toBeDefined();
    expect(judgment!["agent_slug"], "under the approving principal, not \"human\"").toBe("eugene");
  });

  it("an approved RE-CLAIM resumes from the checkpoint instead of replaying the paid chair", async () => {
    const invoke = vi.fn(async () => sealableSignal);
    const make = () => invoke as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    expect((await workOnce(CTX, { makeInvoke: make }) as { status: string }).status).toBe("awaiting_approval");
    expect(invoke).toHaveBeenCalledTimes(1);
    // Approved, re-queued, claimed again — the scan already sealed and was already paid for.
    mockStore({ claim: APPROVED_CLAIM });
    const second = await workOnce(CTX, { makeInvoke: make });
    if (!second.claimed) throw new Error("unreachable");
    expect(second.status).toBe("complete");
    expect(invoke, "the model chair must be restored, not re-run").toHaveBeenCalledTimes(1);
  });

  it("a checkpoint the run identity has moved under is re-run COLD, not failed", async () => {
    const invoke = vi.fn(async () => sealableSignal);
    const make = () => invoke as unknown as AgentInvoker;
    const lines: string[] = [];
    mockStore({ claim: APPROVAL_CLAIM });
    await workOnce(CTX, { makeInvoke: make, log: (l) => lines.push(l) });
    // Same row, different payload — the resume gate refuses (gig_input_sha moved). A refusal is
    // the engine declining to splice two runs together, not a reason to fail the gig.
    mockStore({ claim: { ...APPROVED_CLAIM, input: { subject: "a different wire" } } });
    const second = await workOnce(CTX, { makeInvoke: make, log: (l) => lines.push(l) });
    if (!second.claimed) throw new Error("unreachable");
    expect(second.status).toBe("complete");
    expect(invoke, "cold means the model chair runs again").toHaveBeenCalledTimes(2);
    expect(lines.join("\n"), "and it must SAY it paid for a cold run").toMatch(/cold/i);
  });
});

// ── resume from the DRAIN ────────────────────────────────────────────────────────
// The local checkpoint cannot serve the case the human seat actually creates: a gig parked at
// a person's chair is re-claimed hours or days later, by a DIFFERENT worker on a DIFFERENT
// machine, which has never seen this gig's durable state. The sink has, though — every sealed
// output drained to it with its content_sha, its input_shas, its phase and its data. These
// tests drive that reconstruction, and every one of them asserts on MONEY: whether the model
// was invoked a second time for work the org already paid for.
describe("workOnce — the drain IS the checkpoint (a fresh worker re-claims)", () => {
  const APPROVAL_CLAIM = { ...CLAIM, standard_slug: "approve-run-v0" };
  const VERDICT = {
    id: "approval-1", input_refs: [],
    criteria: ["the scan covers the declared boundary"],
    verdicts: [{ criterion: "the scan covers the declared boundary", verdict: "approved" }],
    reasoning_chain: ["read the sealed scan; the boundary matches the queued payload"],
  };
  const APPROVED_CLAIM = {
    ...APPROVAL_CLAIM,
    approvals: { approve: { verdict: VERDICT, approved_by: "eugene" } },
  };

  /** Temp roots the "first worker" used — cleaned after each test. */
  let priorRoots: string[] = [];
  afterEach(() => {
    for (const r of priorRoots) rmSync(r, { recursive: true, force: true });
    priorRoots = [];
  });

  const sealedIn = (root: string, gig_id: string): Array<Record<string, unknown>> =>
    readFileSync(join(root, "outputs", `${gig_id}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  /** The genome_hash the store's own header would carry for this standard, right now. */
  async function currentGenomeHash(): Promise<string> {
    const genome = await rpcGenomeStore(CTX).load();
    return genomeHash(genome.standards.get("approve-run-v0")!);
  }

  /**
   * Park the gig on ONE worker, then hand back its sealed rows PROJECTED to exactly the field
   * set `coltrane_mcp_gig_outputs` returns — which is what a second machine can actually see.
   * The first worker's durable state is left behind (its own temp root), so the second run
   * starts with no local checkpoint and no local output store: a genuinely fresh worker.
   */
  async function parkOnAnotherWorker(invoke: AgentInvoker): Promise<Array<Record<string, unknown>>> {
    const firstRoot = mkdtempSync(join(tmpdir(), "coltrane-worker-first-"));
    priorRoots.push(firstRoot);
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = firstRoot;
    const res = await workOnce(CTX, { makeInvoke: () => invoke });
    if (!res.claimed || res.status !== "awaiting_approval") throw new Error(`expected a park, got ${JSON.stringify(res)}`);
    process.env["COLTRANE_WORKER_CHECKPOINTS"] = stateRoot;
    return sealedIn(firstRoot, CLAIM.gig_id).map((r) => ({
      id: r["id"], domain_type: r["domain_type"], agent_slug: r["agent_slug"], phase: r["phase"],
      content_sha: r["content_sha"], input_shas: r["input_shas"], created_at: r["created_at"], data: r["data"],
    }));
  }

  it("rebuilds the checkpoint from the drain: the paid chair is restored, not re-invoked", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    const drained = await parkOnAnotherWorker(invoke);
    expect(drained).toHaveLength(1);
    const genome_hash = await currentGenomeHash();

    const lines: string[] = [];
    mockStore({ claim: APPROVED_CLAIM, drained, header: { genome_hash } });
    const res = await workOnce(CTX, { makeInvoke: () => invoke, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    // THE WHOLE POINT: one invocation across two workers. The scan came back from the sink.
    expect(invoke, "the model chair must be restored from the drain, not paid for twice").toHaveBeenCalledTimes(1);
    expect(res.outputs_count).toBe(2);
    expect(lines.join("\n"), "and it must SAY which path it took").toMatch(/drain/i);

    // The approval sealed under the approving principal, and its provenance names the
    // reconstructed scan by CONTENT — the chain crosses the machine boundary intact.
    const rows = sealedIn(stateRoot, CLAIM.gig_id);
    const judgment = rows.find((o) => o["domain_type"] === "Judgment");
    expect(judgment, "the human chair sealed").toBeDefined();
    expect(judgment!["agent_slug"]).toBe("eugene");
    expect(judgment!["input_shas"]).toEqual([drained[0]!["content_sha"]]);
    const restored = rows.find((o) => o["domain_type"] === "Signal")!;
    expect(restored["content_sha"], "the reconstructed row re-hashes to the sha the sink recorded")
      .toBe(drained[0]!["content_sha"]);
  });

  it("a local checkpoint is the FAST PATH — the drain is not even asked for", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    await workOnce(CTX, { makeInvoke: () => invoke });
    const calls = mockStore({ claim: APPROVED_CLAIM, drained: [], header: {} });
    const res = await workOnce(CTX, { makeInvoke: () => invoke });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.includes("coltrane_mcp_gig_outputs")), "the local checkpoint answered; nothing to fetch").toBe(false);
  });

  it("a sink row that no longer hashes to its claimed content_sha must never seed a resume", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    const drained = await parkOnAnotherWorker(invoke);
    const genome_hash = await currentGenomeHash();
    const tampered = drained.map((r) => ({ ...r, content_sha: "0".repeat(64) }));

    const lines: string[] = [];
    mockStore({ claim: APPROVED_CLAIM, drained: tampered, header: { genome_hash } });
    const res = await workOnce(CTX, { makeInvoke: () => invoke, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke, "a row whose bytes do not match its sha buys a COLD run, not a resume").toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toMatch(/content_sha/i);
    expect(lines.join("\n")).toMatch(/cold/i);
  });

  it("a genome that moved since those outputs sealed is refused, and it says so", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    const drained = await parkOnAnotherWorker(invoke);

    const lines: string[] = [];
    mockStore({ claim: APPROVED_CLAIM, drained, header: { genome_hash: "a".repeat(64) } });
    const res = await workOnce(CTX, { makeInvoke: () => invoke, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke, "chairs from genome B must not consume outputs sealed under genome A").toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toMatch(/genome/i);
    expect(lines.join("\n")).toMatch(/cold/i);
  });

  it("a header the sink cannot pin a genome_hash on is not a resume either", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    const drained = await parkOnAnotherWorker(invoke);

    const lines: string[] = [];
    mockStore({ claim: APPROVED_CLAIM, drained, header: null });
    const res = await workOnce(CTX, { makeInvoke: () => invoke, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke, "an unverifiable pipeline identity resolves to doing the work").toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toMatch(/genome_hash/i);
  });

  it("adopts rows the local store already holds instead of sealing each one twice", async () => {
    // The reachable shape of this: the checkpoint file goes missing (a swallowed checkpoint
    // write, a cleared checkpoints dir) while `outputs/<gig>.jsonl` survives. Reconstructing
    // then must not append second copies — `output_query` and `output_trace` would report a gig
    // that sealed each record twice, and the duplicates would be byte-identical.
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    mockStore({ claim: APPROVAL_CLAIM });
    const res1 = await workOnce(CTX, { makeInvoke: () => invoke });
    if (!res1.claimed || res1.status !== "awaiting_approval") throw new Error("expected a park");
    const drained = sealedIn(stateRoot, CLAIM.gig_id).map((r) => ({
      id: r["id"], domain_type: r["domain_type"], agent_slug: r["agent_slug"], phase: r["phase"],
      content_sha: r["content_sha"], input_shas: r["input_shas"], created_at: r["created_at"], data: r["data"],
    }));
    rmSync(join(stateRoot, "checkpoints", `${CLAIM.gig_id}.json`), { force: true });
    const genome_hash = await currentGenomeHash();

    mockStore({ claim: APPROVED_CLAIM, drained, header: { genome_hash } });
    const res = await workOnce(CTX, { makeInvoke: () => invoke });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(sealedIn(stateRoot, CLAIM.gig_id), "one Signal, one Judgment — no duplicate seal").toHaveLength(2);
  });

  it("an empty drain is simply a cold run — the offline case is unchanged", async () => {
    const invoke = vi.fn(async () => sealableSignal) as unknown as AgentInvoker;
    const lines: string[] = [];
    mockStore({ claim: APPROVED_CLAIM, drained: [], header: {} });
    const res = await workOnce(CTX, { makeInvoke: () => invoke, log: (l) => lines.push(l) });
    if (!res.claimed) throw new Error("unreachable");
    expect(res.status).toBe("complete");
    expect(invoke).toHaveBeenCalledTimes(1); // the one model chair of this run, cold
    expect(res.outputs_count).toBe(2);
  });
});

describe("failGig", () => {
  it("reports whether the store recorded the failure", async () => {
    mockStore({ claim: null, failResult: true });
    expect(await failGig(CTX, CLAIM.gig_id, "boom")).toBe(true);
  });
});
