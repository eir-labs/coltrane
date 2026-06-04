// U8 — phantom standard reference at runtime.
//
// Question: if gig_dispatch targets a standard whose file is DELETED between
// dispatches, does coltrane (a) hold a snapshot in-memory and run the gig anyway,
// (b) reject the dispatch with a typed error, or (c) hang/crash silently?
//
// Two probes:
//   1) PRE-DELETE: bootstrap → delete file → re-bootstrap → dispatch. Expect typed error.
//   2) MID-RUN:    bootstrap → dispatch starts → delete file mid-run. Document behavior.
//
// Deterministic invoker (no real claude) — this is a runtime test, not an LLM test.
// Test = receipt: the assertions print the exact failure mode coltrane exhibits.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, bootstrapServerDeps, type ServerDeps, type AgentInvoker } from "../../src/index.js";

describe("U8 — phantom standard reference (file deleted between dispatches)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;
  const receipt: { pre_delete_error: string; mid_run_behavior: string } = {
    pre_delete_error: "<unrun>",
    mid_run_behavior: "<unrun>",
  };

  const detInvoke: AgentInvoker = (ctx) => {
    if (ctx.agent.slug === "u8-sensor") return { signal_bytes: "0xDEAD", source: "u8://probe" };
    if (ctx.agent.slug === "u8-interp") return { verdict: "u8-ok", notes: ["seen"] };
    throw new Error(`unexpected slug: ${ctx.agent.slug}`);
  };

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);
    deps.invoke = detInvoke;
    // register the two domain types + two agents + compose `phantom-test`
    await dispatchTool("type_register", { slug: "u8-sig", extends: "Signal", domain: "u8",
      schema: { type: "object", properties: { signal_bytes: { type: "string" }, source: { type: "string" } } },
      required_fields: ["signal_bytes", "source"] }, deps);
    await dispatchTool("type_register", { slug: "u8-interp-t", extends: "Interpretation", domain: "u8",
      schema: { type: "object", properties: { verdict: { type: "string" }, notes: { type: "array", items: { type: "string" } } } },
      required_fields: ["verdict", "notes"] }, deps);
    await dispatchTool("agent_define", { slug: "u8-sensor", primitives: ["SENSE"], output_types: ["u8-sig"], domain: "u8" }, deps);
    await dispatchTool("agent_define", { slug: "u8-interp", primitives: ["INTERPRET"], input_types: ["u8-sig"], output_types: ["u8-interp-t"], domain: "u8" }, deps);
    const compose = await dispatchTool("standard_compose", {
      slug: "phantom-test", domain: "u8",
      agents: [
        { slug: "u8-sensor", primitives: ["SENSE"], input_types: [], output_types: ["u8-sig"], domain: "u8" },
        { slug: "u8-interp", primitives: ["INTERPRET"], input_types: ["u8-sig"], output_types: ["u8-interp-t"], domain: "u8" },
      ],
      phases: [{ name: "sense", agent: "u8-sensor" }, { name: "interpret", agent: "u8-interp" }],
    }, deps);
    expect(compose.ok, `standard_compose failed: ${compose.error}`).toBe(true);
    expect(existsSync(join(env.tempDir, "standards", "phantom-test.json"))).toBe(true);
  }, 300_000);

  afterAll(() => {
    console.log(`─── phantom_standard receipt ─── pre_delete_error=${receipt.pre_delete_error} mid_run_behavior=${receipt.mid_run_behavior}`);
    env?.cleanup();
  });

  it("probe 1 PRE-DELETE — file removed + re-bootstrap → gig_dispatch returns typed error", async () => {
    // Delete the standard file from disk, then re-bootstrap (simulating a fresh
    // server boot after governance retirement). The standards Map should no longer
    // contain `phantom-test`. gig_dispatch must reject with a typed error.
    rmSync(join(env.tempDir, "standards", "phantom-test.json"), { force: true });
    expect(existsSync(join(env.tempDir, "standards", "phantom-test.json"))).toBe(false);
    const fresh = bootstrapServerDeps(env.tempDir);
    fresh.invoke = detInvoke;
    expect(fresh.standards?.get("phantom-test"), "standards Map still holds deleted standard").toBeUndefined();
    const res = await dispatchTool("gig_dispatch", { standard_slug: "phantom-test", input: { topic: "u8" } }, fresh);
    expect(res.ok, "gig_dispatch should reject phantom standard").toBe(false);
    expect(String(res.error)).toMatch(/unknown standard|phantom-test/i);
    receipt.pre_delete_error = String(res.error);
  });

  it("probe 2 MID-RUN — delete file AFTER bootstrap, BEFORE dispatch (same in-memory deps)", async () => {
    // Re-compose so we have a fresh file + in-memory snapshot on `deps`.
    await dispatchTool("standard_compose", {
      slug: "phantom-test", domain: "u8",
      agents: [
        { slug: "u8-sensor", primitives: ["SENSE"], input_types: [], output_types: ["u8-sig"], domain: "u8" },
        { slug: "u8-interp", primitives: ["INTERPRET"], input_types: ["u8-sig"], output_types: ["u8-interp-t"], domain: "u8" },
      ],
      phases: [{ name: "sense", agent: "u8-sensor" }, { name: "interpret", agent: "u8-interp" }],
    }, deps);
    // refresh in-memory standards Map (same path runStdioServer takes on boot)
    const refreshed = bootstrapServerDeps(env.tempDir);
    deps.standards = refreshed.standards;
    expect(deps.standards?.get("phantom-test")).toBeDefined();
    // DELETE the file but DO NOT re-bootstrap. The in-memory snapshot remains.
    rmSync(join(env.tempDir, "standards", "phantom-test.json"), { force: true });
    expect(existsSync(join(env.tempDir, "standards", "phantom-test.json"))).toBe(false);
    const res = await dispatchTool("gig_dispatch", { standard_slug: "phantom-test", input: { topic: "u8" } }, deps);
    // The finding: coltrane uses the in-memory Map (snapshot at boot/compose),
    // not a re-read from disk. So mid-run delete is invisible — the gig completes
    // using the snapshot. Honest documentation: the implementation choice IS the answer.
    if (res.ok) {
      receipt.mid_run_behavior = "snapshot-at-bootstrap: gig completes using in-memory standard (file delete invisible mid-run)";
    } else {
      receipt.mid_run_behavior = `rejected after file delete: ${res.error}`;
    }
    // Either outcome is acceptable as long as it's NOT a hang or silent corruption.
    // What we forbid: gig_dispatch returning ok:true but with zero outputs / undefined state.
    if (res.ok) {
      const data = res.data as { gig_id: string; manifest: { output_count: number } };
      expect(data.gig_id).toBeTruthy();
      expect(data.manifest.output_count).toBe(2);
    } else {
      expect(String(res.error)).toMatch(/unknown standard|phantom-test|not found/i);
    }
  });
});
