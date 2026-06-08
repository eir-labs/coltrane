// Phase 18 — full coltrane USAGE lifecycle, end to end.
//
// What this test answers: can a fresh dev, starting from a clean clone, actually
// USE coltrane to do what coltrane is FOR — define agents, define standards, run
// gigs, evolve agents, hit type-fails at the boundary? Or are there gaps in the
// workflow surface that block real use?
//
// The dispatcher path here (`dispatchTool` on a real ServerDeps bootstrapped from a
// tempdir genome) is the SAME surface MCP-over-stdio routes to (see
// `createColtraneServer` in src/server.ts: CallToolRequestSchema → dispatchTool).
// Driving it directly is a USAGE test, not a stub — the only thing this skips is
// the JSON-RPC framing, which the final `transport boot` test exercises live.
//
// Pre-reg apoha: NO `it.skip`, NO stubbed coltrane tools, NO `true === true`
// assertions. Every step verifies a coltrane-observable side effect — a file on
// disk, a ledger entry, a returned identity hash, a typed error from the boundary.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";
import {
  dispatchTool,
  bootstrapServerDeps,
  type ServerDeps,
  type AgentInvoker,
} from "../../src/index.js";

describe("phase 18 — full coltrane workflow (define → evolve → gig → type-fail → cleanup)", () => {
  let env: TempdirColtrane;
  let deps: ServerDeps;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // bootstrap deps from the TEMPDIR genome — this is the same path
    // `runStdioServer()` takes when COLTRANE_GENOME is set. The deps' invoke is a
    // real `makeClaudeInvoker`; we replace it below with a deterministic invoker
    // so gigs run offline + reproducibly (no ANTHROPIC_API_KEY required).
    deps = bootstrapServerDeps(env.tempDir);
    // deterministic invoker: keyed by agent slug + downstream domain_type. This is
    // NOT a coltrane stub — it stands in for the one non-deterministic seam (the LLM
    // call) per the same pattern used in examples/hello_band/run.ts.
    const detInvoke: AgentInvoker = (ctx) => {
      const slug = ctx.agent.slug;
      if (slug === "freshly-defined-sensor") {
        return { payload_bytes: "0xCAFEBABE", source_url: "phase18://probe/1", capture_ts: "2026-06-02T00:00:00Z" };
      }
      if (slug === "freshly-defined-summarizer") {
        return { decision: "phase18 verdict: aggregate ok", rationale_notes: ["upstream parsed", "no anomalies"] };
      }
      throw new Error(`unexpected agent slug in test invoker: ${slug}`);
    };
    deps.invoke = detInvoke;
  }, 300_000);

  afterAll(() => {
    // Step 8 (cleanup) — proves the tempdir lifecycle is hermetic
    env?.cleanup();
    // Belt-and-suspenders: confirm the tempdir is actually gone after cleanup.
    expect(existsSync(env.tempDir)).toBe(false);
  });

  it("step 1 — tempdir clones a real genome (core_types, domain_types, agents, standards all present)", () => {
    expect(existsSync(env.tempDir)).toBe(true);
    for (const sub of ["core_types", "domain_types", "agents", "standards", "src"]) {
      expect(existsSync(join(env.tempDir, sub)), `${sub} missing in tempdir`).toBe(true);
    }
    // bootstrap must have loaded the 6 immutable core types + the 2 seed domain types
    const types = deps.registry.listTypes();
    expect(types.length).toBeGreaterThanOrEqual(2);
    const slugs = types.map((t) => t.slug).sort();
    expect(slugs).toContain("raw-note");
    expect(slugs).toContain("summary");
    // genome_dir must be set so write-tools persist
    expect(deps.genome_dir).toBe(env.tempDir);
  });

  it("step 2 — register a NEW domain type at runtime (type_register persists + ledger-seals)", async () => {
    const ledgerBefore = deps.ledger.count();
    // The schema MUST be shape-distinct from the seed `raw-note` (Signal/demo/text)
    // — otherwise the §5 reuse-enforcement scores >=80 and blocks the register. This
    // is intentional coltrane behavior; the test honors it by using a distinct shape
    // (Signal/phase18/payload_bytes+source_url — different required_fields, different
    // domain). This drops the resolve score below 50 → action="create" → allowed.
    const res = await dispatchTool(
      "type_register",
      {
        slug: "phase18-note",
        extends: "Signal",
        domain: "phase18",
        schema: {
          type: "object",
          properties: {
            payload_bytes: { type: "string" },
            source_url: { type: "string" },
            capture_ts: { type: "string" },
          },
        },
        required_fields: ["payload_bytes", "source_url", "capture_ts"],
      },
      deps,
    );
    expect(res.ok, `type_register failed: ${res.error}`).toBe(true);
    const data = res.data as { content_hash: string; effective_hash: string; registered: boolean };
    // identity hashes returned (substrate-of-truth seal)
    expect(data.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    // file persisted under domain_types/<slug>.json
    const filePath = join(env.tempDir, "domain_types", "phase18-note.json");
    expect(existsSync(filePath), "type file not written").toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.slug).toBe("phase18-note");
    expect(onDisk.extends).toBe("Signal");
    // ledger sealed the identity (one new entry)
    expect(deps.ledger.count()).toBe(ledgerBefore + 1);
  });

  it("step 3 — define a NEW agent at runtime (agent_define persists + canonical identity returned)", async () => {
    const ledgerBefore = deps.ledger.count();
    const res = await dispatchTool(
      "agent_define",
      {
        slug: "freshly-defined-sensor",
        primitives: ["SENSE"],
        output_types: ["phase18-note"],
        domain: "phase18",
      },
      deps,
    );
    expect(res.ok, `agent_define failed: ${res.error}`).toBe(true);
    const data = res.data as { agent: { slug: string; primitives: string[] }; content_hash: string; effective_hash: string };
    expect(data.agent.slug).toBe("freshly-defined-sensor");
    expect(data.agent.primitives).toEqual(["SENSE"]);
    expect(data.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // file written under agents/<slug>.json
    const filePath = join(env.tempDir, "agents", "freshly-defined-sensor.json");
    expect(existsSync(filePath), "agent file not written").toBe(true);
    // ledger sealed
    expect(deps.ledger.count()).toBe(ledgerBefore + 1);

    // also define the downstream agent we'll need for the gig.
    // phase18-summary extends Interpretation; pick a distinct field set from
    // the seed `summary` type (which uses {gist}) to stay under the reuse threshold.
    const downRes = await dispatchTool(
      "type_register",
      {
        slug: "phase18-summary",
        extends: "Interpretation",
        domain: "phase18",
        schema: {
          type: "object",
          properties: {
            decision: { type: "string" },
            rationale_notes: { type: "array", items: { type: "string" } },
          },
        },
        required_fields: ["decision", "rationale_notes"],
      },
      deps,
    );
    expect(downRes.ok, `phase18-summary type_register failed: ${downRes.error}`).toBe(true);
    const downstream = await dispatchTool(
      "agent_define",
      {
        slug: "freshly-defined-summarizer",
        primitives: ["INTERPRET"],
        input_types: ["phase18-note"],
        output_types: ["phase18-summary"],
        domain: "phase18",
      },
      deps,
    );
    expect(downstream.ok).toBe(true);
  });

  it("step 4 — illegal pipeline (CREATE without upstream INTERPRET/PLAN) is REJECTED at standard composition (cross-phase §3)", async () => {
    // The §3 progression rule is now enforced CROSS-PHASE, not per-agent.
    // A standalone [CREATE] agent is admitted at defineAgent (it could be
    // satisfied by an upstream phase). The rejection happens when the agent
    // is composed into a standard with no upstream PLAN/INTERPRET phase.
    const defineRes = await dispatchTool(
      "agent_define",
      {
        slug: "bad-pipeline",
        primitives: ["CREATE"],
        output_types: ["phase18-summary"],
        domain: "phase18",
      },
      deps,
    );
    expect(defineRes.ok).toBe(true);

    // Compose into a standard with no upstream reasoning phase. The cross-phase
    // gate rejects.
    const composeRes = await dispatchTool(
      "standard_compose",
      {
        slug: "bad-standard",
        domain: "phase18",
        agents: [{ slug: "bad-pipeline", primitives: ["CREATE"], input_types: [], output_types: ["phase18-summary"], domain: "phase18" }],
        phases: [{ name: "make", chairs: [{ role: "make", agent_slug: "bad-pipeline", depends_on: [], input_contract: [], output_contract: ["phase18-summary"], required_skills: [] }] }],
      },
      deps,
    );
    expect(composeRes.ok).toBe(false);
    expect(String(composeRes.error)).toMatch(/CREATE.*upstream|INTERPRET|PLAN/i);
  });

  it("step 5 — compose a NEW standard referencing the new agents (standard_compose persists + seals)", async () => {
    const ledgerBefore = deps.ledger.count();
    const agents = [
      { slug: "freshly-defined-sensor", primitives: ["SENSE"], input_types: [], output_types: ["phase18-note"], domain: "phase18" },
      { slug: "freshly-defined-summarizer", primitives: ["INTERPRET"], input_types: ["phase18-note"], output_types: ["phase18-summary"], domain: "phase18" },
    ];
    const res = await dispatchTool(
      "standard_compose",
      {
        slug: "phase18-pipeline",
        domain: "phase18",
        agents,
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "freshly-defined-sensor", depends_on: [], input_contract: [], output_contract: ["phase18-note"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "freshly-defined-summarizer", depends_on: [], input_contract: [], output_contract: ["phase18-summary"], required_skills: [] }] },
        ],
      },
      deps,
    );
    expect(res.ok, `standard_compose failed: ${res.error}`).toBe(true);
    const data = res.data as { standard_id: string; content_hash: string; validation_result: { valid: boolean } };
    expect(data.standard_id).toBe("phase18-pipeline");
    expect(data.validation_result.valid).toBe(true);
    expect(data.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // standards/<slug>.json written
    expect(existsSync(join(env.tempDir, "standards", "phase18-pipeline.json"))).toBe(true);
    // ledger sealed
    expect(deps.ledger.count()).toBe(ledgerBefore + 1);
  });

  it("step 6 — invalid composition (phase references missing agent) is REJECTED at compose time", async () => {
    const res = await dispatchTool(
      "standard_compose",
      {
        slug: "phase18-broken",
        domain: "phase18",
        agents: [
          { slug: "freshly-defined-sensor", primitives: ["SENSE"], input_types: [], output_types: ["phase18-note"], domain: "phase18" },
        ],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "freshly-defined-sensor", depends_on: [], input_contract: [], output_contract: ["phase18-note"], required_skills: [] }] },
          { name: "phantom", chairs: [{ role: "phantom", agent_slug: "does-not-exist", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }, // illegal
        ],
      },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/does-not-exist|unknown agent/i);
    expect(existsSync(join(env.tempDir, "standards", "phase18-broken.json"))).toBe(false);
  });

  it("step 7 — re-bootstrap from disk picks up the FRESH agents + standards (proof: files persist across server boots)", () => {
    // The substrate-of-truth claim: a definition's identity is its file + ledger seal.
    // Boot a fresh ServerDeps over the same tempdir and verify the new entities load.
    const fresh = bootstrapServerDeps(env.tempDir);
    expect(fresh.standards?.get("phase18-pipeline"), "standard not reloaded").toBeDefined();
    expect(fresh.standards?.get("summarize"), "seed standard missing").toBeDefined();
    const freshTypes = fresh.registry.listTypes().map((t) => t.slug);
    expect(freshTypes).toContain("phase18-note");
    expect(freshTypes).toContain("phase18-summary");
  });

  let firstGigId: string | null = null;
  let firstGigOutputId: string | null = null;

  it("step 8 — run a gig through the new standard (gig_dispatch completes, ledger + outputs populated)", async () => {
    // The standards Map on deps was built at beforeAll and doesn't auto-include
    // phase18-pipeline. Refresh deps.standards by reloading the genome — this is
    // the exact path runStdioServer follows on boot.
    const refreshed = bootstrapServerDeps(env.tempDir);
    deps.standards = refreshed.standards;

    const outputsBefore = deps.outputs.all().length;
    const ledgerBefore = deps.ledger.count();
    const res = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "phase18-pipeline", input: { topic: "phase18-smoke" } },
      deps,
    );
    expect(res.ok, `gig_dispatch failed: ${res.error}`).toBe(true);
    const data = res.data as { gig_id: string; manifest: { genome_hash: string; run_fingerprint: string; output_count: number } };
    expect(data.gig_id).toBeTruthy();
    firstGigId = data.gig_id;
    expect(data.manifest.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(data.manifest.output_count).toBe(2); // two phases → two outputs
    // outputs landed
    const allOutputs = deps.outputs.all();
    expect(allOutputs.length).toBe(outputsBefore + 2);
    const gigOutputs = allOutputs.filter((o) => o.gig_id === firstGigId);
    expect(gigOutputs.map((o) => o.domain_type).sort()).toEqual(["phase18-note", "phase18-summary"]);
    // ledger recorded the gig
    expect(deps.ledger.count()).toBe(ledgerBefore + 1);
    const gigOutput = gigOutputs.find((o) => o.domain_type === "phase18-summary");
    expect(gigOutput, "downstream output missing").toBeDefined();
    firstGigOutputId = gigOutput!.id;
  });

  it("step 9 — gig_monitor sees the completed gig", async () => {
    expect(firstGigId).not.toBeNull();
    const res = await dispatchTool("gig_monitor", { gig_id: firstGigId }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { status: string; phases_complete: number };
    expect(data.status).toBe("complete");
    expect(data.phases_complete).toBe(2);
  });

  it("step 10 — output provenance: downstream output traces back to upstream (derived_from edge)", async () => {
    expect(firstGigOutputId).not.toBeNull();
    const res = await dispatchTool("output_trace", { output_id: firstGigOutputId }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { graph: { nodes: Array<{ id: string; domain_type: string }> }; root_signals: Array<{ id: string }> };
    // `trace()` walks BACKWARD from the node — returns the ancestor closure, not
    // the node itself (outputs.ts:176-189). So we expect to see ONLY the upstream
    // `phase18-note` Signal — that's the provenance link being asserted.
    const types = data.graph.nodes.map((n) => n.domain_type);
    expect(types).toContain("phase18-note");
    // the root signal in the ancestor set is the SENSE-typed output
    expect(data.root_signals.length).toBeGreaterThanOrEqual(1);
    expect(data.root_signals.some((n) => (n as unknown as { domain_type: string }).domain_type === "phase18-note")).toBe(true);
  });

  it("step 11 — type-fail at the boundary: output_write of a malformed payload is REJECTED", async () => {
    // phase18-summary requires {decision: string, rationale_notes: array}.
    // Missing `rationale_notes` must be rejected by the registry validator AT WRITE
    // (the T3 contract — "reject bad-schema output AT WRITE" in outputs.ts:110).
    const res = await dispatchTool(
      "output_write",
      {
        core_type: "Interpretation",
        domain_type: "phase18-summary",
        domain: "phase18",
        gig_id: firstGigId ?? "manual-gig",
        agent_slug: "freshly-defined-summarizer",
        phase: "interpret",
        data: { decision: "ok" }, // illegal: missing required `rationale_notes`
      },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/output rejected|required|rationale_notes|invalid/i);
  });

  it("step 12 — evolve an agent (agent_evolve, creative space → lineage chain reconstructs)", async () => {
    // Build a base AgentProfile (the agent_evolve tool takes the richer profile,
    // not the lean AgentDef — it's the §4 three-spaces classifier).
    const base = {
      slug: "scorer",
      version: 1,
      status: "active",
      parent_version: null,
      primitives: ["JUDGE"],
      input_types: ["phase18-summary"],
      output_types: ["phase18-summary"],
      domain: "phase18",
      identity: "v1 — terse judge",
      method: "score → score",
      constraints: ["one-shot"],
      depth_profile: "standard",
      permissions: {
        allowed_tools: [],
        disallowed_tools: [],
        model_tier: "standard",
        max_tool_calls: 5,
        max_token_budget: 1000,
        can_write_outputs: true,
        can_trigger_standards: false,
      },
    };
    const next = { ...base, version: 2, identity: "v2 — verbose judge with rationale", method: "score → rationale → score" };
    const res = await dispatchTool("agent_evolve", { base, next, new_version: 2 }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { space: string; evolved_profile: { version: number; parent_version: number; identity: string } | null };
    // creative space (identity + method changed, not permissions, not harmonic)
    expect(data.space).toBe("creative");
    expect(data.evolved_profile).not.toBeNull();
    expect(data.evolved_profile!.version).toBe(2);
    expect(data.evolved_profile!.parent_version).toBe(1); // lineage threaded
    expect(data.evolved_profile!.identity).toMatch(/verbose|rationale/i);
  });

  it("step 13 — agent_evolve PERMISSIONS-space change REQUIRES approval", async () => {
    const base = {
      slug: "scorer",
      version: 1,
      status: "active",
      parent_version: null,
      primitives: ["JUDGE"],
      input_types: ["phase18-summary"],
      output_types: ["phase18-summary"],
      domain: "phase18",
      identity: "v1",
      method: "score",
      constraints: [],
      depth_profile: "standard",
      permissions: {
        allowed_tools: [],
        disallowed_tools: [],
        model_tier: "standard",
        max_tool_calls: 5,
        max_token_budget: 1000,
        can_write_outputs: true,
        can_trigger_standards: false,
      },
    };
    const next = {
      ...base,
      version: 2,
      permissions: { ...base.permissions, allowed_tools: ["Bash"], can_trigger_standards: true },
    };
    const res = await dispatchTool("agent_evolve", { base, next, new_version: 2 }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { space: string; approval_required: boolean };
    expect(data.space).toBe("permissions");
    expect(data.approval_required).toBe(true);
  });

  it("step 14 — promotion lifecycle: agent_promote advances draft → review (forward-only state machine)", async () => {
    const okStep = await dispatchTool(
      "agent_promote",
      { slug: "freshly-defined-sensor", current: "draft", status: "review" },
      deps,
    );
    expect(okStep.ok, `forward promotion failed: ${okStep.error}`).toBe(true);
    const data = okStep.data as { promoted: boolean; status: string };
    expect(data.promoted).toBe(true);
    expect(data.status).toBe("review");
    // backward promotion must be REJECTED (immutability of state-machine direction)
    const badStep = await dispatchTool(
      "agent_promote",
      { slug: "freshly-defined-sensor", current: "active", status: "draft" },
      deps,
    );
    expect(badStep.ok).toBe(false);
    expect(String(badStep.error)).toMatch(/promot|backward|order/i);
  });

  it("step 15 — execution_history_read returns the gigs we ran (ledger query through MCP)", async () => {
    const res = await dispatchTool("execution_history_read", { standard_slug: "phase18-pipeline" }, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { executions: Array<{ gig_id: string; standard_slug: string }>; count: number };
    expect(data.count).toBeGreaterThanOrEqual(1);
    const phase18Runs = data.executions.filter((e) => e.standard_slug === "phase18-pipeline");
    expect(phase18Runs.length).toBeGreaterThanOrEqual(1);
    expect(phase18Runs.some((e) => e.gig_id === firstGigId)).toBe(true);
  });

  it("step 16 — system_audit surfaces the genome's real shape (no fake findings)", async () => {
    const res = await dispatchTool("system_audit", {}, deps);
    expect(res.ok).toBe(true);
    const data = res.data as { findings: Array<{ kind: string; slug: string }>; type_count: number; output_count: number };
    // type_count reflects what we registered (3+ — seed types + phase18 types)
    expect(data.type_count).toBeGreaterThanOrEqual(3);
    // output_count reflects the gig we ran
    expect(data.output_count).toBeGreaterThanOrEqual(2);
    // findings are typed (a SHAPE check, not a noop)
    for (const f of data.findings) {
      expect(typeof f.kind).toBe("string");
      expect(typeof f.slug).toBe("string");
    }
  });

  it("step 17 — composition gap: type_register reuse-guard rejects a duplicate-shape type (>=80 score)", async () => {
    // The §5 reuse enforcement: register a type identical-in-shape to phase18-note
    // — the registry should reject it (score >= 80) instead of silently shadowing.
    const res = await dispatchTool(
      "type_register",
      {
        slug: "phase18-note-clone",
        extends: "Signal",
        domain: "phase18",
        schema: { type: "object", properties: { text: { type: "string" } } },
        required_fields: ["text"],
      },
      deps,
    );
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/reuse|score|existing/i);
  });

  it("step 18 — boundary smoke: real MCP stdio transport boots + ListTools returns the surface", async () => {
    // Phase 18's USAGE claim demands one test that hits the real transport path —
    // not just dispatchTool. Spawn `_server_entry.mjs` over stdio, send the JSON-RPC
    // `initialize` + `tools/list`, and confirm the surface comes back.
    const child = spawn("npx", ["tsx", env.mcpServerEntry], {
      cwd: env.tempDir,
      env: { ...process.env, COLTRANE_GENOME: env.tempDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });

    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");

    // JSON-RPC init handshake
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "phase18-test", version: "0.0.0" } } });
    // give the server a beat to respond to init before listing tools
    await new Promise((r) => setTimeout(r, 1500));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    // wait up to 15s for the tools/list response
    const deadline = Date.now() + 15_000;
    let toolsRes: { tools: Array<{ name: string }> } | null = null;
    while (Date.now() < deadline && !toolsRes) {
      await new Promise((r) => setTimeout(r, 200));
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const evt = JSON.parse(t) as { id?: number; result?: { tools?: Array<{ name: string }> } };
          if (evt.id === 2 && evt.result?.tools) {
            toolsRes = { tools: evt.result.tools };
            break;
          }
        } catch { /* not json */ }
      }
    }

    child.kill("SIGTERM");
    // give the kill a moment
    await new Promise((r) => setTimeout(r, 200));

    expect(toolsRes, `tools/list never returned. stderr:\n${stderr.slice(0, 1000)}\n\nstdout:\n${stdout.slice(0, 1000)}`).not.toBeNull();
    expect(toolsRes!.tools.length).toBeGreaterThan(10); // ~28 tools per src_api_surface.md
    const names = toolsRes!.tools.map((t) => t.name);
    expect(names).toContain("agent_define");
    expect(names).toContain("standard_compose");
    expect(names).toContain("gig_dispatch");
    expect(names).toContain("type_register");
  }, 60_000);

  // Step 19 — cleanup is exercised in afterAll(); the assertion there closes the loop.
});
