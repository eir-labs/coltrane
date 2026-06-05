// T14 — genome hot-reload mid-gig. Spec claim: `agent_define` mid-gig, the NEXT
// gig must see the newly defined agent without restarting the server.
//
// Surface under test: src/server.ts dispatchTool (agent_define, standard_compose,
// gig_dispatch) + src/loader.ts (the disk → in-memory bridge) + src/runtime.ts.
//
// Design contract: no mocks of coltrane's own surface. Mock AgentInvoker only. The
// honest split this test makes:
//   (1) baseline gig through a pre-defined standard succeeds
//   (2) define a new agent + a new standard MID-GIG via dispatchTool — those calls
//       persist files to disk (we assert that with existsSync)
//   (3) THE T14 ASSERTION: dispatch through the new standard via the SAME deps —
//       does the server pick up the new standard without a `loadGenome` re-call?
//   (4) honest comparison: re-rebuild deps from disk and assert the new standard +
//       agent now resolve; the second gig runs and produces typed outputs.
//
// If (3) goes RED and (4) goes GREEN, T14 is a real bug: define persists to disk
// but the in-memory standards Map on the running server is frozen at boot. That's
// the diagnosis Eugene asked for — captured, not papered over.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  createOutputStore,
  dispatchTool,
  loadGenome,
  loadRegistry,
  type Agent,
  type AgentInvoker,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

let env: TempdirColtrane;
let genomeDir: string;
let deps: ServerDeps;

// Carry agent objects between blocks so workflow 2/3 can compose standards off them.
let sensorAgent: Agent;
let baselineSummarizer: Agent;
let hotAgent: Agent | null = null;

function freshDepsFromGenome(root: string): ServerDeps {
  const genome = loadGenome(root);
  const registry = loadRegistry(genome);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: genome.standards,
    invoke: undefined,
    model_version: "t14-hot-reload",
    genome_dir: root,
  };
}

// Deterministic invoker — output shape matches each agent's declared output schema.
const invoke: AgentInvoker = ({ agent }) => {
  if (agent.slug === "sensor") return { body: "raw text from sensor" };
  if (agent.slug === "baseline-summarizer") return { gist: "baseline gist" };
  if (agent.slug === "hot-summarizer") return { gist: "hot-reloaded gist" };
  throw new Error(`unexpected agent in T14 test: ${agent.slug}`);
};

describe("T14: genome hot-reload — agent_define mid-gig, next gig sees the new agent", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;

    // Fresh substrate: keep core_types, blow away everything we'll author.
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
  // workflow 1: author the baseline genome through the MCP surface — two domain
  // types, two agents, one standard. Dispatch a gig to prove the baseline runs.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 1: baseline genome (sensor + baseline-summarizer + baseline-standard) runs a gig", async () => {
    deps = freshDepsFromGenome(genomeDir);

    // Register the two domain types the baseline needs.
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

    // Define the two baseline agents.
    const a1 = await dispatchTool(
      "agent_define",
      { slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo" },
      deps,
    );
    expect(a1.ok).toBe(true);
    sensorAgent = (a1.data as { agent: Agent }).agent;

    const a2 = await dispatchTool(
      "agent_define",
      { slug: "baseline-summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" },
      deps,
    );
    expect(a2.ok).toBe(true);
    baselineSummarizer = (a2.data as { agent: Agent }).agent;

    // Compose the baseline standard.
    const s1 = await dispatchTool(
      "standard_compose",
      {
        slug: "baseline-standard",
        domain: "demo",
        agents: [sensorAgent, baselineSummarizer],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "interpret", agent: "baseline-summarizer" },
        ],
      },
      deps,
    );
    expect(s1.ok).toBe(true);

    // Rebuild deps off the disk-persisted genome so the standards Map sees baseline-standard.
    deps = { ...freshDepsFromGenome(genomeDir), invoke };

    // Dispatch gig 1 — proves the baseline standard runs end-to-end.
    const gig1 = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "baseline-standard", input: { source: "stdin" } },
      deps,
    );
    expect(gig1.ok).toBe(true);
    const gig1Data = gig1.data as { gig_id: string; manifest: { output_count: number } };
    expect(gig1Data.gig_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(gig1Data.manifest.output_count).toBe(2);

    // Both outputs should be there and typed.
    const q1 = await dispatchTool("output_query", { gig_id: gig1Data.gig_id }, deps);
    const outs1 = (q1.data as { outputs: Array<{ domain_type: string }> }).outputs;
    expect(outs1.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 2: mid-gig, define a NEW agent (hot-summarizer) and compose a new
  // standard (hot-standard) that uses it. dispatchTool writes them to disk.
  // No restart, no fresh deps — same running server.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 2: agent_define + standard_compose mid-gig persist to disk (no restart needed for files)", async () => {
    // Confirm baseline files exist on disk before we add the hot ones.
    expect(existsSync(join(genomeDir, "agents", "sensor.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "agents", "baseline-summarizer.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "standards", "baseline-standard.json"))).toBe(true);

    // Hot-define a new agent that consumes raw-note → summary, distinct slug.
    const a3 = await dispatchTool(
      "agent_define",
      { slug: "hot-summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo" },
      deps,
    );
    expect(a3.ok).toBe(true);
    const a3Data = a3.data as { agent: Agent; effective_hash: string };
    expect(a3Data.agent.slug).toBe("hot-summarizer");
    expect(a3Data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    hotAgent = a3Data.agent;

    // Compose a new standard that wires sensor → hot-summarizer.
    const s2 = await dispatchTool(
      "standard_compose",
      {
        slug: "hot-standard",
        domain: "demo",
        agents: [sensorAgent, hotAgent],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "interpret", agent: "hot-summarizer" },
        ],
      },
      deps,
    );
    expect(s2.ok).toBe(true);

    // Both new definitions landed on disk — the genome substrate is updated.
    expect(existsSync(join(genomeDir, "agents", "hot-summarizer.json"))).toBe(true);
    expect(existsSync(join(genomeDir, "standards", "hot-standard.json"))).toBe(true);

    // Ledger seal recorded — the substrate-of-truth identity claim is in place.
    const defineSeals = deps.ledger.query({ standard_slug: "agent_define" });
    const hotSeal = defineSeals.find((e) => e.gig_id.startsWith("define:hot-summarizer"));
    expect(hotSeal).toBeTruthy();
    expect(hotSeal!.genome_hash).toBe(a3Data.effective_hash);

    // The persisted agent file round-trips through loadGenome (substrate is consistent).
    const reloadedGenome = loadGenome(genomeDir);
    expect(reloadedGenome.agents.has("hot-summarizer")).toBe(true);
    expect(reloadedGenome.standards.has("hot-standard")).toBe(true);
    expect(reloadedGenome.standards.get("hot-standard")!.phases.map((p) => p.agent)).toEqual([
      "sensor",
      "hot-summarizer",
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 3 — THE T14 CLAIM: the running server's NEXT gig must see the
  // newly defined agent + standard without a restart. This is the hot-reload
  // contract. If the in-memory standards Map on deps is frozen at boot, this
  // RED-flags the gap honestly.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 3: NEXT gig through the SAME deps must see the hot-defined standard (the T14 claim)", async () => {
    // Same `deps` object as workflow 2 — no freshDepsFromGenome between define and dispatch.
    const gig2 = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "hot-standard", input: { source: "stdin" } },
      deps,
    );

    // T14 contract: hot-defined standard resolves and the gig completes.
    expect(gig2.ok, `T14 GAP: standards Map frozen at server boot — agent_define mid-gig writes to disk but does not update deps.standards. error: ${gig2.error}`).toBe(true);

    const gig2Data = gig2.data as { gig_id: string; manifest: { output_count: number } };
    expect(gig2Data.gig_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(gig2Data.manifest.output_count).toBe(2);

    // Outputs are typed AND match what hot-summarizer produces (distinct gist string
    // from baseline-summarizer — proves the right agent was invoked, not the old one).
    const q2 = await dispatchTool("output_query", { gig_id: gig2Data.gig_id }, deps);
    const outs2 = (q2.data as { outputs: Array<{ domain_type: string; data: Record<string, unknown>; agent_slug: string }> }).outputs;
    expect(outs2.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);
    const hotSummary = outs2.find((o) => o.agent_slug === "hot-summarizer");
    expect(hotSummary).toBeTruthy();
    expect(hotSummary!.data["gist"]).toBe("hot-reloaded gist");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // workflow 4: the honest comparison — rebuild deps from disk (the explicit
  // reload path) and confirm the new standard + agent ARE visible. If
  // workflow 3 was RED, this GREEN path documents the actual escape hatch:
  // a caller must call `loadGenome` + rebuild ServerDeps to pick up new defs.
  // ──────────────────────────────────────────────────────────────────────────
  it("workflow 4: explicit reload via freshDepsFromGenome surfaces hot-defined agent + standard (the bypass)", async () => {
    const reloadedDeps: ServerDeps = { ...freshDepsFromGenome(genomeDir), invoke };

    // Both definitions present after disk-reload.
    expect(reloadedDeps.standards!.has("hot-standard")).toBe(true);
    expect(reloadedDeps.registry.listTypes().map((t) => t.slug).sort()).toContain("summary");

    // Dispatch through the reloaded deps — this MUST succeed (the disk substrate is sound).
    const gig3 = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "hot-standard", input: { source: "stdin" } },
      reloadedDeps,
    );
    expect(gig3.ok, `reloaded deps must resolve hot-standard. error: ${gig3.error}`).toBe(true);
    const gig3Data = gig3.data as { gig_id: string; manifest: { output_count: number } };
    expect(gig3Data.manifest.output_count).toBe(2);

    const q3 = await dispatchTool("output_query", { gig_id: gig3Data.gig_id }, reloadedDeps);
    const outs3 = (q3.data as { outputs: Array<{ data: Record<string, unknown>; agent_slug: string }> }).outputs;
    const hotSummary3 = outs3.find((o) => o.agent_slug === "hot-summarizer");
    expect(hotSummary3).toBeTruthy();
    expect(hotSummary3!.data["gist"]).toBe("hot-reloaded gist");

    // Persisted file matches what we authored (canonical input round-trips).
    const persisted = JSON.parse(
      readFileSync(join(genomeDir, "agents", "hot-summarizer.json"), "utf-8"),
    ) as { slug: string; primitives: string[]; input_types: string[]; output_types: string[] };
    expect(persisted.slug).toBe("hot-summarizer");
    expect(persisted.primitives).toEqual(["INTERPRET"]);
    expect(persisted.input_types).toEqual(["raw-note"]);
    expect(persisted.output_types).toEqual(["summary"]);
  });
});
