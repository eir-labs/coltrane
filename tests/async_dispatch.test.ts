// Async gig_dispatch + live monitoring — "synchronous dispatch is not a good pattern."
//
// gig_dispatch returns a gig_id immediately and runs the gig in the background; gig_monitor
// reads live state (phase, per-chair status, tool calls, outputs) as it progresses. wait:true
// keeps the synchronous manifest path for deterministic callers. Agent-layer events emitted by
// the invoker (ctx.onEvent) surface through the monitor's per-chair tool_calls.
import { describe, it, expect } from "vitest";
import {
  createRegistry, createOutputStore, MemoryLedger, composeStandard,
  type AgentInvoker, type DomainType, type PhaseDef, type Chair, type Standard,
} from "../src/index.js";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { testAgent } from "./_support/agents.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(invoke: AgentInvoker, standard: Standard, gig_log_base?: string): ServerDeps {
  const registry = createRegistry();
  const note: DomainType = { slug: "note", extends: "Signal", domain: "demo", schema: { properties: { t: { type: "string" } } }, required_fields: ["t"] };
  registry.registerType(note);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: new Map([[standard.slug, standard]]),
    invoke,
    gig_runs: new Map(),
    ...(gig_log_base ? { gig_log_base } : {}),
  };
}

const chair: Chair = { role: "s", agent_slug: "solo", depends_on: [], input_contract: [], output_contract: ["note"], required_skills: [] };
const standard = (): Standard => composeStandard({
  slug: "async-demo", domain: "demo",
  agents: [testAgent({ slug: "solo", primitives: ["SENSE"], input_types: [], output_types: ["note"], domain: "demo" })],
  phases: [{ name: "sense", chairs: [chair] } as PhaseDef],
});

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

describe("async gig_dispatch + live monitor", () => {
  it("wait:true returns the manifest synchronously (the opt-in sync path)", async () => {
    const d = deps(() => ({ t: "hi", source: "fixture://demo/note" }), standard());
    const r = await dispatchTool("gig_dispatch", { standard_slug: "async-demo", input: {}, wait: true }, d);
    expect(r.ok).toBe(true);
    const data = r.data as { gig_id: string; manifest: { output_count: number; run_fingerprint: string } };
    expect(data.gig_id).toBeTruthy();
    expect(data.manifest.output_count).toBe(1);
    expect(data.manifest.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("async (default) returns a gig_id + running immediately, then monitor shows completion", async () => {
    const d = deps(() => ({ t: "hi", source: "fixture://demo/note" }), standard());
    const r = await dispatchTool("gig_dispatch", { standard_slug: "async-demo", input: {} }, d);
    const data = r.data as { gig_id: string; status: string; manifest?: unknown };
    expect(data.status).toBe("running");
    expect(data.gig_id).toBeTruthy();
    expect(data.manifest, "async dispatch must NOT block for the manifest").toBeUndefined();

    const done = await pollDone(d, data.gig_id);
    expect(done["status"]).toBe("complete");
    expect(done["outputs_count"]).toBe(1);
    const chairs = done["chairs"] as Array<{ role: string; status: string; output_types?: string[] }>;
    expect(chairs.find((c) => c.role === "s")?.status).toBe("complete");
    expect(chairs.find((c) => c.role === "s")?.output_types).toEqual(["note"]);
  });

  it("a chair's agent-layer events surface in the monitor's per-chair tool_calls", async () => {
    const invoke: AgentInvoker = (ctx) => {
      ctx.onEvent?.({ type: "tool_use", tool: "WebSearch" });
      ctx.onEvent?.({ type: "tool_use", tool: "WebFetch" });
      return { t: "searched", source: "fixture://demo/note" };
    };
    const d = deps(invoke, standard());
    const r = await dispatchTool("gig_dispatch", { standard_slug: "async-demo", input: {} }, d);
    const gid = (r.data as { gig_id: string }).gig_id;
    const done = await pollDone(d, gid);
    const chairs = done["chairs"] as Array<{ role: string; tool_calls: string[] }>;
    expect(chairs.find((c) => c.role === "s")?.tool_calls).toEqual(["WebSearch", "WebFetch"]);
  });

  it("gig_logs serves the agent-layer transcript from MCP — no hand-reading the log files", async () => {
    const invoke: AgentInvoker = (ctx) => {
      ctx.onEvent?.({ type: "tool_use", tool: "WebSearch" });
      ctx.onEvent?.({ type: "assistant", text: "thinking about prior art" });
      ctx.onEvent?.({ type: "tool_use", tool: "WebFetch" });
      return { t: "searched", source: "fixture://demo/note" };
    };
    const base = mkdtempSync(join(tmpdir(), "coltrane-giglogs-"));
    const d = deps(invoke, standard(), base);
    const r = await dispatchTool("gig_dispatch", { standard_slug: "async-demo", input: {} }, d);
    const gid = (r.data as { gig_id: string }).gig_id;
    await pollDone(d, gid);

    // full transcript for the gig
    const all = await dispatchTool("gig_logs", { gig_id: gid }, d);
    const ad = all.data as { roles: string[]; count: number; events: Array<{ role: string; type: string; tool?: string }> };
    expect(ad.roles).toEqual(["s"]);
    expect(ad.count).toBe(3);
    expect(ad.events.map((e) => e.type)).toEqual(["tool_use", "assistant", "tool_use"]);

    // filter to just the tool calls
    const tools = await dispatchTool("gig_logs", { gig_id: gid, type: "tool_use" }, d);
    const td = tools.data as { events: Array<{ tool?: string }> };
    expect(td.events.map((e) => e.tool)).toEqual(["WebSearch", "WebFetch"]);
  });

  it("a failing chair surfaces status=failed + the error in the monitor (no silent hang)", async () => {
    const invoke: AgentInvoker = () => { throw new Error("boom in the chair"); };
    const d = deps(invoke, standard());
    const r = await dispatchTool("gig_dispatch", { standard_slug: "async-demo", input: {} }, d);
    const gid = (r.data as { gig_id: string }).gig_id;
    const done = await pollDone(d, gid);
    expect(done["status"]).toBe("failed");
    expect(String(done["error"])).toMatch(/boom in the chair/);
  });
});
