// RED-first contract tests — restore the agent's BEHAVIORAL REPRESENTATION end to end.
//
// Audit finding (RUNTIME_BEHAVIORAL_AUDIT.json) + the deeper trace: an agent's identity,
// method, and constraints are not gone — they are CUT at three boundaries, so a real gig
// prompt is contentless scaffold and the model confabulates (and granted tools sit unused
// because the prompt never names them):
//
//   1. INGEST  — mcp.ts advertises identity/method/constraints on agent_define, but the
//                server handler reads only slug/primitives/io/domain/tools and discards
//                the rest before sealing. Rich input dies at the door.
//   2. LOAD    — even a genome agent file carrying identity/method/constraints loses them:
//                AgentDef + defineAgent don't carry the fields, so the in-memory Agent the
//                runtime holds never has them.
//   3. RENDER  — buildPrompt reads only {slug, domain, primitives, output_types[0]} and
//                emits no Method / Constraints / tool-catalog layer, and bare primitive
//                tokens with no descriptions.
//
// These tests pin all three. They fail honestly today (the data is discarded/unrendered),
// and go green only when the full conduit is wired: handler reads → genome persists →
// loader carries → buildPrompt renders.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { loadGenome } from "../src/loader.js";
import { buildPrompt, type AgentInvocationContext } from "../src";
import type { Agent } from "../src";

const IDENTITY = "You are fact-checker. You never accept a plausible-sounding claim without a retrieved source — you read like an explorer and challenge like a critic.";
const METHOD = "Take the claim, search for primary sources that confirm or refute it, and report a verdict with the supporting citations and quotes.";
const CONSTRAINTS = ["Never assert a fact you cannot cite.", "A source must be retrieved, not recalled from memory."];

// ── Boundary 1: INGEST — agent_define must capture identity/method/constraints ──────
describe("agent_define ingest captures behavioral fields (not discards them)", () => {
  function deps(dir: string): ServerDeps {
    const registry = createRegistry();
    return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger(), skills: new Map(), genome_dir: dir };
  }

  it("persists identity/method/constraints to the sealed genome file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-agentdef-"));
    const r = await dispatchTool(
      "agent_define",
      { slug: "fact-checker", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "verification", identity: IDENTITY, method: METHOD, constraints: CONSTRAINTS, behavioral_primitives: ["explorer", "critic"] },
      deps(dir),
    );
    expect(r.ok).toBe(true);

    const persisted = JSON.parse(readFileSync(join(dir, "agents", "fact-checker.json"), "utf8"));
    expect(persisted.identity, "identity was discarded at ingest").toBe(IDENTITY);
    expect(persisted.method, "method was discarded at ingest").toBe(METHOD);
    expect(persisted.constraints, "constraints were discarded at ingest").toEqual(CONSTRAINTS);
  });

  it("returns the defined agent carrying its behavioral fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-agentdef-"));
    const r = await dispatchTool(
      "agent_define",
      { slug: "fact-checker", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "verification", identity: IDENTITY, method: METHOD, constraints: CONSTRAINTS, behavioral_primitives: ["explorer", "critic"] },
      deps(dir),
    );
    const agent = (r.data as { agent: Agent }).agent;
    expect(agent.identity).toBe(IDENTITY);
    expect(agent.method).toBe(METHOD);
    expect(agent.constraints).toEqual(CONSTRAINTS);
  });
});

// ── Boundary 2: LOAD — a genome agent file's behavioral fields reach the in-memory Agent ─
describe("loadGenome carries behavioral fields onto the runtime Agent", () => {
  it("a genome agent declaring identity/method/constraints loads with them intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "coltrane-genome-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(
      join(dir, "agents", "fact-checker.json"),
      JSON.stringify({ slug: "fact-checker", primitives: ["INTERPRET"], input_types: [], output_types: ["Interpretation"], domain: "verification", identity: IDENTITY, method: METHOD, constraints: CONSTRAINTS, behavioral_primitives: ["explorer", "critic"] }),
    );
    const g = loadGenome(dir);
    const agent = g.agents.get("fact-checker");
    expect(agent, "agent failed to load").toBeTruthy();
    expect(agent!.identity).toBe(IDENTITY);
    expect(agent!.method).toBe(METHOD);
    expect(agent!.constraints).toEqual(CONSTRAINTS);
  });
});

// ── Boundary 3: RENDER — buildPrompt emits the behavioral layers + tool catalog ─────
describe("buildPrompt renders the behavioral representation", () => {
  const agent: Agent = {
    slug: "fact-checker",
    primitives: ["SENSE", "INTERPRET"],
    input_types: [],
    output_types: ["Interpretation"],
    domain: "verification",
    identity: IDENTITY,
    method: METHOD,
    constraints: CONSTRAINTS,
    behavioral_primitives: ["explorer", "critic"],
    allowed_tools: ["web_search", "fetch_url"],
  };
  const ctx = (over: Partial<AgentInvocationContext> = {}): AgentInvocationContext => ({
    agent, phase: "interpret", inputs: [], gig_input: { claim: "the new index halves p99 latency" }, ...over,
  });

  it("renders the Identity layer as the agent's prose, not just a slug line", () => {
    const p = buildPrompt(ctx());
    expect(p).toContain(IDENTITY);
  });

  it("renders the Method layer — the how, the step-by-step of this agent's job", () => {
    const p = buildPrompt(ctx());
    expect(p).toContain(METHOD);
    expect(p).toMatch(/#+\s*Method/i);
  });

  it("renders the Constraints layer — the never-invent negative space", () => {
    const p = buildPrompt(ctx());
    expect(p).toMatch(/#+\s*Constraints/i);
    for (const c of CONSTRAINTS) expect(p).toContain(c);
  });

  it("names every granted tool in the prompt with a call-them-directly instruction (fixes dead tools)", () => {
    const p = buildPrompt(ctx());
    expect(p).toContain("web_search");
    expect(p).toContain("fetch_url");
    expect(p).toMatch(/available tools|call them directly|you have the following tools/i);
  });

  // NOTE: the Disposition layer (Layer 1, the Belbin cognitive-role pairing) is pinned in
  // tests/prompt_full_parity.test.ts against the baseline fixtures, not here. This file
  // covers the identity/method/constraints/tool-catalog stack. (The transitional
  // "omits layers when an agent declares none" back-compat test was removed when the
  // behavioral fields became required — there is no longer a lean agent to omit for.)
});
