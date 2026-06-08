// Lighthouse G2 — "cheap and broke" L2 settlement gate.
//
// L2 in the finitude-budget spec: a settlement with verdict=PASS REQUIRES
// shipped_artifact_count >= 1. No PASS without evidence/artifact. The cheap-
// and-broke pole: a voice that claims success without producing anything must
// be REJECTED at the substrate boundary.
//
// In coltrane-oss the closest analogs of "claim success without artifact" are
// the three substrate-mutation handlers in src/server.ts:
//   - agent_define       — claim: I am an agent. cheap-and-broke: no primitives.
//   - standard_compose   — claim: I am a standard. cheap-and-broke: phase
//                          references an undefined agent (no backing artifact).
//   - output_write       — claim: I emitted an output. cheap-and-broke: data
//                          missing the domain_type's required fields.
//
// Each cheap-and-broke claim must round-trip as ok:false with an error message
// — never ok:true with a fabricated effective_hash. The positive controls
// (legitimate calls in the same handlers) must succeed with content_hash +
// effective_hash + validation_result.valid=true, demonstrating the gate
// REJECTS empty claims while ADMITTING real artifacts.
//
// Design contract: no mocks of coltrane's surface. Uses the same setupTempdirColtrane
// + dispatchTool pattern as tests/e2e/coltrane_lifecycle.spec.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  MemoryLedger,
  createOutputStore,
  dispatchTool,
  loadGenome,
  loadRegistry,
  type Agent,
  type ServerDeps,
} from "../../src/index.js";

import { setupTempdirColtrane, type TempdirColtrane } from "./_harness.js";

let env: TempdirColtrane;
let deps: ServerDeps;
let genomeDir: string;

function freshDepsFromGenome(root: string): ServerDeps {
  const genome = loadGenome(root);
  const registry = loadRegistry(genome);
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    standards: genome.standards,
    invoke: undefined,
    model_version: "lighthouse-g2-e2e",
    genome_dir: root,
  };
}

describe("lighthouse G2 / L2 cheap-and-broke — PASS requires shipped_artifact_count>=1", () => {
  beforeAll(async () => {
    env = await setupTempdirColtrane();
    genomeDir = env.tempDir;
    // Wipe authorable scopes; keep core_types so loadGenome's REQUIRED_CORE_SLUGS gate passes.
    for (const sub of ["agents", "standards", "domain_types", "skills", "evals"]) {
      const p = join(genomeDir, sub);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      mkdirSync(p, { recursive: true });
    }
    deps = freshDepsFromGenome(genomeDir);
  }, 600_000);

  afterAll(() => {
    env?.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // agent_define cheap-and-broke: a voice claiming "I am an agent" with NO
  // primitives produces no behavior — that's the artifact-less claim. The
  // composition rule rejects it (CompositionError) and dispatchTool surfaces
  // ok:false with the error message intact.
  // ──────────────────────────────────────────────────────────────────────────
  it("agent_define with empty primitives is REJECTED (no artifact = no PASS)", async () => {
    const r = await dispatchTool(
      "agent_define",
      {
        slug: "cheap-and-broke-agent",
        primitives: [], // ← the L2 violation: no actual prompt content / no behavior
        input_types: [],
        output_types: [],
        domain: "demo",
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no primitives/);
    // Honest non-fabrication: no content_hash, no effective_hash on a rejected call.
    expect(r.data).toBeUndefined();
    // The genome file must NOT exist — a rejected define cannot have produced bytes on disk.
    expect(existsSync(join(genomeDir, "agents", "cheap-and-broke-agent.json"))).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // agent_define positive control: a legitimate define produces a real artifact
  // (effective_hash, persisted file). This proves the gate ADMITS truthful claims.
  // ──────────────────────────────────────────────────────────────────────────
  it("agent_define positive control: legitimate claim produces effective_hash + persisted artifact", async () => {
    const r = await dispatchTool(
      "agent_define",
      {
        slug: "real-sensor",
        primitives: ["SENSE"],
        input_types: [],
        output_types: [],
        domain: "demo",
      },
      deps,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { effective_hash: string; validation_result: { valid: boolean } };
    expect(data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.validation_result.valid).toBe(true);
    expect(existsSync(join(genomeDir, "agents", "real-sensor.json"))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // standard_compose cheap-and-broke: a phase that references an undefined
  // agent claims composition with no backing artifact. composition.ts catches
  // this with CompositionError ("references undefined agent ..."); dispatchTool
  // surfaces ok:false. The standard file must NOT be persisted.
  // ──────────────────────────────────────────────────────────────────────────
  it("standard_compose with phase referencing undefined agent is REJECTED (no backing artifact)", async () => {
    const r = await dispatchTool(
      "standard_compose",
      {
        slug: "cheap-and-broke-standard",
        domain: "demo",
        agents: [], // ← no agents declared
        phases: [{ name: "ghost-phase", chairs: [{ role: "ghost-phase", agent_slug: "ghost-agent", depends_on: [], input_contract: [], output_contract: ["Interpretation"], required_skills: [] }] }], // ← refs an agent that doesn't exist
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/references undefined agent/);
    // validation_result on a failed compose surfaces valid:false; never silently valid.
    const data = (r.data as { validation_result?: { valid: boolean } } | undefined) ?? undefined;
    if (data?.validation_result !== undefined) {
      expect(data.validation_result.valid).toBe(false);
    }
    expect(existsSync(join(genomeDir, "standards", "cheap-and-broke-standard.json"))).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // standard_compose positive control: a legitimate compose (real agent, valid
  // phase) produces a real artifact.
  // ──────────────────────────────────────────────────────────────────────────
  it("standard_compose positive control: legitimate claim produces effective_hash + persisted artifact", async () => {
    const realAgent: Agent = {
      slug: "real-sensor",
      primitives: ["SENSE"],
      input_types: [],
      output_types: [],
      domain: "demo",
    };
    const r = await dispatchTool(
      "standard_compose",
      {
        slug: "real-standard",
        domain: "demo",
        agents: [realAgent],
        phases: [{ name: "sense", chairs: [{ role: "sense", agent_slug: "real-sensor", depends_on: [], input_contract: [], output_contract: ["Signal"], required_skills: [] }] }],
      },
      deps,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { effective_hash: string; validation_result: { valid: boolean } };
    expect(data.effective_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.validation_result.valid).toBe(true);
    expect(existsSync(join(genomeDir, "standards", "real-standard.json"))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // output_write cheap-and-broke: a write that claims an output but supplies
  // empty data (or data missing the domain_type's required fields) is the
  // canonical "PASS without artifact" violation. registry.validate() catches
  // the missing required field; outputs.write throws OutputStoreError; the
  // server's try/catch surfaces ok:false with "output rejected" in the error.
  // ──────────────────────────────────────────────────────────────────────────
  it("output_write with empty data against a domain_type requiring fields is REJECTED", async () => {
    // First register a domain_type that REQUIRES a field — so empty data has a
    // concrete schema obligation to violate.
    const reg = await dispatchTool(
      "type_register",
      {
        slug: "note-with-body",
        extends: "Signal",
        domain: "demo",
        schema: { type: "object", properties: { body: { type: "string" } } },
        required_fields: ["body"],
      },
      deps,
    );
    expect(reg.ok).toBe(true);

    // Now the cheap-and-broke write: empty data, claiming a Signal output.
    const r = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        domain_type: "note-with-body",
        domain: "demo",
        gig_id: "cheap-and-broke-gig",
        agent_slug: "ghost-writer",
        primitive: "SENSE",
        data: {}, // ← the L2 violation: empty data, no artifact payload
      },
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/output rejected/);
    expect(r.error).toMatch(/note-with-body/);
    // No fabricated output_id on rejected write.
    expect(r.data).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // output_write positive control: a write with proper data succeeds and
  // produces a real output_id.
  // ──────────────────────────────────────────────────────────────────────────
  it("output_write positive control: legitimate write produces output_id + artifact in store", async () => {
    const r = await dispatchTool(
      "output_write",
      {
        core_type: "Signal",
        domain_type: "note-with-body",
        domain: "demo",
        gig_id: "real-gig",
        agent_slug: "real-sensor",
        primitive: "SENSE",
        data: { body: "real sensed text" },
      },
      deps,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { output_id: string; output: { data: Record<string, unknown> } };
    expect(data.output_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.output.data["body"]).toBe("real sensed text");
    // Artifact is now retrievable from the store — the PASS is backed by a real row.
    expect(deps.outputs.all().some((o) => o.id === data.output_id)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // L2 invariant: across all rejected calls in this suite, no genome file was
  // written + no output row was stored. This is the "cheap-and-broke is
  // contained" assertion — the substrate boundary holds.
  // ──────────────────────────────────────────────────────────────────────────
  it("L2 invariant: no cheap-and-broke claim leaked an artifact past the boundary", () => {
    expect(existsSync(join(genomeDir, "agents", "cheap-and-broke-agent.json"))).toBe(false);
    expect(existsSync(join(genomeDir, "standards", "cheap-and-broke-standard.json"))).toBe(false);
    // The only outputs in the store are the positive-control rows (gig_id=real-gig).
    const cheapRows = deps.outputs.all().filter((o) => o.gig_id === "cheap-and-broke-gig");
    expect(cheapRows.length).toBe(0);
  });
});
