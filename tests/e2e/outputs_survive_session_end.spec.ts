// bug-bash finding: outputs vanish when the MCP session ends.
//
// Cajal flagged this as the #1 load-bearing untested gap:
//   "createOutputStore returns `new Map<>()`; when MCP session ends, outputs vanish.
//    user can't retrieve gig outputs after closing claude code."
//
// This test asserts the user-expected behavior: after dispatching a gig and
// closing the deps (simulating MCP session end), a FRESH set of deps pointing
// at the SAME genome_dir should still find the gig's outputs via output_query.
//
// Currently RED: outputs live in `new Map<>` inside createOutputStore, no disk
// backing. The RED proves the gap. When outputs grow a disk-backed mode (jsonl
// per gig, or sqlite, or chain-keeper sealed), this test flips GREEN.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  createOutputStore,
  dispatchTool,
  loadGenome,
  loadRegistry,
  type Agent,
  type AgentInvocationContext,
  type AgentInvoker,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

// Deterministic in-process invoker — keeps the test fast + isolates the
// persistence question (which is what we're actually probing) from the
// real-claude spawn surface (already proven elsewhere tonight).
const detInvoke: AgentInvoker = ({ agent }: AgentInvocationContext) =>
  agent.slug === "sensor"
    ? { body: "raw text the sensor produced" }
    : { gist: "concise gist the summarizer produced" };

describe("outputs survive session end — bug-bash: user-expected persistence across deps recreation", () => {
  let env: TempdirColtrane;

  beforeAll(async () => {
    env = await setupTempdirColtrane();
    // Wipe to a clean 2-phase genome.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(env.tempDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
    // Seed the 2-phase standard directly on disk.
    writeFileSync(
      join(env.tempDir, "domain_types", "raw-note.json"),
      JSON.stringify({
        slug: "raw-note", version: 1, extends: "Signal", domain: "demo", status: "active",
        schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
        required_fields: ["body"],
      }),
    );
    writeFileSync(
      join(env.tempDir, "domain_types", "summary.json"),
      JSON.stringify({
        slug: "summary", version: 1, extends: "Interpretation", domain: "demo", status: "active",
        schema: { type: "object", properties: { gist: { type: "string" } }, required: ["gist"] },
        required_fields: ["gist"],
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "sensor.json"),
      JSON.stringify({
        slug: "sensor", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"], domain: "demo",
      }),
    );
    writeFileSync(
      join(env.tempDir, "agents", "summarizer.json"),
      JSON.stringify({
        slug: "summarizer", primitives: ["INTERPRET"], input_types: ["raw-note"], output_types: ["summary"], domain: "demo",
      }),
    );
    writeFileSync(
      join(env.tempDir, "standards", "summarize.json"),
      JSON.stringify({
        slug: "summarize", domain: "demo", agent_slugs: ["sensor", "summarizer"],
        phases: [
          { name: "sense", agent: "sensor" },
          { name: "interpret", agent: "summarizer" },
        ],
      }),
    );
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  function freshDeps(): ServerDeps {
    const genome = loadGenome(env.tempDir);
    const registry = loadRegistry(genome);
    return {
      registry,
      outputs: createOutputStore(registry),
      ledger: new MemoryLedger(),
      standards: genome.standards,
      invoke: detInvoke,
      model_version: "outputs-persistence-probe",
      genome_dir: env.tempDir,
    };
  }

  it("RED-expected: outputs from a completed gig are retrievable after the deps that ran it are discarded", async () => {
    // ── SESSION A: dispatch a gig, capture gig_id, observe outputs are there.
    const depsA = freshDeps();
    const dispatch = await dispatchTool(
      "gig_dispatch",
      { standard_slug: "summarize", input: { source: "morning fog" } },
      depsA,
    );
    expect(dispatch.ok, `gig_dispatch failed: ${dispatch.error}`).toBe(true);
    const dispatchData = dispatch.data as { gig_id: string; manifest: { output_count: number } };
    expect(dispatchData.gig_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(dispatchData.manifest.output_count).toBe(2);

    // Sanity: same-session output_query returns both outputs.
    const queryA = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, depsA);
    expect(queryA.ok).toBe(true);
    const outsA = (queryA.data as { outputs: Array<{ domain_type: string }> }).outputs;
    expect(outsA.length).toBe(2);
    expect(outsA.map((o) => o.domain_type).sort()).toEqual(["raw-note", "summary"]);

    // ── SESSION A ENDS — discard depsA. Simulates MCP server shutdown.
    // (No close() to call; the in-memory Map is just garbage-collected when
    // depsA goes out of scope. That's exactly the bug: nothing on disk.)

    // ── SESSION B: fresh deps from the SAME genome dir. User opens a new
    // Claude Code session and asks for the same gig_id.
    const depsB = freshDeps();
    const queryB = await dispatchTool("output_query", { gig_id: dispatchData.gig_id }, depsB);
    expect(queryB.ok, `output_query in session B failed: ${queryB.error}`).toBe(true);
    const outsB = (queryB.data as { outputs: Array<{ domain_type: string }> }).outputs;

    // The user-expected assertion: outputs survive across sessions.
    // Currently RED because createOutputStore is `new Map<>()` — no disk backing.
    // When outputs grow disk persistence (jsonl per gig, sqlite, or chain-keeper
    // sealed), this assertion flips GREEN automatically.
    expect(
      outsB.length,
      `session-B output_query returned ${outsB.length} outputs for gig ${dispatchData.gig_id}. ` +
        `user-expected: 2 (raw-note + summary). gap: outputs live in an in-memory Map that ` +
        `doesn't survive deps recreation. fix path: disk-backed output store.`,
    ).toBe(2);
  }, 120_000);
});
