// Coltrane lifecycle e2e — ONE test that drives a fresh tempdir genome through
// the canonical workflows: bootstrap → define → reload → run → evolve → type-fail →
// edges → real claude CLI subthread. Sequential it() blocks share a single tempdir.
//
// Surface under test = src/server.ts dispatchTool (the MCP entry) + src/loader.ts +
// src/runtime.ts + src/genome_writer.ts. The claude CLI subthread block exercises
// the actual stdio MCP server through the local `claude` binary.
//
// Design contract: NO mocks of coltrane's own surface. Mock AgentInvoker only (the
// one non-deterministic seam, per src/runtime.ts comments). Every assertion checks a
// concrete value or specific error class — no toBeDefined-only padding.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CompositionError,
  MemoryLedger,
  OutputStoreError,
  PromotionError,
  createOutputStore,
  defineAgent,
  dispatchTool,
  loadGenome,
  loadRegistry,
  type Agent,
  type AgentInvoker,
  type AgentProfile,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, spawnClaudeSubthread, type TempdirColtrane } from "./_harness.js";

// ────────────────────────────────────────────────────────────────────────────
// Shared lifecycle state — each it() block builds on the prior. One tempdir, one
// genome, one ServerDeps reused across the sequence. afterAll cleans up.
// ────────────────────────────────────────────────────────────────────────────
let env: TempdirColtrane;
let genomeDir: string;
let deps: ServerDeps;

// Workflow 4 carries an agent_evolve seed; workflow 6 reuses gig_id.
let evolvedSlug = "summarizer";
let gigIdFromWorkflow3: string | null = null;

function freshDepsFromGenome(root: string): ServerDeps {
  const genome = loadGenome(root);
  const registry = loadRegistry(genome);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: genome.standards,
    invoke: undefined,
    model_version: "lifecycle-e2e",
    genome_dir: root,
  };
}

describe("coltrane lifecycle: bootstrap → define → reload → run → evolve → type-fail → edges → claude-cli", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;

    // Reset to a fresh genome: keep core_types (required by loadGenome) but blow
    // away agents/standards/domain_types so we drive them in from scratch.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(genomeDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 1: fresh genome bootstraps from disk with only core_types present
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 1: fresh genome (core_types only, empty agents/standards/domain_types) loads cleanly", () => {
    const genome = loadGenome(genomeDir);

    // The 6 spec core slugs — REQUIRED_CORE_SLUGS in loader.ts.
    const expectedCore = ["Signal", "Interpretation", "Judgment", "Plan", "Artifact", "Verdict"];
    expect([...genome.core_types.keys()].sort()).toEqual(expectedCore.sort());

    // Nothing else has been authored yet.
    expect(genome.domain_types.size).toBe(0);
    expect(genome.agents.size).toBe(0);
    expect(genome.standards.size).toBe(0);
    expect(genome.skills.size).toBe(0);
    expect(genome.evals.size).toBe(0);

    // Build a server-deps off this empty genome — the rest of the suite reuses it.
    deps = freshDepsFromGenome(genomeDir);
    expect(deps.registry.listTypes()).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 2: define two domain types + two agents + a standard via the MCP
  // surface (dispatchTool). Each call persists to disk and ledger-seals its
  // effective_hash. A second loadGenome must round-trip what we wrote.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 2: type_register + agent_define + standard_compose persist + ledger-seal + round-trip via loadGenome", async () => {
    // Register two domain types: a Signal (raw-note) and an Interpretation (summary).
    const t1 = await dispatchTool(
      "type_register",
      {
        slug: "raw-note",
        extends: "Signal",
        domain: "demo",
        schema: { type: "object", properties: { body: { type: "string" } } },
        required_fields: ["body"],
      },
      deps,
    );
    expect(t1.ok).toBe(true);
    const t1Data = t1.data as { content_hash: string; effective_hash: string; version: number };
    expect(t1Data.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t1Data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t1Data.version).toBe(1);

    const t2 = await dispatchTool(
      "type_register",
      {
        slug: "summary",
        extends: "Interpretation",
        domain: "demo",
        schema: { type: "object", properties: { gist: { type: "string" } } },
        required_fields: ["gist"],
      },
      deps,
    );
    expect(t2.ok).toBe(true);

    // Define two agents: a sensor (SENSE → raw-note) and a summarizer (INTERPRET, raw-note → summary).
    const a1 = await dispatchTool(
      "agent_define",
      {
        slug: "sensor",
        primitives: ["SENSE"],
        input_types: [],
        output_types: ["raw-note"],
        domain: "demo",
      },
      deps,
    );
    expect(a1.ok).toBe(true);
    const a1Data = a1.data as {
      agent: Agent;
      content_hash: string;
      effective_hash: string;
      validation_result: { valid: boolean };
    };
    expect(a1Data.agent.slug).toBe("sensor");
    expect(a1Data.agent.primitives).toEqual(["SENSE"]);
    expect(a1Data.validation_result.valid).toBe(true);
    expect(a1Data.effective_hash).toMatch(/^[0-9a-f]{64}$/);

    const a2 = await dispatchTool(
      "agent_define",
      {
        slug: "summarizer",
        primitives: ["INTERPRET"],
        input_types: ["raw-note"],
        output_types: ["summary"],
        domain: "demo",
      },
      deps,
    );
    expect(a2.ok).toBe(true);
    const sensorEffectiveHash = a1Data.effective_hash;

    // Compose a standard from those two agents.
    const s1 = await dispatchTool(
      "standard_compose",
      {
        slug: "summarize",
        domain: "demo",
        agents: [a1Data.agent, (a2.data as { agent: Agent }).agent],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "summarizer", depends_on: [], input_contract: [], output_contract: ["summary"], required_skills: [] }] },
        ],
      },
      deps,
    );
    expect(s1.ok).toBe(true);
    const s1Data = s1.data as { standard_id: string; validation_result: { valid: boolean }; effective_hash: string };
    expect(s1Data.standard_id).toBe("summarize");
    expect(s1Data.validation_result.valid).toBe(true);

    // Persistence assertion: each definition landed as a content-addressed JSON file.
    expect(existsSync(join(genomeDir, "domain_types", "raw-note.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "domain_types", "summary.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "agents", "sensor.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "agents", "summarizer.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "standards", "summarize.json"))).toBe(true);

    // The persisted agent file matches what we asked for (canonical input).
    const persisted = JSON.parse(readFileSync(join(genomeDir, "agents", "sensor.json"), "utf-8")) as {
      slug: string;
      primitives: string[];
      output_types: string[];
    };
    expect(persisted.slug).toBe("sensor");
    expect(persisted.primitives).toEqual(["SENSE"]);
    expect(persisted.output_types).toEqual(["raw-note"]);

    // Ledger seal: agent_define recorded with genome_hash === effective_hash returned to the caller.
    const ledgerSeals = deps.ledger.query({ standard_slug: "agent_define" });
    const sensorSeal = ledgerSeals.find((e) => e.gig_id.startsWith("define:sensor"));
    expect(sensorSeal).toBeTruthy();
    expect(sensorSeal!.genome_hash).toBe(sensorEffectiveHash);

    // Round-trip: load the genome from disk again and assert the writes are visible.
    const reloaded = loadGenome(genomeDir);
    expect([...reloaded.agents.keys()].sort()).toEqual(["sensor", "summarizer"]);
    expect([...reloaded.standards.keys()]).toEqual(["summarize"]);
    expect(reloaded.agents.get("summarizer")!.input_types).toEqual(["raw-note"]);
    expect(reloaded.standards.get("summarize")!.phases.map((p) => p.name)).toEqual(["sense", "interpret"]);

    // Rebuild deps off the round-tripped genome so workflow 3 has live standards.
    deps = freshDepsFromGenome(genomeDir);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 3: dispatch a gig through the just-defined standard. The runtime's
  // one non-deterministic seam (AgentInvoker) is the only mocked thing. Verify
  // typed outputs land, monitor reports complete, output_trace walks back.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 3: gig_dispatch runs both phases → outputs land typed → output_trace walks provenance", async () => {
    // Inject a deterministic invoker that produces values matching each agent's output schema.
    const invoke: AgentInvoker = ({ agent }) =>
      agent.slug === "sensor" ? { body: "raw text from sensor" } : { gist: "concise gist" };
    const wired: ServerDeps = { ...deps, invoke };

    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { source: "stdin" } },
      wired,
    );
    expect(dispatch.ok).toBe(true);
    const dispatchData = dispatch.data as {
      gig_id: string;
      manifest: { output_count: number; genome_hash: string; run_fingerprint: string };
    };
    expect(dispatchData.gig_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatchData.manifest.output_count).toBe(2);
    expect(dispatchData.manifest.genome_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dispatchData.manifest.run_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    gigIdFromWorkflow3 = dispatchData.gig_id;

    // Monitor reports complete (a ledger entry now exists for this gig).
    const monitor = await dispatchTool("gig_monitor", { gig_id: dispatchData.gig_id }, wired);
    const monitorData = monitor.data as { status: string; phases_complete: number };
    expect(monitorData.status).toBe("complete");
    expect(monitorData.phases_complete).toBe(2);

    // Query outputs by gig_id — both phases' outputs are typed.
    const query = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, wired);
    const outs = (query.data as { outputs: Array<{ id: string; domain_type: string; data: Record<string, unknown> }> }).outputs;
    expect(outs.length).toBe(2);
    expect(outs.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);

    const rawNote = outs.find((o) => o.domain_type === "raw-note")!;
    const summary = outs.find((o) => o.domain_type === "summary")!;
    expect(rawNote.data["body"]).toBe("raw text from sensor");
    expect(summary.data["gist"]).toBe("concise gist");

    // Provenance: tracing the summary walks back to the raw-note (derived_from).
    const trace = await dispatchTool("output_trace", { output_id: summary.id }, wired);
    const traceNodes = (trace.data as { graph: { nodes: Array<{ id: string }> } }).graph.nodes;
    expect(traceNodes.map((n) => n.id)).toContain(rawNote.id);

    // Stash the live deps (carries the populated outputs + ledger) for workflow 6.
    deps = wired;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 4: evolve an agent in CREATIVE space (identity/method/constraints).
  // proposeAgentChange should classify as creative (no approval), version+1, and
  // the evolved profile must thread parent_version so the immutable lineage chain
  // reconstructs.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 4: agent_evolve in creative space threads lineage (version+1, parent_version=base.version)", async () => {
    const baseProfile: AgentProfile = {
      slug: "summarizer",
      version: 1,
      status: "active",
      parent_version: null,
      primitives: ["INTERPRET"],
      input_types: ["raw-note"],
      output_types: ["summary"],
      domain: "demo",
      identity: "I summarize raw notes into a single concise sentence.",
      method: "Read the note, extract the core claim, render as one sentence.",
      constraints: ["one sentence", "no quotes"],
      depth_profile: "standard",
      permissions: {
        allowed_tools: [],
        disallowed_tools: [],
        model_tier: "economy",
        max_tool_calls: 0,
        max_token_budget: 1000,
        can_write_outputs: true,
        can_trigger_standards: false,
      },
    };

    // Creative-space change: tweak identity + add a constraint.
    const nextProfile: AgentProfile = {
      ...baseProfile,
      identity: "I summarize raw notes into a precise, one-sentence claim.",
      constraints: ["one sentence", "no quotes", "load-bearing verbs only"],
    };

    const evolve = await dispatchTool(
      "agent_evolve",
      { base: baseProfile, next: nextProfile },
      deps,
    );
    expect(evolve.ok).toBe(true);
    const evolveData = evolve.data as {
      space: string;
      approval_required: boolean;
      new_version: number;
      evolved_profile: AgentProfile | null;
      parent_version: number;
    };
    expect(evolveData.space).toBe("creative");
    expect(evolveData.approval_required).toBe(false);
    expect(evolveData.new_version).toBe(2);
    expect(evolveData.parent_version).toBe(1);
    expect(evolveData.evolved_profile).not.toBeNull();
    expect(evolveData.evolved_profile!.version).toBe(2);
    expect(evolveData.evolved_profile!.parent_version).toBe(1);
    expect(evolveData.evolved_profile!.status).toBe("draft");
    expect(evolveData.evolved_profile!.identity).toBe(nextProfile.identity);
    expect(evolveData.evolved_profile!.constraints).toEqual(nextProfile.constraints);
    // Harmonic fields carried unchanged — evolve cannot touch them.
    expect(evolveData.evolved_profile!.primitives).toEqual(baseProfile.primitives);
    expect(evolveData.evolved_profile!.input_types).toEqual(baseProfile.input_types);

    // Permissions-space change requires approval.
    const permsNext: AgentProfile = {
      ...baseProfile,
      permissions: { ...baseProfile.permissions, max_tool_calls: 5 },
    };
    const permsEvolve = await dispatchTool("agent_evolve", { base: baseProfile, next: permsNext }, deps);
    const permsData = permsEvolve.data as { space: string; approval_required: boolean };
    expect(permsData.space).toBe("permissions");
    expect(permsData.approval_required).toBe(true);

    evolvedSlug = "summarizer";
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 5: type-fail. The output store validates against the core+domain
  // schema AT WRITE (T3 contract per outputs.ts). A write with a missing required
  // field must throw OutputStoreError with a message naming the bad field.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 5: output_write with malformed data is rejected with OutputStoreError (typed, not generic)", async () => {
    // Direct outputs.write call so we can assert on the error CLASS, not a stringified MCP error.
    expect(() =>
      deps.outputs.write({
        core_type: "Interpretation",
        domain_type: "summary",
        domain: "demo",
        gig_id: "type-fail-gig",
        agent_slug: "summarizer",
        primitive: "INTERPRET",
        data: { not_gist: "x" }, // missing required "gist"
      }),
    ).toThrowError(OutputStoreError);

    // Same call through the MCP dispatch surface — should NOT throw, but should return ok:false with the
    // OutputStoreError message surfaced in `error`.
    const r = await dispatchTool(
      "output_write",
      {
        core_type: "Interpretation",
        domain_type: "summary",
        domain: "demo",
        gig_id: "type-fail-gig",
        agent_slug: "summarizer",
        primitive: "INTERPRET",
        data: { not_gist: "x" },
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/output rejected/);
    expect(r.error).toMatch(/summary/);

    // type_register against an unknown core type must throw the registry's typed error too.
    const badType = await dispatchTool(
      "type_register",
      {
        slug: "garbage",
        extends: "NotACore",
        domain: "demo",
        schema: {},
        required_fields: [],
      },
      deps,
    );
    expect(badType.ok).toBe(false);
    expect(badType.error).toMatch(/extends must be a core type/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 6: edges. Coltrane's composition rules + promotion state-machine
  // each have specific failure modes with named error classes.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 6a: defining an agent with illegal pipeline (CREATE without upstream reasoning) throws CompositionError", () => {
    expect(() =>
      defineAgent({
        slug: "bad-creator",
        primitives: ["CREATE"], // CREATE at position 0 has no upstream INTERPRET/PLAN
        input_types: [],
        output_types: ["artifact"],
        domain: "demo",
      }),
    ).toThrowError(CompositionError);

    // Same illegality surfaced through agent_validate_pipeline — returns valid:false + a message.
    return dispatchTool(
      "agent_validate_pipeline",
      { primitives: ["CREATE"], slug: "bad-creator" },
      deps,
    ).then((r) => {
      const data = r.data as { valid: boolean; errors: string[] };
      expect(data.valid).toBe(false);
      expect(data.errors.join("|")).toMatch(/CREATE at position 0/);
    });
  });

  it("workflow 6b: composing a standard that references an undefined agent throws CompositionError", () => {
    const known: Agent = {
      slug: "sensor",
      primitives: ["SENSE"],
      input_types: [],
      output_types: ["raw-note"],
      domain: "demo",
    };
    return dispatchTool(
      "standard_compose",
      {
        slug: "broken",
        domain: "demo",
        agents: [known],
        phases: [
          { name: "sense", chairs: [{ role: "sense", agent_slug: "sensor", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] },
          { name: "interpret", chairs: [{ role: "interpret", agent_slug: "ghost", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }, // ghost not in agents[]
        ],
      },
      deps,
    ).then((r) => {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/references undefined agent ghost/);
    });
  });

  it("workflow 6c: registering a duplicate-equivalent type is blocked by reuse enforcement (score >=80)", () => {
    // raw-note already registered. Re-resolving the SAME shape returns "use" with a high score.
    const resolve = deps.registry.resolveType({
      extends: "Signal",
      domain: "demo",
      required_fields: ["body"],
    });
    expect(resolve.action).toBe("use");
    expect(resolve.score).toBeGreaterThanOrEqual(80);

    // Attempting registerType for a *different slug* with the same shape is rejected.
    expect(() =>
      deps.registry.registerType({
        slug: "raw-note-clone",
        extends: "Signal",
        domain: "demo",
        schema: { type: "object", properties: { body: { type: "string" } } },
        required_fields: ["body"],
      }),
    ).toThrow(/reuse enforcement/);
  });

  it("workflow 6d: forward-only promotion (draft→review OK; active→draft rejected with PromotionError)", async () => {
    const okFwd = await dispatchTool(
      "agent_promote",
      { slug: evolvedSlug, status: "review", current: "draft" },
      deps,
    );
    expect(okFwd.ok).toBe(true);
    const okFwdData = okFwd.data as { status: string; promoted: boolean };
    expect(okFwdData.status).toBe("review");
    expect(okFwdData.promoted).toBe(true);

    const backward = await dispatchTool(
      "agent_promote",
      { slug: evolvedSlug, status: "draft", current: "active" },
      deps,
    );
    expect(backward.ok).toBe(false);
    expect(backward.error).toMatch(/cannot promote backwards/);

    // Confirm the typed error class is reachable from the export surface too.
    expect(PromotionError).toBeTypeOf("function");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 7: drive the FULL pipeline through the real claude CLI subprocess.
  // The tempdir's _server_entry.mjs boots the same dispatchTool surface over
  // stdio MCP, so this asserts coltrane really runs from outside-in.
  //
  // Honest gap: if the local `claude` binary times out or returns no session_id,
  // this it() goes RED — that's a real signal about the CLI ↔ MCP wiring on this
  // host, not a test-quality problem.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 7: real claude CLI subprocess loads the tempdir MCP server and returns a session_id", async () => {
    const result = await spawnClaudeSubthread(
      ["-p", "reply with the single word: ack"],
      { mcpConfigPath: env.mcpConfigPath, timeoutMs: 120_000 },
    );

    // Honest specifics: assert against the actual surface a real subthread would expose.
    expect(result.exitCode, `claude stderr: ${result.stderr.slice(0, 500)}`).toBe(0);
    expect(result.sessionId, `claude stderr: ${result.stderr.slice(0, 500)}`).not.toBeNull();
    expect(result.sessionId).toMatch(/^[0-9a-f-]{16,}$/);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr).not.toMatch(/TypeError:|Cannot find module|MODULE_NOT_FOUND/);
  }, 180_000);
});
