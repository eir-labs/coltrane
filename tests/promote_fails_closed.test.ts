// #254 — the WRITE path must fail closed, so a malformed definition is hard to create and
// impossible to make active.
//
// The maintainer's ruling: "A single malformed agent should never be able to be in the genome
// in the first place" — and, on the lifecycle tools specifically: "I would expect that that MCP
// call has some very, very clear checks on validity. It shouldn't even allow for the resolution
// or the promotion of a thing unless it passes checks."
//
// The load path already fails closed (src/loader.ts: a malformed or incomplete agent hard-fails
// the whole load) and stays that way — see tests/failure_modes/malformed_genome.spec.ts and
// tests/genome_cases.test.ts. The two halves are complementary, and hand-edited JSON is the
// reason both are needed: CLAUDE.md deliberately permits raw edits when the MCP tools misbehave,
// which bypasses the write path entirely.
//
// The gap this file closes: `*_promote` checked ONLY that the status transition was
// forward-legal. It never resolved the slug and never looked at the definition — `targetSlug`
// was used solely as a ledger subject. So a slug that names NOTHING promoted to `active`
// happily, which is the same dangling-reference shape as the rest of this branch: a reference
// that resolves to nothing degrading into a plausible-looking success.
//
// Promotion is the transition that grants a definition production status. If it can promote
// what could not be created, the write-path gate is a fiction — anything already sitting at
// `draft` walks straight past it.

import { describe, it, expect } from "vitest";
import { dispatchTool, type ServerDeps } from "../src/server.js";
import { createRegistry } from "../src/registry.js";
import { createOutputStore } from "../src/outputs.js";
import { MemoryLedger } from "../src/ledger.js";
import { composeStandard, type Agent, type PhaseDef, type Standard } from "../src/composition.js";
import type { SkillRecord } from "../src/loader.js";
import { testAgent } from "./_support/agents.js";

const scout = testAgent({ slug: "scout", primitives: ["SENSE"], input_types: [], output_types: ["raw-note"] });

const summarize = (): Standard =>
  composeStandard({
    slug: "summarize", domain: "demo", agents: [scout],
    phases: [{ name: "p0", chairs: [{ role: "sense", agent_slug: "scout", depends_on: [], input_contract: [], output_contract: ["raw-note"], required_skills: [] }] }] as PhaseDef[],
  });

const goodSkill = { slug: "citation-verify", version: 1, permission: { tier: 0 } } as unknown as SkillRecord;

/** ServerDeps WITH the live genome maps — what bootstrapServerDeps always builds. */
function genomeDeps(over?: Partial<ServerDeps>): ServerDeps {
  const registry = createRegistry();
  return {
    registry,
    outputs: createOutputStore(registry),
    ledger: new MemoryLedger(),
    agents: new Map([["scout", scout]]),
    standards: new Map([["summarize", summarize()]]),
    skills: new Map([["citation-verify", goodSkill]]),
    ...over,
  };
}

/** ServerDeps with NO genome maps — a bare server that was never bootstrapped. */
function bareDeps(): ServerDeps {
  const registry = createRegistry();
  return { registry, outputs: createOutputStore(registry), ledger: new MemoryLedger() };
}

describe("#254 — *_promote must not promote a slug that resolves to nothing", () => {
  it.each([
    ["agent_promote", "active", "agent"],
    ["standard_promote", "active", "standard"],
    ["skill_promote", "testing", "skill"],
  ])("%s refuses an unresolvable slug", async (tool, status, kind) => {
    const deps = genomeDeps();
    const before = deps.ledger.query({}).length;
    const r = await dispatchTool(tool, { slug: "does-not-exist-anywhere", status }, deps);

    expect(r.ok, `${tool} promoted a ${kind} that does not exist`).toBe(false);
    // Name what is wrong, not a generic failure.
    expect(r.error).toMatch(/does-not-exist-anywhere/);
    expect(r.error).toMatch(new RegExp(kind, "i"));
    // A refused promotion must leave no lifecycle row claiming it happened.
    expect(deps.ledger.query({}).length, "a refused promotion must not append a ledger event").toBe(before);
  });

  it.each([
    ["agent_promote", "active"],
    ["standard_promote", "active"],
    ["skill_promote", "testing"],
  ])("%s still promotes a definition that DOES resolve", async (tool, status) => {
    const deps = genomeDeps();
    const slug = tool === "agent_promote" ? "scout" : tool === "standard_promote" ? "summarize" : "citation-verify";
    const before = deps.ledger.query({}).length;
    const r = await dispatchTool(tool, { slug, status }, deps);
    expect(r.ok, `${tool} refused a valid definition: ${r.error}`).toBe(true);
    expect((r.data as { promoted: boolean }).promoted).toBe(true);
    expect(deps.ledger.query({}).length).toBe(before + 1);
  });

  it("the status-transition check still runs FIRST — an illegal transition is still refused", async () => {
    const r = await dispatchTool("agent_promote", { slug: "scout", status: "draft", current: "active" }, genomeDeps());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/promote backwards/);
  });

  it("back-compat: with NO genome maps, resolution is not configured and the transition check stands alone", async () => {
    // A bare server (deps.agents/standards/skills absent) was never bootstrapped from a genome,
    // so absence of the map is not evidence that the slug names nothing. Same discipline the
    // runtime applies to an absent skills map: don't manufacture a dangling reference.
    const r = await dispatchTool("agent_promote", { slug: "scout", status: "active" }, bareDeps());
    expect(r.ok).toBe(true);
  });
});

describe("#254 — *_promote must run the SAME validity check the loader runs", () => {
  it("agent_promote refuses an agent that would fail the loader's own gate", async () => {
    // The drift the maintainer is guarding against: a promote that validates DIFFERENTLY from
    // the loader. This agent sits in the live map (a write-path tool can mutate it in-session)
    // but has an empty identity — exactly what loadGenome hard-fails on. If promote only flips
    // a status field, it grants production status to something the loader will refuse to load.
    const hollow = { ...scout, slug: "hollow", identity: "" } as unknown as Agent;
    const deps = genomeDeps({ agents: new Map([["hollow", hollow]]) });
    const r = await dispatchTool("agent_promote", { slug: "hollow", status: "active" }, deps);

    expect(r.ok, "an agent the loader would reject must not become active").toBe(false);
    expect(r.error).toMatch(/hollow/);
    expect(r.error, "the failure must name what is wrong").toMatch(/identity/i);
  });

  it("skill_promote refuses a skill package that would fail the loader's schema", async () => {
    const badSkill = { slug: "broken", version: "not-a-number", permission: { tier: 0 } } as unknown as SkillRecord;
    const deps = genomeDeps({ skills: new Map([["broken", badSkill]]) });
    const r = await dispatchTool("skill_promote", { slug: "broken", status: "testing" }, deps);

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/broken/);
    expect(r.error, "the failure must name the offending field").toMatch(/version/i);
  });
});

describe("#254 — the create path already validates before it persists (regression pins)", () => {
  // Audited: agent_define → sealAgentDefinition → defineAgent() BEFORE the seal and the write;
  // standard_compose → composeStandard() before both; skill_define → SkillSchema + the loader's
  // own completeness rules (>=1 fixture, a code and/or reasoning half) before both; type_register
  // → registry.registerType() (which enforces the core-type `extends` the loader also checks).
  // These pin that ordering so a future refactor can't reintroduce write-then-validate.
  it("agent_define refuses an incomplete agent and persists nothing", async () => {
    const deps = genomeDeps();
    const before = deps.ledger.query({}).length;
    const r = await dispatchTool("agent_define", { slug: "no-identity", primitives: ["SENSE"] }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/identity/i);
    expect(deps.ledger.query({}).length, "nothing may be sealed for a definition that failed validation").toBe(before);
  });

  it("standard_compose refuses a standard referencing an unknown agent", async () => {
    const deps = genomeDeps();
    const r = await dispatchTool("standard_compose", {
      slug: "bad-std", domain: "demo", agents: ["ghost-agent"],
      phases: [{ name: "p0", chairs: [{ role: "r", agent_slug: "ghost-agent", output_contract: ["raw-note"] }] }],
    }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost-agent/);
  });

  it("skill_define refuses a package the loader would hard-fail (no fixtures)", async () => {
    const deps = genomeDeps();
    const r = await dispatchTool("skill_define", { slug: "fixtureless", md: "reasoning" }, deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/fixture/i);
  });
});
