// The MCP surface for checkpoint/resume + output reuse.
//
// An undiscoverable feature is #234 repeated, so these tests pin three things: that the two
// opt-ins are ADVERTISED on `gig_dispatch`, that the handler actually reads them (rather than
// accepting and discarding them, which is #237's defect), and that a run which skipped work
// SAYS SO on every reply surface — including the async one, where the manifest never reaches
// the caller and `gig_monitor` is the only place a saving can be reported.

import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, MCP_TOOLS,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { runGig, ResumeRefused } from "../src/runtime.js";
import { createMemoryCheckpointStore, createMemoryReuseStore, type CheckpointStore, type ReuseStore } from "../src/reuse.js";
import { testAgent } from "./_support/agents.js";

const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const verdictT: DomainType = { slug: "call", extends: "Verdict", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

const NOTE = { t: "hi", source: "fixture://demo/note" };
const CALL = { v: "go", checks: [{ method: "the fixture ran one check", result: "pass" }] };

const chairs: Chair[] = [
  { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] },
  { role: "g", agent_slug: "gate", depends_on: ["s"], input_contract: ["note"], output_contract: ["call"], required_skills: [] },
];
const standard = (): Standard => composeStandard({
  slug: "resume-demo", domain: "demo",
  agents: [
    testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "gate", primitives: ["VERIFY"], input_types: ["note"], output_types: ["call"], domain: "demo" }),
  ],
  phases: [
    { name: "sense", chairs: [chairs[0]!] } as PhaseDef,
    { name: "verify", chairs: [chairs[1]!] } as PhaseDef,
  ],
});

function deps(invoke: AgentInvoker, extra?: Partial<ServerDeps>): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(verdictT);
  const std = standard();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[std.slug, std]]),
    invoke,
    gig_runs: new Map(),
    ...extra,
  };
}

/** Counts invocations; optionally fails the gate chair the first N times. */
function counting(failGate = 0): { invoke: AgentInvoker; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  let left = failGate;
  const invoke: AgentInvoker = (ctx) => {
    calls[ctx.agent.slug] = (calls[ctx.agent.slug] ?? 0) + 1;
    if (ctx.agent.slug === "gate" && left > 0) { left--; throw new Error("stub gate failure"); }
    return ctx.agent.slug === "solo" ? { ...NOTE } : { ...CALL };
  };
  return { invoke, calls };
}

async function pollDone(d: ServerDeps, gid: string, ms = 3000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await dispatchTool("gig_monitor", { gig_id: gid }, d);
    const data = r.data as Record<string, unknown>;
    if (data["status"] !== "running") return data;
    if (Date.now() - t0 > ms) throw new Error(`gig ${gid} never left running: ${JSON.stringify(data)}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

describe("gig_dispatch advertises what it can actually do", () => {
  const def = MCP_TOOLS.find((t) => t.slug === "gig_dispatch")!;
  const props = (s: object): Record<string, unknown> => (s as { properties: Record<string, unknown> }).properties;

  it("names resume_gig_id and reuse on its input schema", () => {
    expect(Object.keys(props(def.input_schema))).toEqual(expect.arrayContaining(["resume_gig_id", "reuse"]));
  });

  it("names the fields that report a refusal, so a caller can handle one", () => {
    expect(Object.keys(props(def.output_schema))).toEqual(expect.arrayContaining(["resume_refused", "drift"]));
  });

  it("gig_monitor advertises the async path's saving report", () => {
    const mon = MCP_TOOLS.find((t) => t.slug === "gig_monitor")!;
    expect(Object.keys(props(mon.output_schema))).toEqual(expect.arrayContaining(["skipped_chairs", "resumed_from", "reuse_rejected"]));
  });
});

describe("gig_dispatch — resume", () => {
  it("resumes a failed run through the tool surface, re-invoking only what failed", async () => {
    const checkpoints: CheckpointStore = createMemoryCheckpointStore();
    const first = counting(1);
    const d = deps(first.invoke, { checkpoints });

    const r1 = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true }, d);
    expect(r1.ok, "attempt 1 must fail at the gate").toBe(false);
    expect(first.calls).toEqual({ solo: 1, gate: 1 });
    // The failed run's gig_id comes off the outputs the completed chair sealed.
    const gid = d.outputs.all()[0]!.gig_id;

    const second = counting();
    d.invoke = second.invoke;
    const r2 = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, resume_gig_id: gid }, d);
    expect(r2.ok).toBe(true);
    expect(second.calls, "the sense phase was already sealed").toEqual({ gate: 1 });

    const manifest = (r2.data as { manifest: Record<string, unknown> }).manifest;
    expect((manifest["resumed_from"] as { from_gig_id: string }).from_gig_id).toBe(gid);
    expect((manifest["skipped"] as Array<{ role: string; reason: string }>).map((s) => [s.role, s.reason])).toEqual([["s", "resume"]]);
  });

  it("a human-only resume driven through the gig_dispatch surface succeeds WITHOUT --input", async () => {
    // THE THREAD GUARD (#20). The runtime-level laws in phase_resume_and_reuse set
    // gig_input_omitted directly on RunDeps and so stay green even if the cli.ts -> server.ts ->
    // RunDeps thread is broken. This is the only test that fails if that thread is cut: it drives
    // an approve-only resume through the real dispatch surface and asserts the omitted --input
    // inherits the checkpoint's gig_input_sha instead of drifting to sha256('{}') and refusing.
    const registry = createRegistry();
    registry.registerType(note);
    registry.registerType(verdictT);
    // solo (a model chair) seals a note, then a HUMAN chair holds the gig — so after attempt 1
    // parks, every remaining chair is human.
    const approveStd = composeStandard({
      slug: "approve-demo", domain: "demo",
      agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
      phases: [
        { name: "sense", chairs: [{ role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] }] } as PhaseDef,
        { name: "approve", chairs: [{ role: "a", human: true, agent_slug: "", depends_on: ["s"], input_contract: [], output_contract: ["call"], required_skills: [] }] } as PhaseDef,
      ],
    });
    const first = counting();
    const d: ServerDeps = {
      registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(),
      standards: new Map([[approveStd.slug, approveStd]]), invoke: first.invoke,
      gig_runs: new Map(), checkpoints: createMemoryCheckpointStore(),
    };

    // Attempt 1 — dispatched WITH a payload; the model chair seals, the gig parks at the human chair.
    const r1 = await dispatchTool("gig_dispatch", { standard_slug: "approve-demo", input: { seed: "orig" }, wait: true }, d);
    expect(r1.ok).toBe(true);
    expect((r1.data as { status: string }).status).toBe("awaiting_approval");
    const gid = d.outputs.all()[0]!.gig_id;

    // Attempt 2 — resume WITHOUT --input. The CLI would set gig_input_omitted; here we pass it on
    // the tool call, exactly as cli.ts does. The omitted payload must inherit the checkpoint's
    // gig_input_sha, not refuse.
    const second = counting();
    d.invoke = second.invoke;
    const r2 = await dispatchTool("gig_dispatch", { standard_slug: "approve-demo", input: {}, gig_input_omitted: true, wait: true, resume_gig_id: gid }, d);
    expect(r2.ok, "an omitted --input on a human-only resume must not refuse").toBe(true);
    expect((r2.data as { status: string }).status).toBe("awaiting_approval");
    expect(second.calls, "the sealed model chair is restored, not replayed").toEqual({});
  });

  it("a refused resume comes back as a refusal with the drift, not as a silent cold run", async () => {
    const checkpoints = createMemoryCheckpointStore();
    const first = counting(1);
    const d = deps(first.invoke, { checkpoints });
    await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true }, d);
    const gid = d.outputs.all()[0]!.gig_id;

    const second = counting();
    d.invoke = second.invoke;
    // A different payload — same pipeline, different run.
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: { seed: "moved" }, wait: true, resume_gig_id: gid }, d);
    expect(r.ok).toBe(false);
    expect((r.data as { resume_refused: boolean }).resume_refused).toBe(true);
    expect((r.data as { drift: string[] }).drift.join(" ")).toMatch(/gig_input_sha/);
    expect(second.calls, "a refused resume spends nothing").toEqual({});
  });

  it("the ASYNC path answers a refusal in the dispatch reply, not later by polling", async () => {
    // Load-bearing: without this the caller gets `status: "running"` for a gig that never
    // started, and only discovers the refusal if it happens to poll.
    const d = deps(counting().invoke, { checkpoints: createMemoryCheckpointStore() });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, resume_gig_id: "never-existed" }, d);
    expect(r.ok).toBe(false);
    expect((r.data as { resume_refused: boolean }).resume_refused).toBe(true);
    expect(d.gig_runs?.has("never-existed"), "a refused gig must not linger as a live run").toBe(false);
  });

  it("the resume gate rejects BEFORE the runtime's first await — the property the reply depends on", async () => {
    // "A refused resume spends nothing" and "the dispatch reply can carry the refusal" are the
    // same property: the gate runs in runGig's synchronous phase. Pinned here so a later edit
    // that moves an `await` above it fails loudly instead of silently degrading the surface.
    const registry = createRegistry();
    registry.registerType(note);
    const order: string[] = [];
    void runGig(standard(), {}, {
      outputs: createOutputStore(registry), ledger: new MemoryLedger(), invoke: counting().invoke,
      checkpoints: createMemoryCheckpointStore(), resume_from: "nope",
    }).catch((e: unknown) => order.push(e instanceof ResumeRefused ? "refused" : "other"));
    await Promise.resolve();
    expect(order).toEqual(["refused"]);
  });

  it("refuses to resume a gig that is still running", async () => {
    const d = deps(counting().invoke, { checkpoints: createMemoryCheckpointStore() });
    d.gig_runs!.set("live-one", { gig_id: "live-one", standard_slug: "resume-demo", status: "running", started_at: new Date().toISOString(), phases_total: 2, phases_seen: [], chairs: {}, outputs_count: 0 });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, resume_gig_id: "live-one" }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/still running/);
  });

  it("refuses resume_gig_id when no checkpoint store is wired", async () => {
    const d = deps(counting().invoke);
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, resume_gig_id: "x" }, d);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checkpoint store/);
  });
});

describe("gig_dispatch — reuse", () => {
  it("reuse:true serves a second identical dispatch without invoking anything", async () => {
    const reuse: ReuseStore = createMemoryReuseStore();
    const first = counting();
    const d1 = deps(first.invoke, { reuse });
    await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, reuse: true }, d1);
    expect(first.calls).toEqual({ solo: 1, gate: 1 });

    const second = counting();
    const d2 = deps(second.invoke, { reuse });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, reuse: true }, d2);
    expect(second.calls, "both chairs hash to entries the first run sealed").toEqual({});
    const manifest = (r.data as { manifest: Record<string, unknown> }).manifest;
    expect((manifest["reuse"] as { hits: Array<{ role: string }> }).hits.map((h) => h.role)).toEqual(["s", "g"]);
    expect((manifest["skipped"] as Array<{ reason: string }>).every((s) => s.reason === "reuse")).toBe(true);
  });

  it("without reuse:true the same dispatch runs cold — reuse never happens by surprise", async () => {
    const reuse = createMemoryReuseStore();
    const d1 = deps(counting().invoke, { reuse });
    await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, reuse: true }, d1);

    const second = counting();
    const d2 = deps(second.invoke, { reuse });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true }, d2);
    expect(second.calls).toEqual({ solo: 1, gate: 1 });
    expect((r.data as { manifest: Record<string, unknown> }).manifest["reuse"]).toBeUndefined();
  });

  it("refuses reuse:true when no reuse store is wired, rather than quietly ignoring it", async () => {
    const d = deps(counting().invoke);
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, reuse: true }, d);
    expect(r.ok, "#237's defect was accepting an argument and discarding it").toBe(false);
    expect(r.error).toMatch(/reuse store/);
  });

  it("the async path reports the saving through gig_monitor", async () => {
    const reuse = createMemoryReuseStore();
    const d1 = deps(counting().invoke, { reuse });
    await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, wait: true, reuse: true }, d1);

    const second = counting();
    const d2 = deps(second.invoke, { reuse });
    const r = await dispatchTool("gig_dispatch", { standard_slug: "resume-demo", input: {}, reuse: true }, d2);
    const gid = (r.data as { gig_id: string }).gig_id;
    expect((r.data as { reuse?: boolean }).reuse, "the reply echoes the opt-in it honoured").toBe(true);

    const done = await pollDone(d2, gid);
    expect(done["status"]).toBe("complete");
    const skips = done["skipped_chairs"] as Array<{ role: string; reason: string }>;
    expect(skips.map((s) => [s.role, s.reason])).toEqual([["s", "reuse"], ["g", "reuse"]]);
    // ...and the per-chair view says `skipped`, not `complete`.
    const chairStates = done["chairs"] as Array<{ role: string; status: string }>;
    expect(chairStates.every((c) => c.status === "skipped"), "a recall must not render as a fast derivation").toBe(true);
  });
});
