// e2e — T1 formal: typed artifacts flow through the runtime, real claude at each phase.
//
// Subhuti's T1 (multi_phase_live_gig.spec.ts) proves claude→claude text round-trip
// via prompt-passing. This test proves the FORMAL claim: gig_dispatch runs the
// 'summarize' standard with makeClaudeInvoker as runtime invoker; phase 1's
// typed raw-note output is wired by composition to phase 2's input; phase 2's
// typed summary output validates against schema. No prompt-stitching at the
// test layer — the runtime owns the artifact passing.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, type ServerDeps } from "../../src/index.js";
import { makeClaudeInvoker } from "../../src/claude_invoker.js";

describe("T1-formal — typed artifacts flow through runtime, real claude at each phase", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    const { bootstrapServerDeps } = await import("../../src/index.js");
    const baseDeps = bootstrapServerDeps(env.tempDir);
    deps = {
      ...baseDeps,
      invoke: makeClaudeInvoker({ registry: baseDeps.registry }),
    };
  }, 60_000);
  afterAll(() => env?.cleanup());

  it("summarize standard: phase 1 produces typed raw-note, phase 2 consumes it via composition, produces typed summary", async () => {
    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { source: "the room is loud and full of people talking" } },
      deps,
    );
    expect(dispatch.ok).toBe(true);
    const dispatchData = dispatch.data as { gig_id: string; manifest: { output_count: number } };
    expect(dispatchData.gig_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatchData.manifest.output_count).toBe(2);

    const monitor = await dispatchTool("gig_monitor", { gig_id: dispatchData.gig_id }, deps);
    const monitorData = monitor.data as { status: string; phases_complete: number };
    expect(monitorData.status).toBe("complete");
    expect(monitorData.phases_complete).toBe(2);

    const query = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, deps);
    const outs = (query.data as { outputs: Array<{ id: string; domain_type: string; data: Record<string, unknown> }> }).outputs;
    expect(outs.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);

    const rawNote = outs.find((o) => o.domain_type === "raw-note")!;
    const summary = outs.find((o) => o.domain_type === "summary")!;

    // Phase 1: raw-note has the required schema field (real claude produced typed JSON).
    expect(typeof rawNote.data["text"]).toBe("string");
    expect((rawNote.data["text"] as string).length).toBeGreaterThan(0);

    // Phase 2: summary has the required schema field.
    expect(typeof summary.data["gist"]).toBe("string");
    expect((summary.data["gist"] as string).length).toBeGreaterThan(0);

    // FORMAL artifact-passing assertion: phase 2's output derives from phase 1's output.
    // This is what makes it integration-of-the-runtime, not text-stitching at the test layer.
    const trace = await dispatchTool("output_trace", { output_id: summary.id }, deps);
    const traceNodes = (trace.data as { graph: { nodes: Array<{ id: string }> } }).graph.nodes;
    expect(traceNodes.map((n) => n.id)).toContain(rawNote.id);
  }, 300_000);
});
