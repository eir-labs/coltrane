// RED — the abort lifecycle. #249 / #250 / #251 (+ the #253 gig_runs-retention note).
//
//   #249 — gig_abort cancels nothing and returns aborted:true. Demonstrated upstream: a gig
//          ran to completion and sealed both outputs AFTER reporting it was aborted.
//   #250 — nothing holds a handle to any spawned child; RunDeps has no signal and runGig has
//          no cancellation checkpoints, so even a perfect signal would land nowhere.
//   #251 — the status guess is wrong in both directions (first-phase gig => not_found;
//          post-restart historical gig => running/aborted:true forever), and there is no
//          "aborted" in the status vocabulary to express the outcome with.
//
// Levels under test here are 1 (between-phase / between-batch checkpoints) and 2 (the signal
// threaded through RunDeps -> AgentInvocationContext). Level 3 (the chair child actually being
// killed) is tests/chair_child_cancellation.test.ts, which spawns a real node fixture.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard, runGig,
  MCP_TOOLS,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { pruneGigRuns, newGigRun, type GigRunState } from "../src/gig_tracker.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";

// ── fixtures ────────────────────────────────────────────────────────────────
const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
const reading: DomainType = { slug: "reading", extends: "Interpretation", domain: "demo", schema: { properties: { v: { type: "string" } } }, required_fields: ["v"] };

// The substance every sealed output carries by virtue of its CORE type. `outputs.write`
// enforces one floor per core on every seal — bare core or domain subtype (#227 ruling) — so
// a payload that omits it aborts the CHAIR, and an abort test can no longer tell a real
// cancellation from a chair that died of its own fixture.
const SIGNAL = { source: "fixture://demo/sensor" };
const CLAIMS = { claims: ["the note was read"] };

const chairA: Chair = { role: "a", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
const chairB: Chair = { role: "b", agent_slug: "reader", depends_on: ["a"], input_contract: ["note"], output_contract: ["reading"], required_skills: [] };

/** Two sequential phases — phase 2 exists solely so a between-phase checkpoint has somewhere to land. */
const twoPhase = (): Standard => composeStandard({
  slug: "abort-demo", domain: "demo",
  agents: [
    testAgent({ slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" }),
    testAgent({ slug: "reader", primitives: ["INTERPRET"], input_types: ["note"], output_types: ["reading"], domain: "demo" }),
  ],
  phases: [{ name: "sense", chairs: [chairA] } as PhaseDef, { name: "interpret", chairs: [chairB] } as PhaseDef],
});

function deps(invoke: AgentInvoker, standard: Standard): ServerDeps {
  const registry = createRegistry();
  registry.registerType(note);
  registry.registerType(reading);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[standard.slug, standard]]),
    invoke,
    gig_runs: new Map(),
  };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((res) => { open = res; });
  return { promise, open };
}

async function pollSettled(d: ServerDeps, gid: string, ms = 4000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    const r = await dispatchTool("gig_monitor", { gig_id: gid }, d);
    const data = r.data as Record<string, unknown>;
    if (data["status"] !== "running") return data;
    if (Date.now() - t0 > ms) throw new Error(`gig ${gid} never settled: ${JSON.stringify(data)}`);
    await new Promise((res) => setTimeout(res, 5));
  }
}

// ── #249 — the abort must actually abort ────────────────────────────────────
describe("#249 — gig_abort cancels the run instead of narrating one", () => {
  it("a gig aborted mid-flight does NOT run its next phase", async () => {
    const started = gate();
    const released = gate();
    let bRan = false;
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "sensor") {
        started.open();
        await released.promise;
        return { t: "hi", ...SIGNAL };
      }
      bRan = true;
      return { v: "read", ...CLAIMS };
    };
    const d = deps(invoke, twoPhase());
    const disp = await dispatchTool("gig_dispatch", { standard_slug: "abort-demo", input: {} }, d);
    const gid = (disp.data as { gig_id: string }).gig_id;

    await started.promise;                       // phase 1's chair is genuinely in flight
    const ab = await dispatchTool("gig_abort", { gig_id: gid, reason: "over budget" }, d);
    released.open();                             // let the in-flight chair finish

    const settled = await pollSettled(d, gid);
    expect(
      (ab.data as { aborted: boolean }).aborted,
      "gig_abort must only claim `aborted` when it actually delivered a cancellation",
    ).toBe(true);
    expect(
      bRan,
      "phase 2 ran after the abort was accepted — runGig has no between-phase cancellation " +
        "checkpoint (#250), so the gig burns its full remaining budget after gig_abort returns.",
    ).toBe(false);
    expect(settled["status"], "an aborted gig must settle as aborted, not complete").toBe("aborted");
  });

  it("an aborted gig seals no ledger gig row (it did not complete)", async () => {
    const started = gate();
    const released = gate();
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "sensor") { started.open(); await released.promise; return { t: "hi", ...SIGNAL }; }
      return { v: "read", ...CLAIMS };
    };
    const d = deps(invoke, twoPhase());
    const disp = await dispatchTool("gig_dispatch", { standard_slug: "abort-demo", input: {} }, d);
    const gid = (disp.data as { gig_id: string }).gig_id;
    await started.promise;
    await dispatchTool("gig_abort", { gig_id: gid, reason: "stop" }, d);
    released.open();
    await pollSettled(d, gid);

    expect(d.ledger.query({ kind: "gig", gig_id: gid } as never).length,
      "a cancelled run must not seal a completed-run row").toBe(0);
  });

  it("the abort path still records the spend already accrued (killing must not un-record cost)", async () => {
    const started = gate();
    const released = gate();
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "sensor") {
        ctx.onEvent?.({ type: "result", raw: { usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.42 } });
        started.open();
        await released.promise;
        return { t: "hi", ...SIGNAL };
      }
      return { v: "read", ...CLAIMS };
    };
    const d = deps(invoke, twoPhase());
    const disp = await dispatchTool("gig_dispatch", { standard_slug: "abort-demo", input: {} }, d);
    const gid = (disp.data as { gig_id: string }).gig_id;
    await started.promise;
    await dispatchTool("gig_abort", { gig_id: gid, reason: "stop" }, d);
    released.open();
    const settled = await pollSettled(d, gid);

    const usage = settled["usage"] as { total_cost_usd?: number } | undefined;
    expect(usage, "an abort that drops accrued usage converts a RECORDED cost into an unrecorded one").toBeDefined();
    expect(usage!.total_cost_usd).toBeCloseTo(0.42, 6);
  });
});

// ── #250 — the cancellation primitive exists and lands ──────────────────────
describe("#250 — a cancellation signal exists, reaches runGig, and reaches the invocation", () => {
  it("runGig rejects immediately on an already-aborted signal and invokes no chair", async () => {
    const registry = createRegistry();
    registry.registerType(note);
    registry.registerType(reading);
    const outputs = createOutputStore(registry);
    const ledger = new MemoryLedger();
    let invocations = 0;
    const ac = new AbortController();
    ac.abort("pre-cancelled");

    await expect(
      runGig(twoPhase(), {}, {
        outputs, ledger,
        invoke: () => { invocations++; return { t: "hi", ...SIGNAL }; },
        signal: ac.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(invocations, "runGig has no cancellation checkpoint before the first dispatch batch").toBe(0);
  });

  it("the signal is threaded into AgentInvocationContext so an invoker can wire it to its child", async () => {
    const registry = createRegistry();
    registry.registerType(note);
    registry.registerType(reading);
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    await runGig(twoPhase(), {}, {
      outputs: createOutputStore(registry), ledger: new MemoryLedger(),
      invoke: (ctx) => { seen ??= ctx.signal; return ctx.agent.slug === "sensor" ? { t: "hi", ...SIGNAL } : { v: "read", ...CLAIMS }; },
      signal: ac.signal,
    });
    expect(seen, "AgentInvocationContext carries no signal — the chair -> child link has nowhere to attach").toBe(ac.signal);
  });
});

// ── #251 — the status guess ─────────────────────────────────────────────────
describe("#251 — gig_abort reports the truth in both directions", () => {
  it("a gig in its FIRST phase is not reported not_found (the abort-worthy window)", async () => {
    const started = gate();
    const released = gate();
    const invoke: AgentInvoker = async (ctx) => {
      if (ctx.agent.slug === "sensor") { started.open(); await released.promise; return { t: "hi", ...SIGNAL }; }
      return { v: "read", ...CLAIMS };
    };
    const d = deps(invoke, twoPhase());
    const disp = await dispatchTool("gig_dispatch", { standard_slug: "abort-demo", input: {} }, d);
    const gid = (disp.data as { gig_id: string }).gig_id;
    await started.promise; // in flight, nothing sealed yet

    const ab = await dispatchTool("gig_abort", { gig_id: gid, reason: "hung scout" }, d);
    const mon = await dispatchTool("gig_monitor", { gig_id: gid }, d);
    released.open();
    await pollSettled(d, gid);

    const abStatus = (ab.data as { status: string }).status;
    expect(
      abStatus,
      "nothing is sealed in phase 1, so the ledger/output guess says not_found — for a gig " +
        "that is running with a live child. Two tools in the same process disagree about the " +
        "same gig_id in the same millisecond.",
    ).not.toBe("not_found");
    expect((mon.data as { status: string }).status, "sanity: the monitor sees it running").toBe("running");
  });

  it("a gig with no live run is NOT claimed as aborted (the post-restart false positive)", async () => {
    // Outputs on disk, no ledger row, no live run entry — exactly the post-restart shape.
    const registry = createRegistry();
    registry.registerType(note);
    const d: ServerDeps = { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), gig_runs: new Map() };
    await dispatchTool("output_write", {
      core_type: "Signal", domain_type: "note", domain: "demo", gig_id: "old-gig", agent_slug: "sensor", data: { t: "x", ...SIGNAL },
    }, d);

    const r = await dispatchTool("gig_abort", { gig_id: "old-gig", reason: "cleanup" }, d);
    expect(
      (r.data as { aborted: boolean }).aborted,
      "there is no live run for this gig in this process — nothing was cancelled, so the tool " +
        "must not claim it was. Post-restart this reported aborted:true forever, for gigs that " +
        "finished days ago.",
    ).toBe(false);
  });

  it('"aborted" is expressible: the status union and the progress fold carry it', async () => {
    const state: GigRunState = newGigRun("g", "s", 1, new Date().toISOString());
    state.status = "aborted"; // must type-check AND be a real member of the union
    expect(state.status).toBe("aborted");
  });

  it("the advertised gig_abort output schema declares the field its callers read", () => {
    const tool = MCP_TOOLS.find((t) => t.slug === "gig_abort")!;
    const props = (tool.output_schema as { properties: Record<string, unknown> }).properties;
    expect(
      Object.keys(props),
      "src/mcp.ts declares {aborted, cleanup_result} — omitting `status`, the field both " +
        "existing tests actually assert.",
    ).toContain("status");
  });
});

// ── #253 (related) — gig_runs is never pruned ───────────────────────────────
describe("#253 (related) — gig_runs retention is bounded", () => {
  it("pruneGigRuns drops the oldest SETTLED runs past the cap and keeps every live one", () => {
    const runs = new Map<string, GigRunState>();
    for (let i = 0; i < 10; i++) {
      const s = newGigRun(`g${i}`, "std", 1, new Date(2026, 0, 1, 0, 0, i).toISOString());
      s.status = i === 0 ? "running" : "complete";
      runs.set(s.gig_id, s);
    }
    pruneGigRuns(runs, 4);
    expect(runs.size).toBeLessThanOrEqual(4 + 1); // cap + the still-running one
    expect(runs.has("g0"), "a RUNNING gig must never be pruned — that is the live handle").toBe(true);
    expect(runs.has("g9"), "the newest settled run is the one an operator is most likely to ask about").toBe(true);
    expect(runs.has("g1"), "the oldest settled run should have been dropped").toBe(false);
  });
});
