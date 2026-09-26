// R5.2–R5.4 — WHEN THE STORE DECIDES WHETHER A GIG IS CLOSED, EVERY PART OF THAT DECISION IS A LAW.
// (docs/specs/gig-runs-once.red-spec.json)
//
// L4 made the store's status the authority for G4 at the gig_dispatch door: with ServerDeps.gigStatus
// present, the store says whether the resumed gig is closed. The implementer's mutation run on 30183e1
// left three survivors in that decision, and each gets a law here:
//   R5.2  THE STORE CAN'T ANSWER → REFUSE. If gigStatus throws, or never answers, the resume is refused
//         and the reason is named. The door never falls back to the checkpoint: the checkpoint is exactly
//         the authority the store replaced, and a guess picks which id to write under.
//   R5.3  THE CLOSED SET IS COMPLETE. `completed` and `cancelled` make the resume a new gig, just like
//         failed/aborted. `running`, `queued` and `awaiting_approval` keep the id.
//   R5.4  THE REAL STORE READER IS EXERCISED. rpcGigStatus (src/genome_store.ts) is driven against a
//         fake coltrane_mcp_gig_status, and its answer reaches the closed/open decision.
//
// Obligation OUTSIDE this repo (recorded in the red-spec): the HOST (eir-labs/coltrane-ui) must wire
// ServerDeps.gigStatus = rpcGigStatus(...) the way it wires queueGig. Until it does, no hosted door has
// a store to ask, and the checkpoint decides.
//
// Every case starts from the same checkpoint: a failed gig whose `ended` mark is absent, which is what
// a lost lease leaves behind. What the checkpoint says must not change the answer; only the store may.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { rpcGigStatus } from "../src/genome_store.js";
import { createMemoryCheckpointStore, type CheckpointStore } from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const callT: DomainType = { slug: "call", extends: "Verdict", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };
const NOTE = { t: "hi", source: "fixture://demo/note" };
const CALL = { v: "go", checks: [{ method: "the fixture ran one check", result: "pass" }] };
const SLUG = "store-decides-demo";
const chairs: Chair[] = [
  { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] },
  { role: "g", agent_slug: "gate", depends_on: ["s"], input_contract: ["note"], output_contract: ["call"], required_skills: [] },
];
const standard = (): Standard => composeStandard({
  slug: SLUG, domain: "demo",
  agents: [
    testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "gate", primitives: ["VERIFY"], input_types: ["note"], output_types: ["call"], domain: "demo" }),
  ],
  phases: [{ name: "sense", chairs: [chairs[0]!] } as PhaseDef, { name: "verify", chairs: [chairs[1]!] } as PhaseDef],
});

/**
 * A failed gig with a checkpoint.
 * `ended`: whether the checkpoint KNOWS it ended (true = the checkpoint alone would say "closed").
 */
async function failedGig(gigStatus: ServerDeps["gigStatus"], ended: boolean): Promise<{ d: ServerDeps; oldId: string }> {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(callT);
  const std = standard();
  let failGate = true;
  const invoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "gate" && failGate) { failGate = false; throw new Error("stub gate failure"); }
    return ctx.agent.slug === "solo" ? { ...NOTE } : { ...CALL };
  };
  const checkpoints: CheckpointStore = createMemoryCheckpointStore();
  const d: ServerDeps = {
    registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]), invoke, gig_runs: new Map(), checkpoints,
  };
  const r1 = await dispatchTool("gig_dispatch", { standard_slug: SLUG, input: {}, wait: true }, d);
  expect(r1.ok, "precondition: attempt 1 fails at the gate").toBe(false);
  const oldId = d.outputs.all()[0]!.gig_id;
  const cp = checkpoints.read(oldId) as unknown as Record<string, unknown>;
  expect(cp, "precondition: attempt 1 left a checkpoint").toBeDefined();
  if (!ended) {
    const { ended: _drop, ...rest } = cp;
    checkpoints.write(rest as never);
  }
  expect(Boolean((checkpoints.read(oldId) as unknown as Record<string, unknown>)["ended"])).toBe(ended);
  d.gigStatus = gigStatus;
  return { d, oldId };
}

const resume = (d: ServerDeps, oldId: string) =>
  dispatchTool("gig_dispatch", { standard_slug: SLUG, input: {}, wait: true, resume_gig_id: oldId }, d);

const idOf = (r: Awaited<ReturnType<typeof resume>>): string => String((r.data as Record<string, unknown>)["gig_id"]);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("R5.2 — a store that cannot answer refuses the resume; it never falls back to the checkpoint", () => {
  it("R5.2a gigStatus THROWS: the resume is refused, the reason names the store, nothing runs under either id, and it holds even when the checkpoint says the gig ended", async () => {
    for (const ended of [true, false]) {
      const { d, oldId } = await failedGig(async () => { throw new Error("store unreachable: ECONNRESET"); }, ended);
      const before = d.outputs.all().length;
      const r = await resume(d, oldId);
      expect(r.ok, `the store could not answer and the door resumed anyway (checkpoint ended=${ended}); it fell back to the checkpoint`).toBe(false);
      expect(String(r.error ?? ""), "the refusal must name why: the store could not say").toMatch(/store/i);
      expect(String(r.error ?? ""), "the refusal must carry the store's own error").toMatch(/ECONNRESET/);
      expect(d.outputs.all().length, "a refused resume sealed something").toBe(before);
    }
  });

  it("R5.2b gigStatus NEVER ANSWERS: within 30 s the resume is refused, naming the store, and not decided from the checkpoint", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { d, oldId } = await failedGig(() => new Promise<string>(() => { /* the store never answers */ }), true);
    let settled: Awaited<ReturnType<typeof resume>> | undefined;
    const pending = resume(d, oldId).then((r) => { settled = r; return r; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled, "the door is still waiting on a store that never answers, and the resume hangs forever").toBeDefined();
    const r = await pending;
    expect(r.ok, "a store that never answered was treated as an answer").toBe(false);
    expect(String(r.error ?? "")).toMatch(/store/i);
  });
});

describe("R5.3 — the closed set is complete", () => {
  for (const status of ["completed", "cancelled"]) {
    it(`R5.3 a store answering \`${status}\` makes the resume a NEW gig carrying resumes (as failed/aborted do)`, async () => {
      const { d, oldId } = await failedGig(async () => status, false);
      const r = await resume(d, oldId);
      expect(r.ok, `precondition: the resume succeeds: ${JSON.stringify(r)}`).toBe(true);
      expect(idOf(r), `the store says \`${status}\` and the door reopened the closed gig under its old id`).not.toBe(oldId);
      const data = r.data as Record<string, unknown>;
      expect(data["resumes"] ?? (data["manifest"] as Record<string, unknown> | undefined)?.["resumes"]).toBe(oldId);
    });
  }
  for (const status of ["running", "queued", "awaiting_approval"]) {
    it(`R5.3 a store answering \`${status}\` is OPEN: the resume keeps the gig's own id, even with a checkpoint that says it ended`, async () => {
      const { d, oldId } = await failedGig(async () => status, true);
      const r = await resume(d, oldId);
      expect(r.ok, `precondition: the resume succeeds: ${JSON.stringify(r)}`).toBe(true);
      expect(idOf(r), `the store says \`${status}\` (open), but the resume minted a new gig`).toBe(oldId);
    });
  }
});

describe("R5.4 — rpcGigStatus is the reader, and its answer reaches the decision", () => {
  it("R5.4 the real rpcGigStatus against a fake coltrane_mcp_gig_status: `failed` (row or one-row array) → a new gig; `awaiting_approval` → the old id; the bearer and gig ride the body", async () => {
    const ctx = { baseUrl: "https://store.example", anonKey: "anon-key", agentToken: "ctk_status_reader" };
    let answer: unknown = null;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/rest/v1/rpc/coltrane_mcp_gig_status") {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      return new Response("null", { status: 201 });
    }));

    const cases: Array<{ answer: (id: string) => unknown; closed: boolean; label: string }> = [
      { label: "a header row saying failed", closed: true, answer: (id) => ({ id, status: "failed", genome_hash: "a".repeat(64) }) },
      { label: "a one-row array saying failed", closed: true, answer: (id) => [{ id, status: "failed" }] },
      { label: "a header row saying awaiting_approval", closed: false, answer: (id) => ({ id, status: "awaiting_approval" }) },
    ];
    for (const c of cases) {
      const { d, oldId } = await failedGig(rpcGigStatus(ctx), !c.closed);
      answer = c.answer(oldId);
      const r = await resume(d, oldId);
      expect(r.ok, `precondition (${c.label}): the resume succeeds: ${JSON.stringify(r)}`).toBe(true);
      if (c.closed) {
        expect(idOf(r), `the store answered ${c.label} through rpcGigStatus and the door did not treat it as closed`).not.toBe(oldId);
      } else {
        expect(idOf(r), `the store answered ${c.label} through rpcGigStatus and the door treated it as closed`).toBe(oldId);
      }
      expect(bodies.at(-1), "rpcGigStatus must ask about THIS gig with the agent's bearer").toEqual({ p_bearer: "ctk_status_reader", p_gig: oldId });
    }
  });
});
