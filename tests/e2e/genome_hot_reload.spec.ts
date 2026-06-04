// T14 — genome hot-reload mid-session.
//
// Question: after `agent_define` + `standard_compose` add a new agent + standard,
// does the NEXT `gig_dispatch` on the SAME bootstrapped deps see them — without
// a manual re-bootstrap? Or is `deps.standards` a stale snapshot captured at
// bootstrap?
//
// Pre-reg: phase 1 (hot-1) proves the baseline path works; phase 2 (hot-2) is
// the probe. If hot-2 dispatch returns `unknown standard`, the in-memory genome
// is stale and downstream gigs need a manual refresh to see fresh definitions.
// The full_workflow spec already manually refreshes at step 8 — this test asks
// whether that refresh is LOAD-BEARING.
//
// Receipt is printed regardless of outcome: documenting actual behavior is the
// task, not enforcing one branch.
//
// Honesty: no it.skip, no swallowed errors. Failure of hot-2 without refresh is
// data, not a stop.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import { dispatchTool, bootstrapServerDeps, type ServerDeps, type AgentInvoker } from "../../src/index.js";

describe("T14 — genome hot-reload mid-session (does deps see freshly-defined agents/standards?)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;
  let autoReload = false;
  let manualRefreshRequired = false;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    deps = bootstrapServerDeps(env.tempDir);
    const detInvoke: AgentInvoker = (ctx) => {
      if (ctx.agent.slug === "hot-sensor-a") return { payload_a: "A", source_url: "hot://a", capture_ts: "2026-06-04T00:00:00Z" };
      if (ctx.agent.slug === "hot-sensor-b") return { reading_b: "B", measured_at: "2026-06-04T00:00:00Z", sample_id: "s-001" };
      throw new Error(`unexpected slug: ${ctx.agent.slug}`);
    };
    deps.invoke = detInvoke;
  }, 300_000);

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.log(`─── genome_hot_reload receipt ─── auto_reload=${autoReload} manual_refresh_required=${manualRefreshRequired}`);
    env?.cleanup();
  });

  async function defineTypeAgentStandard(
    suffix: string,
    agentSlug: string,
    schemaProps: Record<string, unknown>,
    required: string[],
  ): Promise<void> {
    const typeSlug = `hot-note-${suffix}`;
    const stdSlug = `hot-${suffix}`;
    const tr = await dispatchTool("type_register", {
      slug: typeSlug, extends: "Signal", domain: `hot-${suffix}`,
      schema: { type: "object", properties: schemaProps },
      required_fields: required,
    }, deps);
    expect(tr.ok, `type_register hot-note-${suffix}: ${tr.error}`).toBe(true);
    const ad = await dispatchTool("agent_define", { slug: agentSlug, primitives: ["SENSE"], output_types: [typeSlug], domain: `hot-${suffix}` }, deps);
    expect(ad.ok, `agent_define ${agentSlug}: ${ad.error}`).toBe(true);
    const sc = await dispatchTool("standard_compose", {
      slug: stdSlug, domain: `hot-${suffix}`,
      agents: [{ slug: agentSlug, primitives: ["SENSE"], input_types: [], output_types: [typeSlug], domain: `hot-${suffix}` }],
      phases: [{ name: "sense", agent: agentSlug }],
    }, deps);
    expect(sc.ok, `standard_compose ${stdSlug}: ${sc.error}`).toBe(true);
  }

  it("phase 1 — define hot-1 + dispatch (baseline: defines bootstrap correctly)", async () => {
    await defineTypeAgentStandard(
      "1", "hot-sensor-a",
      { payload_a: { type: "string" }, source_url: { type: "string" }, capture_ts: { type: "string" } },
      ["payload_a", "source_url", "capture_ts"],
    );
    // hot-1 was just composed — deps.standards may or may not contain it.
    // Match the workaround used in coltrane_full_workflow step 8 to establish baseline.
    const refreshed = bootstrapServerDeps(env.tempDir);
    deps.standards = refreshed.standards;
    const res = await dispatchTool("gig_dispatch", { standard_slug: "hot-1", input: {} }, deps);
    expect(res.ok, `hot-1 dispatch (with refresh): ${res.error}`).toBe(true);
    const data = res.data as { manifest: { output_count: number } };
    expect(data.manifest.output_count).toBe(1);
  });

  it("phase 2 — define hot-2 then dispatch WITHOUT re-bootstrap (the probe)", async () => {
    await defineTypeAgentStandard(
      "2", "hot-sensor-b",
      { reading_b: { type: "string" }, measured_at: { type: "string" }, sample_id: { type: "string" } },
      ["reading_b", "measured_at", "sample_id"],
    );
    // Deliberately DO NOT re-bootstrap. Probe whether deps.standards picked up hot-2.
    const probe = await dispatchTool("gig_dispatch", { standard_slug: "hot-2", input: {} }, deps);
    if (probe.ok) {
      autoReload = true;
      manualRefreshRequired = false;
      const data = probe.data as { manifest: { output_count: number } };
      expect(data.manifest.output_count).toBe(1);
    } else {
      autoReload = false;
      manualRefreshRequired = true;
      expect(String(probe.error)).toMatch(/unknown standard|hot-2/i);
      // Confirm baseline: with a manual refresh the same dispatch succeeds.
      const refreshed = bootstrapServerDeps(env.tempDir);
      deps.standards = refreshed.standards;
      const post = await dispatchTool("gig_dispatch", { standard_slug: "hot-2", input: {} }, deps);
      expect(post.ok, `hot-2 dispatch (post-refresh): ${post.error}`).toBe(true);
    }
  });
});
